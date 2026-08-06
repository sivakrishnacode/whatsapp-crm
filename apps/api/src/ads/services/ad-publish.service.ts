import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { adsMaxDailyBudgetMinor, adsSandbox } from '../ads.config';
import {
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  deleteObject,
  generatePreviews,
  updateObjectStatus,
} from '../marketing-objects.util';
import { SANDBOX_PREFIX } from '../sandbox/fixtures';
import { toJson, toJsonObject } from '../utils/prisma-json.util';
import { AD_TYPES } from './ad-types';
import type {
  AdBuildContext,
  AdBuildInput,
  AdTypeId,
  BuiltAd,
} from './ad-types';
import { AdsConfigService, type AdsConnection } from './ads-config.service';

/**
 * Pull the `src` out of Meta's `<iframe …>` preview snippet.
 *
 * A regex rather than an HTML parser: the response is one attribute on one
 * known tag, and adding a parser dependency to read it would be the larger
 * risk. Meta HTML-escapes the ampersands in the URL, so those are undone —
 * without that the URL loads a Facebook error page rather than the preview.
 */
function extractIframeSrc(snippet: string | undefined): string | null {
  if (!snippet) return null;
  const match = /src="([^"]+)"/.exec(snippet);
  if (!match) return null;
  const url = match[1].replace(/&amp;/g, '&');
  // Only ever a Facebook URL. Opening whatever came back in a new tab
  // without checking would make a compromised or unexpected response an
  // open-redirect.
  try {
    const parsed = new URL(url);
    if (!/(^|\.)facebook\.com$/.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** What was created, in creation order. The rollback walks this backwards. */
interface CreatedObjects {
  campaignId?: string;
  adSetId?: string;
  creativeId?: string;
  adId?: string;
}

export interface PublishResult {
  campaignId: string;
  adSetId: string;
  adId: string;
  /** Our local campaign uuid, for linking straight to the Overview row. */
  localCampaignId: string;
  /** True when the objects were left paused because activation failed. */
  leftPaused: boolean;
  warnings: string[];
}

/**
 * Creates a live ad from validated wizard input.
 *
 * ⚠️ THE ORDERING HERE IS THE MOST SAFETY-CRITICAL CODE IN THIS FEATURE.
 *
 *   Publishing is five non-atomic Graph calls against a system that has
 *   no transactions and no idempotency key. Naively ordered — create
 *   everything ACTIVE as you go — a failure at the ad-creative step
 *   leaves a LIVE ad set with a budget and no ad, which in some
 *   configurations still accrues spend, and always leaves an orphan the
 *   user cannot see or delete from our UI.
 *
 *   So:
 *     1. campaign   → PAUSED
 *     2. ad set     → PAUSED
 *     3. creative
 *     4. ad         → PAUSED
 *     5. mirror all of it into our tables, in ONE Prisma transaction
 *     6. only now flip campaign → ad set → ad to ACTIVE
 *
 *   Nothing can spend money until step 6, and by then every object
 *   exists and is recorded. A failure before step 6 triggers a rollback
 *   that deletes what this run created, in reverse order.
 *
 *   `graphRequest` refuses to retry writes for the same reason (see its
 *   docblock): a retried POST buys a second campaign, and a *known*
 *   partial state is strictly easier to unwind than a maybe-duplicate.
 *
 * ACTIVATION FAILURE IS NOT A PUBLISH FAILURE.
 *   If step 6 fails — most often because the ad account's payment method
 *   was removed between Setup and Publish — the objects are real,
 *   recorded and paused. Rolling them back would throw away work the user
 *   can recover with one click, so instead this returns
 *   `leftPaused: true` and the UI says so. Deleting a user's campaign
 *   because we could not turn it on is the wrong trade.
 */
@Injectable()
export class AdPublishService {
  private readonly logger = new Logger(AdPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  async publish(args: {
    accountId: string;
    userId: string;
    adType: AdTypeId;
    input: AdBuildInput;
  }): Promise<PublishResult> {
    const builder = AD_TYPES[args.adType];
    if (!builder) throw new NotFoundException('Unknown ad type.');

    const connection = await this.config.requireAdAccount(args.accountId);
    const context = await this.buildContext(connection);

    // Gate 1 — is this ad type usable by this workspace at all?
    const unavailable = builder.unavailableReason(context);
    if (unavailable) throw new BadRequestException(unavailable);

    // Gate 2 — can the ad account actually spend? Re-read rather than
    // trusting the stored flag: Setup may have run days ago and a card
    // can be removed in between.
    if (!connection.fundingOk) {
      throw new BadRequestException(
        'This ad account cannot run ads — Meta reports no usable payment method. Add one in Meta Business Settings, then try again. Spend is billed to you by Meta, not through this app.',
      );
    }

    // Gate 3 — the performance goal must be one this type offers. A goal
    // the builder does not expect is rejected by Meta four calls later.
    const goals = builder.performanceGoals.map((g) => g.value);
    if (!goals.includes(args.input.optimizationGoal)) {
      throw new BadRequestException(
        `"${args.input.optimizationGoal}" is not a valid goal for a ${builder.label}. Choose one of: ${goals.join(', ')}.`,
      );
    }

    // Gate 4 — the budget ceiling. The DTO validates it and the UI
    // validates it; this is the backstop that catches whatever gets past
    // both, because the failure mode is spending real money.
    this.assertBudgetWithinCeiling(args.input);

    const built = builder.build(args.input, context);

    if (adsSandbox()) {
      return this.publishSandbox({ ...args, built, connection });
    }

    return this.publishLive({ ...args, built, connection });
  }

  /**
   * Meta's own rendering of the creative, as a URL to open.
   *
   * WHY A URL RATHER THAN AN EMBEDDED PREVIEW
   *   `/generatepreviews` returns an `<iframe src="facebook.com/…">`
   *   snippet. Embedding it needs a CSP `frame-src` entry for facebook.com,
   *   and this app's CSP ships Report-Only — an iframe would work in
   *   development and break the day the policy is enforced. So the `src` is
   *   extracted and handed back for the wizard to open in a new tab: the
   *   real rendering, no CSP change, no iframe.
   *
   * Returns null rather than throwing. A preview is advisory; failing the
   * request would make a working ad look broken.
   */
  async previewUrl(args: {
    accountId: string;
    adType: AdTypeId;
    input: AdBuildInput;
    adFormat?: string;
  }): Promise<{ url: string | null; unavailableReason: string | null }> {
    const builder = AD_TYPES[args.adType];
    if (!builder) {
      return { url: null, unavailableReason: 'Unknown ad type.' };
    }

    if (adsSandbox()) {
      return {
        url: null,
        unavailableReason:
          'Sandbox mode — Meta is not contacted, so there is no real preview.',
      };
    }

    try {
      const connection = await this.config.requireAdAccount(args.accountId);
      const context = await this.buildContext(connection);
      const built = builder.build(args.input, context);

      const snippets = await generatePreviews({
        accessToken: connection.accessToken,
        adAccountId: connection.adAccountId,
        creativeSpec: { object_story_spec: built.creative.objectStorySpec },
        adFormat: args.adFormat ?? 'MOBILE_FEED_STANDARD',
      });

      const url = extractIframeSrc(snippets[0]);
      if (!url) {
        return {
          url: null,
          unavailableReason: 'Meta returned a preview we could not read.',
        };
      }

      return { url, unavailableReason: null };
    } catch (err) {
      return {
        url: null,
        unavailableReason:
          err instanceof Error
            ? err.message
            : 'Meta could not generate a preview.',
      };
    }
  }

  // ------------------------------------------------------------
  // The live path
  // ------------------------------------------------------------

  private async publishLive(args: {
    accountId: string;
    userId: string;
    adType: AdTypeId;
    input: AdBuildInput;
    built: BuiltAd;
    connection: AdsConnection & { adAccountId: string };
  }): Promise<PublishResult> {
    const { accountId, userId, adType, input, built, connection } = args;
    const accessToken = connection.accessToken;
    const adAccountId = connection.adAccountId;

    const created: CreatedObjects = {};
    const warnings: string[] = [];

    try {
      // 1 — campaign, PAUSED
      const campaign = await createCampaign({
        accessToken,
        adAccountId,
        status: 'PAUSED',
        ...built.campaign,
      });
      created.campaignId = campaign.id;

      // 2 — ad set, PAUSED
      const adSet = await createAdSet({
        accessToken,
        adAccountId,
        campaignId: campaign.id,
        status: 'PAUSED',
        ...built.adSet,
      });
      created.adSetId = adSet.id;

      // 3 — creative
      const creative = await createAdCreative({
        accessToken,
        adAccountId,
        name: built.creative.name,
        objectStorySpec: built.creative.objectStorySpec,
      });
      created.creativeId = creative.id;

      // 4 — ad, PAUSED
      const ad = await createAd({
        accessToken,
        adAccountId,
        adsetId: adSet.id,
        name: built.adName,
        creativeId: creative.id,
        status: 'PAUSED',
      });
      created.adId = ad.id;

      // 5 — mirror everything, atomically. If this throws, the rollback
      // removes the Meta objects too: a live ad we have no record of is
      // invisible to the user and unstoppable from our UI.
      const localCampaignId = await this.mirror({
        accountId,
        userId,
        adType,
        input,
        built,
        metaIds: {
          campaignId: campaign.id,
          adSetId: adSet.id,
          creativeId: creative.id,
          adId: ad.id,
        },
        currency: connection.currency,
      });

      // 6 — activate, parent-first. An ad activated before its ad set
      // reports ADSET_PAUSED and looks broken.
      let leftPaused = false;
      try {
        await updateObjectStatus({
          accessToken,
          objectId: campaign.id,
          status: 'ACTIVE',
        });
        await updateObjectStatus({
          accessToken,
          objectId: adSet.id,
          status: 'ACTIVE',
        });
        await updateObjectStatus({
          accessToken,
          objectId: ad.id,
          status: 'ACTIVE',
        });
      } catch (err) {
        // Everything exists and is recorded — do NOT roll back. See the
        // class docblock.
        leftPaused = true;
        const message =
          err instanceof Error ? err.message : 'Meta refused to start the ad.';
        warnings.push(
          `The ad was created but could not be switched on: ${message} It is saved and paused — press Resume on the Overview once the problem is fixed.`,
        );
        this.logger.warn(
          `Publish for account ${accountId} left paused: ${message}`,
        );
      }

      await this.config.audit({
        accountId,
        userId,
        action: 'publish_ad',
        objectType: 'campaign',
        objectId: campaign.id,
        detail: {
          ad_type: adType,
          objective: built.campaign.objective,
          optimization_goal: built.adSet.optimizationGoal,
          budget_mode: input.budget.mode,
          budget_minor: input.budget.amountMinor,
          currency: connection.currency,
          adset_id: adSet.id,
          ad_id: ad.id,
          left_paused: leftPaused,
        },
      });

      // Click-to-WhatsApp gets a `ctwa_campaigns` row so the existing
      // click/conversion attribution and the /channels/whatsapp/ctwa page
      // light up with no changes there.
      if (adType === 'click_to_whatsapp') {
        await this.linkCtwaCampaign({
          accountId,
          campaignName: input.campaignName,
          metaAdId: ad.id,
          metaCampaignId: campaign.id,
          welcomeMessage: input.creative.whatsappWelcomeMessage ?? null,
        });
      }

      return {
        campaignId: campaign.id,
        adSetId: adSet.id,
        adId: ad.id,
        localCampaignId,
        leftPaused,
        warnings,
      };
    } catch (err) {
      await this.rollback(accessToken, created, accountId);

      const message =
        err instanceof Error ? err.message : 'Meta rejected the ad.';

      await this.config.audit({
        accountId,
        userId,
        action: 'publish_ad',
        objectType: 'campaign',
        objectId: created.campaignId ?? null,
        detail: {
          ad_type: adType,
          created_before_failure: created,
          budget_minor: input.budget.amountMinor,
        },
        succeeded: false,
        error: message,
      });

      throw new BadRequestException(message);
    }
  }

  /**
   * Undo what this run created, newest first.
   *
   * Every delete is individually guarded: a rollback that aborts halfway
   * because one object was already gone would leave the rest behind, and
   * the whole point is to leave nothing. Failures are logged loudly with
   * the ids, because a leaked PAUSED campaign needs a human to remove it.
   */
  private async rollback(
    accessToken: string,
    created: CreatedObjects,
    accountId: string,
  ): Promise<void> {
    const order: Array<[string, string | undefined]> = [
      ['ad', created.adId],
      ['creative', created.creativeId],
      ['adset', created.adSetId],
      ['campaign', created.campaignId],
    ];

    for (const [kind, objectId] of order) {
      if (!objectId) continue;
      try {
        await deleteObject({ accessToken, objectId });
      } catch (err) {
        this.logger.error(
          `ROLLBACK FAILED for account ${accountId}: could not delete ${kind} ${objectId}. ` +
            'It is PAUSED so it cannot spend, but it must be removed manually in Meta Ads Manager.',
          err instanceof Error ? err.stack : err,
        );
      }
    }
  }

  /**
   * Write the whole object graph locally in one transaction.
   *
   * A transaction rather than four upserts because a half-mirrored
   * publish is worse than an unmirrored one: an ad row whose ad set is
   * missing breaks the Overview's joins, and the sync would not repair it
   * until the next night.
   */
  private async mirror(args: {
    accountId: string;
    userId: string;
    adType: AdTypeId;
    input: AdBuildInput;
    built: BuiltAd;
    metaIds: {
      campaignId: string;
      adSetId: string;
      creativeId: string;
      adId: string;
    };
    currency: string | null;
  }): Promise<string> {
    const { accountId, userId, adType, input, built, metaIds } = args;

    return this.prisma.$transaction(async (tx) => {
      const campaign = await tx.meta_ads_campaigns.create({
        data: {
          account_id: accountId,
          meta_campaign_id: metaIds.campaignId,
          ad_type: adType,
          name: input.campaignName,
          objective: built.campaign.objective,
          // PAUSED, matching what actually exists in Meta right now. The
          // activation in step 6 happens after this, and the next sync
          // reconciles `effective_status` either way — claiming ACTIVE
          // here would make the UI lie if step 6 fails.
          status: 'PAUSED',
          effective_status: 'PAUSED',
          special_ad_categories: input.specialAdCategories,
          start_time: input.budget.startTime
            ? new Date(input.budget.startTime)
            : null,
          stop_time: input.budget.endTime
            ? new Date(input.budget.endTime)
            : null,
          daily_budget:
            input.budget.mode === 'daily' ? input.budget.amountMinor : null,
          lifetime_budget:
            input.budget.mode === 'lifetime' ? input.budget.amountMinor : null,
          created_by_user_id: userId,
          synced_at: new Date(),
        },
      });

      const adSet = await tx.meta_ads_adsets.create({
        data: {
          account_id: accountId,
          campaign_id: campaign.id,
          meta_adset_id: metaIds.adSetId,
          name: built.adSet.name,
          optimization_goal: built.adSet.optimizationGoal,
          billing_event: built.adSet.billingEvent,
          bid_strategy: built.adSet.bidStrategy,
          daily_budget: built.adSet.dailyBudgetMinor ?? null,
          lifetime_budget: built.adSet.lifetimeBudgetMinor ?? null,
          destination_type: built.adSet.destinationType,
          targeting: toJsonObject(built.adSet.targeting),
          promoted_object: toJson(built.adSet.promotedObject),
          adset_schedule: toJson(built.adSet.adsetSchedule),
          status: 'PAUSED',
          effective_status: 'PAUSED',
          synced_at: new Date(),
        },
      });

      await tx.meta_ads_ads.create({
        data: {
          account_id: accountId,
          adset_id: adSet.id,
          meta_ad_id: metaIds.adId,
          meta_creative_id: metaIds.creativeId,
          name: built.adName,
          creative: toJsonObject(built.creative.objectStorySpec),
          status: 'PAUSED',
          effective_status: 'PAUSED',
          synced_at: new Date(),
        },
      });

      return campaign.id;
    });
  }

  /**
   * Attach a `ctwa_campaigns` row to a published Click-to-WhatsApp ad.
   *
   * `ctwa_campaigns.meta_ad_id` already existed before the Ads Manager,
   * and `ctwa_clicks` already joins conversations and contacts to it. So
   * this one insert is what makes "₹4,200 spend → 38 conversations → 9
   * deals" answerable, and makes the existing
   * /channels/whatsapp/ctwa page show wizard-published campaigns.
   *
   * Non-fatal on failure: the ad is live and correct, and losing the
   * attribution row costs a report, not the campaign. Throwing here would
   * roll back a working ad over a reporting nicety.
   */
  private async linkCtwaCampaign(args: {
    accountId: string;
    campaignName: string;
    metaAdId: string;
    metaCampaignId: string;
    welcomeMessage: string | null;
  }): Promise<void> {
    try {
      await this.prisma.ctwa_campaigns.create({
        data: {
          account_id: args.accountId,
          name: args.campaignName,
          meta_ad_id: args.metaAdId,
          meta_campaign_id: args.metaCampaignId,
          pre_filled_message: args.welcomeMessage,
          status: 'active',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Published CTWA ad ${args.metaAdId} but could not create its ctwa_campaigns row — attribution for this campaign will be missing.`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ------------------------------------------------------------
  // Sandbox
  // ------------------------------------------------------------

  /**
   * Publish without Meta.
   *
   * Runs the real builder and the real mirror — so the ad-type logic,
   * validation and database writes are all genuinely exercised — and only
   * substitutes the Graph calls. That is what makes a sandbox walkthrough
   * worth anything: the ids are fake, the code path is not.
   */
  private async publishSandbox(args: {
    accountId: string;
    userId: string;
    adType: AdTypeId;
    input: AdBuildInput;
    built: BuiltAd;
    connection: AdsConnection & { adAccountId: string };
  }): Promise<PublishResult> {
    const stamp = `${Date.now().toString(36)}`;
    const metaIds = {
      campaignId: `${SANDBOX_PREFIX}camp_${stamp}`,
      adSetId: `${SANDBOX_PREFIX}adset_${stamp}`,
      creativeId: `${SANDBOX_PREFIX}creative_${stamp}`,
      adId: `${SANDBOX_PREFIX}ad_${stamp}`,
    };

    const localCampaignId = await this.mirror({
      ...args,
      metaIds,
      currency: args.connection.currency,
    });

    // Sandbox publishes go straight to "running", because there is no
    // Meta to refuse the activation.
    await this.prisma.meta_ads_campaigns.update({
      where: { id: localCampaignId },
      data: { status: 'ACTIVE', effective_status: 'ACTIVE' },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'publish_ad',
      objectType: 'campaign',
      objectId: metaIds.campaignId,
      detail: { sandbox: true, ad_type: args.adType },
    });

    if (args.adType === 'click_to_whatsapp') {
      await this.linkCtwaCampaign({
        accountId: args.accountId,
        campaignName: args.input.campaignName,
        metaAdId: metaIds.adId,
        metaCampaignId: metaIds.campaignId,
        welcomeMessage: args.input.creative.whatsappWelcomeMessage ?? null,
      });
    }

    return {
      campaignId: metaIds.campaignId,
      adSetId: metaIds.adSetId,
      adId: metaIds.adId,
      localCampaignId,
      leftPaused: false,
      warnings: [
        'Sandbox mode — nothing was sent to Meta and no ad is running.',
      ],
    };
  }

  // ------------------------------------------------------------

  /**
   * Resolve the builder's view of the workspace.
   *
   * Note what is NOT copied across: the access token. A builder that
   * could reach it could make its own Graph call and bypass the ordering
   * and rollback rules above.
   */
  private async buildContext(
    connection: AdsConnection & { adAccountId: string },
  ): Promise<AdBuildContext> {
    if (!connection.pageId) {
      throw new BadRequestException(
        'Select a Facebook page in Ads Manager → Setup before publishing.',
      );
    }

    // The display number is only needed for the CTWA prefilled-message
    // path; read it from whatsapp_config rather than duplicating it.
    let whatsappDisplayNumber = connection.whatsappDisplayNumber;
    if (connection.whatsappPhoneNumberId && !whatsappDisplayNumber) {
      const wa = await this.prisma.whatsapp_config.findUnique({
        where: { account_id: connection.accountId },
        select: { phone_number_id: true },
      });
      whatsappDisplayNumber = wa?.phone_number_id ?? null;
    }

    return {
      adAccountId: connection.adAccountId,
      pageId: connection.pageId,
      whatsappPhoneNumberId: connection.whatsappPhoneNumberId,
      whatsappDisplayNumber,
      pixelId: connection.pixelId,
      currency: connection.currency,
      timezoneName: connection.timezoneName,
      // Populated when the selected page has a linked Instagram account.
      // Absent is fine — Meta falls back to the page for IG placements.
      instagramActorId: null,
    };
  }

  /**
   * The server-side budget ceiling.
   *
   * A lifetime budget is compared as a *daily equivalent* over its own
   * run length, because ₹50,000 over 90 days is not the same risk as
   * ₹50,000 over one. With no end date a lifetime budget has no daily
   * equivalent, so the raw amount is checked instead — the conservative
   * reading.
   */
  private assertBudgetWithinCeiling(input: AdBuildInput): void {
    const ceiling = adsMaxDailyBudgetMinor();
    const { mode, amountMinor, startTime, endTime } = input.budget;

    let dailyEquivalent = amountMinor;

    if (mode === 'lifetime' && startTime && endTime) {
      const days = Math.max(
        1,
        Math.round((Date.parse(endTime) - Date.parse(startTime)) / 86_400_000),
      );
      dailyEquivalent = Math.round(amountMinor / days);
    }

    if (dailyEquivalent > ceiling) {
      throw new BadRequestException(
        `That budget works out to about ${(dailyEquivalent / 100).toFixed(2)} per day, above this workspace's limit of ${(ceiling / 100).toFixed(2)} per day. Lower the budget, or ask an administrator to raise ADS_MAX_DAILY_BUDGET_MINOR.`,
      );
    }
  }
}
