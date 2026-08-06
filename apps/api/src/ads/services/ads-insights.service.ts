import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { resultCount, type MetaActionRow } from '../marketing-insights.util';
import { AdsConfigService } from './ads-config.service';

/**
 * Reads the local insights mirror. Never calls Meta.
 *
 * Every figure is a SUM over `meta_ads_insights` daily rows, which is
 * what makes an arbitrary date range cheap and consistent: the same
 * stored rows answer "today", "last 7 days" and a custom window, and a
 * range that straddles a sync boundary cannot double-count.
 *
 * ⚠️ MONEY IS MINOR UNITS ON THE WAY OUT TOO.
 *   Nothing here divides by 100. The web app formats at the point of
 *   display using the ad account's currency (`formatMinor`). A service
 *   that returned "rupees" would leave two representations of the same
 *   number in the codebase, which is how one of them ends up wrong.
 *
 * BigInt → number at the boundary
 *   The columns are BIGINT (money in minor units, impression counts), and
 *   `JSON.stringify` throws on a BigInt. Converting here rather than in
 *   the controller keeps the trap in one place. Safe: the largest value
 *   this can hold is an account's lifetime spend in paise, ~9 orders of
 *   magnitude below Number.MAX_SAFE_INTEGER.
 */

export interface AdsDateRange {
  /** `YYYY-MM-DD`, inclusive. */
  since: string;
  until: string;
}

export interface AdsTotals {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  /** Objective-appropriate result count, summed across ad types. */
  results: number;
  ctr: number | null;
  /** Minor units, derived from the totals rather than averaged. */
  cpc: number | null;
  cpm: number | null;
  costPerResult: number | null;
}

export interface AdsTimeseriesPoint {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
}

export interface AdsCampaignRow {
  id: string;
  metaCampaignId: string;
  name: string;
  adType: string;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  /** Minor units. Campaign budget if set, else the sum of its ad sets'. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  adCount: number;
  totals: AdsTotals;
}

export interface AdsOverview {
  currency: string | null;
  range: AdsDateRange;
  totals: AdsTotals;
  timeseries: AdsTimeseriesPoint[];
  campaigns: AdsCampaignRow[];
  /** Last time the sync ran for this workspace, if ever. */
  lastSyncedAt: string | null;
}

@Injectable()
export class AdsInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  /**
   * Everything the Overview page renders, in one round trip.
   *
   * One method rather than four endpoints because the four pieces share
   * the same range and the same rows — splitting them would mean reading
   * `meta_ads_insights` four times to render one screen.
   */
  async getOverview(
    accountId: string,
    range: AdsDateRange,
  ): Promise<AdsOverview> {
    const connection = await this.config.findConnection(accountId);

    const since = new Date(`${range.since}T00:00:00.000Z`);
    const until = new Date(`${range.until}T00:00:00.000Z`);

    const campaigns = await this.prisma.meta_ads_campaigns.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      include: {
        meta_ads_adsets: {
          select: {
            daily_budget: true,
            lifetime_budget: true,
            _count: { select: { meta_ads_ads: true } },
          },
        },
      },
    });

    // Campaign-level rows answer both the per-campaign table and the
    // account totals. Deliberately NOT the 'account' level rows: those
    // are only present if an account-level sync ran, and summing the
    // campaign rows we already have is both cheaper and self-consistent
    // with the table beneath the KPIs.
    const rows = await this.prisma.meta_ads_insights.findMany({
      where: {
        account_id: accountId,
        level: 'campaign',
        date_start: { gte: since, lte: until },
      },
      select: {
        object_id: true,
        date_start: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        actions: true,
      },
    });

    const adTypeByMetaId = new Map(
      campaigns.map((c) => [c.meta_campaign_id, c.ad_type]),
    );

    // Group once, in memory. The alternative — a groupBy per campaign
    // plus one for the series — is N+1 queries for a screen whose whole
    // dataset is a few thousand small rows.
    const perCampaign = new Map<string, Accumulator>();
    const perDay = new Map<string, Accumulator>();
    const overall = newAccumulator();

    for (const row of rows) {
      const adType = adTypeByMetaId.get(row.object_id) ?? 'website';
      const results = resultCount(
        row.actions as MetaActionRow[] | null,
        adType,
      );

      const day = row.date_start.toISOString().slice(0, 10);
      accumulate(overall, row, results);
      accumulate(getOrCreate(perCampaign, row.object_id), row, results);
      accumulate(getOrCreate(perDay, day), row, results);
    }

    const timeseries = [...perDay.entries()]
      .map(([date, acc]) => ({
        date,
        spend: acc.spend,
        impressions: acc.impressions,
        clicks: acc.clicks,
        results: acc.results,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      currency: connection?.currency ?? null,
      range,
      totals: finalise(overall),
      timeseries,
      campaigns: campaigns.map((campaign) => {
        const acc =
          perCampaign.get(campaign.meta_campaign_id) ?? newAccumulator();

        // A campaign-level budget wins when set; otherwise the ad sets
        // carry it (which is what our own wizard produces), so sum them.
        const adsetDaily = sumBigInts(
          campaign.meta_ads_adsets.map((a) => a.daily_budget),
        );
        const adsetLifetime = sumBigInts(
          campaign.meta_ads_adsets.map((a) => a.lifetime_budget),
        );

        return {
          id: campaign.id,
          metaCampaignId: campaign.meta_campaign_id,
          name: campaign.name,
          adType: campaign.ad_type,
          objective: campaign.objective,
          status: campaign.status,
          effectiveStatus: campaign.effective_status,
          dailyBudget: toNumber(campaign.daily_budget) ?? adsetDaily,
          lifetimeBudget: toNumber(campaign.lifetime_budget) ?? adsetLifetime,
          startTime: campaign.start_time?.toISOString() ?? null,
          stopTime: campaign.stop_time?.toISOString() ?? null,
          adCount: campaign.meta_ads_adsets.reduce(
            (sum, a) => sum + a._count.meta_ads_ads,
            0,
          ),
          totals: finalise(acc),
        };
      }),
      lastSyncedAt:
        campaigns
          .map((c) => c.synced_at)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null,
    };
  }

  /**
   * Ad spend → contacts → deals.
   *
   * THE REASON THIS FEATURE LIVES IN A CRM RATHER THAN LINKING TO META.
   *   Meta's own Ads Manager reports spend and conversations. It cannot
   *   report which of those conversations became a deal worth ₹40,000,
   *   because it has never seen this pipeline. This method is that join,
   *   and it is only possible because the mirror (`meta_ads_insights`)
   *   sits in the same database as `contacts`, `deals` and `ctwa_clicks`.
   *
   * TWO SOURCES, ONE LIST
   *   Click-to-WhatsApp arrives through `ctwa_clicks` (a click row, later
   *   linked to a contact and conversation). Lead-form submissions arrive
   *   through the Facebook leads webhook, which sets
   *   `contacts.source = 'facebook_lead'` and creates the deal itself.
   *   Neither knows about the other, so they are unioned here rather than
   *   in SQL.
   */
  async getLeads(
    accountId: string,
    range: AdsDateRange,
  ): Promise<{
    currency: string | null;
    totals: {
      spend: number;
      leads: number;
      deals: number;
      /** Minor units, of `deals.value` — the pipeline value ads produced. */
      dealValue: number;
      costPerLead: number | null;
    };
    leads: Array<{
      contactId: string;
      name: string | null;
      phone: string | null;
      source: string;
      createdAt: string;
      campaignName: string | null;
      dealCount: number;
      dealValue: number;
      conversationId: string | null;
    }>;
  }> {
    const connection = await this.config.findConnection(accountId);

    const since = new Date(`${range.since}T00:00:00.000Z`);
    const until = new Date(`${range.until}T23:59:59.999Z`);

    // Contacts this workspace acquired from ads in the window. `source` is
    // the discriminator the creation paths already set — see
    // common/contacts/contact-source.ts.
    const contacts = await this.prisma.contacts.findMany({
      where: {
        account_id: accountId,
        source: { in: ['facebook_lead', 'whatsapp'] },
        created_at: { gte: since, lte: until },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        source: true,
        created_at: true,
        deals: { select: { id: true, value: true } },
        conversations: { select: { id: true }, take: 1 },
        ctwa_clicks: {
          select: { ctwa_campaigns: { select: { name: true } } },
          take: 1,
        },
      },
      orderBy: { created_at: 'desc' },
      take: 500,
    });

    // A `whatsapp`-sourced contact is only an ad lead if a CTWA click
    // points at it. Without this filter every inbound WhatsApp message
    // would be counted as an ad result, which would flatter the numbers
    // enormously.
    const adLeads = contacts.filter(
      (contact) =>
        contact.source === 'facebook_lead' || contact.ctwa_clicks.length > 0,
    );

    const spendRows = await this.prisma.meta_ads_insights.aggregate({
      where: {
        account_id: accountId,
        level: 'campaign',
        date_start: { gte: since, lte: until },
      },
      _sum: { spend: true },
    });

    const spend = Number(spendRows._sum.spend ?? 0);
    let dealCount = 0;
    let dealValue = 0;

    const leads = adLeads.map((contact) => {
      const contactDealValue = contact.deals.reduce(
        // `deals.value` is DECIMAL major units (it predates this feature's
        // minor-unit convention), so it is converted here rather than
        // silently mixed with `spend`.
        (sum, deal) => sum + Math.round(Number(deal.value ?? 0) * 100),
        0,
      );
      dealCount += contact.deals.length;
      dealValue += contactDealValue;

      return {
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        source: contact.source,
        createdAt: (contact.created_at ?? new Date()).toISOString(),
        campaignName: contact.ctwa_clicks[0]?.ctwa_campaigns?.name ?? null,
        dealCount: contact.deals.length,
        dealValue: contactDealValue,
        conversationId: contact.conversations[0]?.id ?? null,
      };
    });

    return {
      currency: connection?.currency ?? null,
      totals: {
        spend,
        leads: leads.length,
        deals: dealCount,
        dealValue,
        costPerLead: leads.length ? Math.round(spend / leads.length) : null,
      },
      leads,
    };
  }

  /**
   * Per-ad breakdown for one campaign.
   *
   * Separate from the overview because it is a drill-down: loading every
   * ad's daily rows for every campaign up front would be most of the
   * table for none of the screen.
   */
  async getCampaignAds(
    accountId: string,
    campaignId: string,
    range: AdsDateRange,
  ): Promise<{
    currency: string | null;
    ads: Array<{
      id: string;
      metaAdId: string;
      name: string;
      status: string | null;
      effectiveStatus: string | null;
      adsetName: string;
      previewUrl: string | null;
      totals: AdsTotals;
    }>;
  }> {
    const connection = await this.config.findConnection(accountId);

    // Scoped by BOTH the campaign and the account. The account_id is not
    // redundant: Prisma bypasses RLS, so without it a campaign uuid from
    // another tenant would return that tenant's ads.
    const campaign = await this.prisma.meta_ads_campaigns.findFirst({
      where: { id: campaignId, account_id: accountId },
      select: { id: true, ad_type: true },
    });

    if (!campaign) return { currency: connection?.currency ?? null, ads: [] };

    const ads = await this.prisma.meta_ads_ads.findMany({
      where: {
        account_id: accountId,
        meta_ads_adsets: { campaign_id: campaign.id },
      },
      include: { meta_ads_adsets: { select: { name: true } } },
      orderBy: { created_at: 'desc' },
    });

    const since = new Date(`${range.since}T00:00:00.000Z`);
    const until = new Date(`${range.until}T00:00:00.000Z`);

    const rows = await this.prisma.meta_ads_insights.findMany({
      where: {
        account_id: accountId,
        level: 'ad',
        object_id: { in: ads.map((a) => a.meta_ad_id) },
        date_start: { gte: since, lte: until },
      },
      select: {
        object_id: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        actions: true,
      },
    });

    const perAd = new Map<string, Accumulator>();
    for (const row of rows) {
      const results = resultCount(
        row.actions as MetaActionRow[] | null,
        campaign.ad_type,
      );
      accumulate(getOrCreate(perAd, row.object_id), row, results);
    }

    return {
      currency: connection?.currency ?? null,
      ads: ads.map((ad) => ({
        id: ad.id,
        metaAdId: ad.meta_ad_id,
        name: ad.name,
        status: ad.status,
        effectiveStatus: ad.effective_status,
        adsetName: ad.meta_ads_adsets.name,
        previewUrl: ad.preview_url,
        totals: finalise(perAd.get(ad.meta_ad_id) ?? newAccumulator()),
      })),
    };
  }
}

// ============================================================
// Accumulation
//
// `reach` is summed like the rest, and that is WRONG in the strict
// sense — reach is a count of unique people, so daily reach cannot be
// added across days without double-counting anyone seen twice. Meta only
// reports de-duplicated reach for a range you ask it for, which we
// cannot do from stored daily rows.
//
// It is summed anyway because the alternatives are worse: showing
// nothing, or making a live Graph call per range change. The web app
// labels it "reach (sum of daily)" so the number is not passed off as
// something it isn't.
// ============================================================

interface Accumulator {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number;
}

function newAccumulator(): Accumulator {
  return { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0 };
}

function getOrCreate(map: Map<string, Accumulator>, key: string): Accumulator {
  const existing = map.get(key);
  if (existing) return existing;
  const created = newAccumulator();
  map.set(key, created);
  return created;
}

function accumulate(
  acc: Accumulator,
  row: {
    spend: bigint;
    impressions: bigint;
    reach: bigint;
    clicks: bigint;
  },
  results: number,
): void {
  acc.spend += Number(row.spend);
  acc.impressions += Number(row.impressions);
  acc.reach += Number(row.reach);
  acc.clicks += Number(row.clicks);
  acc.results += results;
}

/**
 * Derive the ratios from the totals, never from an average of the daily
 * ratios.
 *
 * Averaging per-day CTR gives every day equal weight regardless of how
 * many impressions it had, so one quiet day with a fluke click can
 * dominate a month. Meta computes these the same way we do here.
 */
function finalise(acc: Accumulator): AdsTotals {
  return {
    spend: acc.spend,
    impressions: acc.impressions,
    reach: acc.reach,
    clicks: acc.clicks,
    results: acc.results,
    ctr: acc.impressions ? (acc.clicks / acc.impressions) * 100 : null,
    cpc: acc.clicks ? Math.round(acc.spend / acc.clicks) : null,
    cpm: acc.impressions
      ? Math.round((acc.spend / acc.impressions) * 1000)
      : null,
    costPerResult: acc.results ? Math.round(acc.spend / acc.results) : null,
  };
}

function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/** Sum of the non-null values, or null when there are none. */
function sumBigInts(values: Array<bigint | null>): number | null {
  const present = values.filter((v): v is bigint => v !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + Number(v), 0);
}
