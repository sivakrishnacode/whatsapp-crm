import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { adsSandbox } from '../ads.config';
import {
  getAdSets,
  getAds,
  getCampaigns,
  type MetaAdSet,
  type MetaCampaign,
} from '../marketing-objects.util';
import {
  getInsights,
  runAsyncInsightsReport,
  type InsightsLevel,
  type MetaInsightRow,
} from '../marketing-insights.util';
import {
  SANDBOX_CAMPAIGNS,
  SANDBOX_ADSETS,
  SANDBOX_ADS,
  sandboxInsightRows,
} from '../sandbox/fixtures';
import { toJson, toJsonObject } from '../utils/prisma-json.util';
import { AdsConfigService } from './ads-config.service';

/**
 * How many trailing days of insights the nightly sync re-fetches.
 *
 * Not 1. Meta restates attributed conversions for up to ~28 days, so a
 * row written once is wrong later — asking only for yesterday would
 * freeze conversions at their first, lowest reported value and quietly
 * under-report every campaign's results forever.
 *
 * 7 is the compromise: it catches the bulk of restatement (most lands
 * within a few days) at 7× the row count rather than 28×. A full
 * 28-day re-fetch belongs in a weekly job if it ever proves necessary.
 */
const INSIGHTS_LOOKBACK_DAYS = 7;

/** Levels we mirror. `account` is derived by summing, not fetched. */
const SYNCED_LEVELS: InsightsLevel[] = ['campaign', 'adset', 'ad'];

/**
 * How far back a first-time connect pulls.
 *
 * Without this, a workspace that connects an ad account with months of
 * history sees an empty Overview until the nightly sync runs, and even then
 * only the last 7 days — so the numbers would look like the ads had just
 * started. 90 days is enough to be recognisable without asking Meta for
 * years of daily rows.
 */
const BACKFILL_DAYS = 90;

export interface SyncResult {
  campaigns: number;
  adsets: number;
  ads: number;
  insightRows: number;
  /** Set when a page cap was hit — the mirror is incomplete. */
  truncated: boolean;
  /** Insight rows Meta returned that could not be keyed. */
  skipped: number;
  warnings: string[];
}

/**
 * Pulls Meta's ad objects and daily performance into our local mirror.
 *
 * WHY MIRROR AT ALL
 *   Three reasons, in order of how load-bearing they are:
 *     1. `ad_type`. Meta has no field for "this is a Click-to-WhatsApp
 *        ad" — the type is a combination of objective, destination_type,
 *        promoted_object and creative CTA. Without our own column the
 *        Overview list cannot label anything.
 *     2. Joins. "spend → conversations → deals" needs insights next to
 *        `ctwa_clicks` and `deals` in one query.
 *     3. Rate limits. Marketing API budgets are per ad account and
 *        shared with every other caller in the workspace; a dashboard
 *        that hit Graph per page load would throttle the sync too.
 *
 * META STAYS AUTHORITATIVE
 *   `effective_status` is overwritten on every sync, so an ad paused in
 *   Meta's own Ads Manager stops reading as active here. We never write
 *   our idea of status back — that only happens from an explicit user
 *   action.
 */
@Injectable()
export class AdsSyncService {
  private readonly logger = new Logger(AdsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  /**
   * Full sync for one workspace: objects then insights.
   *
   * Objects first, deliberately. Insight rows are keyed by Meta object
   * id with no foreign key (see migration 068), so the order does not
   * break anything — but syncing objects first means a brand-new
   * campaign's spend has something to display against on the very first
   * run instead of the run after.
   */
  async syncAccount(accountId: string): Promise<SyncResult> {
    const result: SyncResult = {
      campaigns: 0,
      adsets: 0,
      ads: 0,
      insightRows: 0,
      truncated: false,
      skipped: 0,
      warnings: [],
    };

    const connection = await this.config.findConnection(accountId);
    if (!connection?.adAccountId) {
      result.warnings.push('No ad account connected — nothing to sync.');
      return result;
    }

    const objects = await this.syncObjects(accountId);
    Object.assign(result, objects);

    const insights = await this.syncInsights(accountId);
    result.insightRows = insights.insightRows;
    result.skipped += insights.skipped;
    result.truncated = result.truncated || insights.truncated;
    result.warnings.push(...insights.warnings);

    return result;
  }

  // ------------------------------------------------------------
  // Objects
  // ------------------------------------------------------------

  async syncObjects(accountId: string): Promise<{
    campaigns: number;
    adsets: number;
    ads: number;
    truncated: boolean;
    warnings: string[];
  }> {
    const connection = await this.config.requireAdAccount(accountId);
    const warnings: string[] = [];

    const [campaignPage, adsetPage, adPage] = adsSandbox()
      ? [
          { items: SANDBOX_CAMPAIGNS, truncated: false },
          { items: SANDBOX_ADSETS, truncated: false },
          { items: SANDBOX_ADS, truncated: false },
        ]
      : await Promise.all([
          getCampaigns({
            accessToken: connection.accessToken,
            adAccountId: connection.adAccountId,
          }),
          getAdSets({
            accessToken: connection.accessToken,
            adAccountId: connection.adAccountId,
          }),
          getAds({
            accessToken: connection.accessToken,
            adAccountId: connection.adAccountId,
          }),
        ]);

    const truncated =
      campaignPage.truncated || adsetPage.truncated || adPage.truncated;
    if (truncated) {
      // Never silent. A partially-synced mirror that looks complete is
      // how a customer concludes their spend is lower than it is.
      const warning =
        'Meta returned more objects than one sync could page through; the list may be incomplete.';
      warnings.push(warning);
      this.logger.warn(`${warning} (account ${accountId})`);
    }

    // Campaigns ------------------------------------------------
    for (const campaign of campaignPage.items) {
      await this.upsertCampaign(accountId, campaign);
    }

    // Ad sets — need their campaign's local uuid, so build the map once
    // rather than querying per row.
    const campaignIdMap = await this.localIdMap(
      'meta_ads_campaigns',
      accountId,
    );

    for (const adset of adsetPage.items) {
      const localCampaignId = adset.campaignId
        ? campaignIdMap.get(adset.campaignId)
        : undefined;

      // An ad set whose campaign we have not mirrored (created between
      // the two Graph calls, or beyond the page cap) is skipped rather
      // than orphaned — the next sync picks it up once the campaign
      // exists. The alternative, a nullable campaign_id, would make
      // every join in the read path defensive.
      if (!localCampaignId) continue;

      await this.upsertAdSet(accountId, localCampaignId, adset);
    }

    const adsetIdMap = await this.localIdMap('meta_ads_adsets', accountId);

    for (const ad of adPage.items) {
      const localAdsetId = ad.adsetId ? adsetIdMap.get(ad.adsetId) : undefined;
      if (!localAdsetId) continue;

      await this.prisma.meta_ads_ads.upsert({
        where: { meta_ad_id: ad.id },
        create: {
          account_id: accountId,
          adset_id: localAdsetId,
          meta_ad_id: ad.id,
          meta_creative_id: ad.creativeId,
          name: ad.name,
          creative: toJsonObject(ad.creative),
          status: ad.status,
          effective_status: ad.effectiveStatus,
          preview_url: ad.thumbnailUrl,
          synced_at: new Date(),
        },
        update: {
          adset_id: localAdsetId,
          meta_creative_id: ad.creativeId,
          name: ad.name,
          creative: toJsonObject(ad.creative),
          status: ad.status,
          effective_status: ad.effectiveStatus,
          preview_url: ad.thumbnailUrl,
          synced_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    return {
      campaigns: campaignPage.items.length,
      adsets: adsetPage.items.length,
      ads: adPage.items.length,
      truncated,
      warnings,
    };
  }

  /**
   * Upsert a campaign.
   *
   * `ad_type` is only written on CREATE. It is our own column, inferred
   * from the objective for anything created outside our wizard, and a
   * campaign published through the wizard already has the accurate value
   * — re-inferring on update would overwrite "click_to_whatsapp" with
   * the coarser guess "website" every night.
   */
  private async upsertCampaign(
    accountId: string,
    campaign: MetaCampaign,
  ): Promise<void> {
    const shared = {
      name: campaign.name,
      objective: campaign.objective ?? 'UNKNOWN',
      status: campaign.status,
      effective_status: campaign.effectiveStatus,
      buying_type: campaign.buyingType,
      daily_budget: campaign.dailyBudget,
      lifetime_budget: campaign.lifetimeBudget,
      special_ad_categories: campaign.specialAdCategories,
      start_time: campaign.startTime,
      stop_time: campaign.stopTime,
      synced_at: new Date(),
    };

    await this.prisma.meta_ads_campaigns.upsert({
      where: { meta_campaign_id: campaign.id },
      create: {
        account_id: accountId,
        meta_campaign_id: campaign.id,
        ad_type: inferAdType(campaign.objective),
        ...shared,
      },
      update: { ...shared, updated_at: new Date() },
    });
  }

  private async upsertAdSet(
    accountId: string,
    localCampaignId: string,
    adset: MetaAdSet,
  ): Promise<void> {
    const shared = {
      campaign_id: localCampaignId,
      name: adset.name,
      optimization_goal: adset.optimizationGoal,
      billing_event: adset.billingEvent,
      bid_strategy: adset.bidStrategy,
      bid_amount: adset.bidAmount,
      daily_budget: adset.dailyBudget,
      lifetime_budget: adset.lifetimeBudget,
      destination_type: adset.destinationType,
      targeting: toJsonObject(adset.targeting),
      promoted_object: toJson(adset.promotedObject),
      adset_schedule: toJson(adset.adsetSchedule),
      status: adset.status,
      effective_status: adset.effectiveStatus,
      synced_at: new Date(),
    };

    await this.prisma.meta_ads_adsets.upsert({
      where: { meta_adset_id: adset.id },
      create: {
        account_id: accountId,
        meta_adset_id: adset.id,
        ...shared,
      },
      update: { ...shared, updated_at: new Date() },
    });
  }

  /** meta id → our uuid, for one account's rows of one table. */
  private async localIdMap(
    table: 'meta_ads_campaigns' | 'meta_ads_adsets',
    accountId: string,
  ): Promise<Map<string, string>> {
    if (table === 'meta_ads_campaigns') {
      const rows = await this.prisma.meta_ads_campaigns.findMany({
        where: { account_id: accountId },
        select: { id: true, meta_campaign_id: true },
      });
      return new Map(rows.map((r) => [r.meta_campaign_id, r.id]));
    }

    const rows = await this.prisma.meta_ads_adsets.findMany({
      where: { account_id: accountId },
      select: { id: true, meta_adset_id: true },
    });
    return new Map(rows.map((r) => [r.meta_adset_id, r.id]));
  }

  // ------------------------------------------------------------
  // Insights
  // ------------------------------------------------------------

  /**
   * Upsert one daily row on the composite grain from migration 068.
   *
   * Shared by the nightly sync and the backfill. That shared key is what
   * makes both idempotent: re-fetching a day Meta has since restated is an
   * update, not a duplicate.
   */
  private async upsertInsightRow(
    accountId: string,
    row: MetaInsightRow,
    currency: string | null,
  ): Promise<void> {
    const shared = {
      spend: row.spend,
      impressions: row.impressions,
      reach: row.reach,
      clicks: row.clicks,
      ctr: row.ctr,
      cpc: row.cpc,
      cpm: row.cpm,
      frequency: row.frequency,
      actions: toJson(row.actions),
      action_values: toJson(row.actionValues),
      currency,
    };

    await this.prisma.meta_ads_insights.upsert({
      where: {
        account_id_level_object_id_date_start: {
          account_id: accountId,
          level: row.level,
          object_id: row.objectId,
          date_start: new Date(row.dateStart),
        },
      },
      create: {
        account_id: accountId,
        level: row.level,
        object_id: row.objectId,
        date_start: new Date(row.dateStart),
        ...shared,
      },
      update: { ...shared, synced_at: new Date() },
    });
  }

  async syncInsights(
    accountId: string,
    options: { lookbackDays?: number } = {},
  ): Promise<{
    insightRows: number;
    truncated: boolean;
    skipped: number;
    warnings: string[];
  }> {
    const connection = await this.config.requireAdAccount(accountId);
    const lookbackDays = options.lookbackDays ?? INSIGHTS_LOOKBACK_DAYS;
    const warnings: string[] = [];

    const until = new Date();
    const since = new Date(until);
    since.setUTCDate(since.getUTCDate() - (lookbackDays - 1));

    let rowCount = 0;
    let truncated = false;
    let skipped = 0;

    for (const level of SYNCED_LEVELS) {
      const page = adsSandbox()
        ? {
            rows: sandboxInsightRows(level, lookbackDays),
            truncated: false,
            skipped: 0,
          }
        : await getInsights({
            accessToken: connection.accessToken,
            adAccountId: connection.adAccountId,
            level,
            since: isoDate(since),
            until: isoDate(until),
          });

      truncated = truncated || page.truncated;
      skipped += page.skipped;

      for (const row of page.rows) {
        await this.upsertInsightRow(accountId, row, connection.currency);
        rowCount++;
      }
    }

    if (truncated) {
      warnings.push(
        'Meta returned more performance rows than one sync could page through; recent numbers may be incomplete.',
      );
    }
    if (skipped > 0) {
      // Explicitly surfaced rather than logged and forgotten: these are
      // rows with spend in them that we could not store.
      warnings.push(
        `${skipped} performance row(s) from Meta could not be matched to an object and were not stored.`,
      );
      this.logger.warn(
        `${skipped} unkeyable insight rows for account ${accountId}`,
      );
    }

    return { insightRows: rowCount, truncated, skipped, warnings };
  }

  /**
   * Pull a long history once, when an ad account is first selected.
   *
   * Uses the ASYNC report path (`runAsyncInsightsReport`) — which is what
   * that code exists for. 90 days of daily rows at ad level is well beyond
   * what a synchronous `/insights` call returns before timing out, while
   * the nightly sync stays synchronous because a rolling 7-day window is
   * always small.
   *
   * Without this, a workspace connecting an ad account with months of
   * history sees an empty Overview until the first nightly sync, and then
   * only the last 7 days — making established campaigns look like they had
   * just started.
   *
   * Idempotent: every row upserts on the same composite grain as the
   * nightly sync, so running it twice changes nothing.
   */
  async backfillInsights(
    accountId: string,
    options: { days?: number } = {},
  ): Promise<{ insightRows: number; warnings: string[] }> {
    const connection = await this.config.requireAdAccount(accountId);
    const days = options.days ?? BACKFILL_DAYS;
    const warnings: string[] = [];

    const until = new Date();
    const since = new Date(until);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    let rowCount = 0;

    for (const level of SYNCED_LEVELS) {
      let rows: MetaInsightRow[];
      try {
        rows = adsSandbox()
          ? sandboxInsightRows(level, days)
          : (
              await runAsyncInsightsReport({
                accessToken: connection.accessToken,
                adAccountId: connection.adAccountId,
                level,
                since: isoDate(since),
                until: isoDate(until),
              })
            ).rows;
      } catch (err) {
        // A backfill is a nice-to-have: the account is connected and the
        // nightly sync populates recent data regardless. Failing the connect
        // flow over missing history would be the wrong trade, so each level
        // is allowed to fail on its own.
        const message =
          err instanceof Error
            ? err.message
            : 'Meta could not build the report.';
        warnings.push(`Could not load ${level} history: ${message}`);
        this.logger.warn(
          `Backfill (${level}) failed for account ${accountId}: ${message}`,
        );
        continue;
      }

      for (const row of rows) {
        await this.upsertInsightRow(accountId, row, connection.currency);
        rowCount++;
      }
    }

    this.logger.log(
      `Backfilled ${rowCount} insight rows for account ${accountId} (${days} days)`,
    );

    return { insightRows: rowCount, warnings };
  }
}

/** `YYYY-MM-DD` in UTC. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Best guess at our `ad_type` for a campaign we did not create.
 *
 * Deliberately coarse. The five wizard types are distinguished by ad-set
 * and creative details this function cannot see (destination_type,
 * promoted_object, the creative's call_to_action), so anything created
 * in Meta's own Ads Manager gets the closest objective-level match. It
 * is only ever used on INSERT, so a wizard-published campaign keeps its
 * accurate value.
 */
export function inferAdType(objective: string | null): string {
  switch (objective) {
    case 'OUTCOME_LEADS':
      return 'lead_form';
    case 'OUTCOME_ENGAGEMENT':
    case 'OUTCOME_SALES':
      // The overwhelmingly common reason a workspace here runs one of
      // these is a Click-to-WhatsApp ad.
      return 'click_to_whatsapp';
    case 'OUTCOME_AWARENESS':
      return 'whatsapp_status';
    default:
      return 'website';
  }
}
