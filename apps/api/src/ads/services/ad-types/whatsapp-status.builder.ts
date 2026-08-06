import {
  buildBudgetFields,
  buildLinkData,
  buildTargeting,
  buildVideoData,
  isVideo,
  requireMedia,
  resolveAdName,
} from './shared';
import { whatsappStatusAdsEnabled } from '../../ads.config';
import type { AdTypeBuilder } from './types';

/**
 * WhatsApp Status ads — creative placed inside the WhatsApp Status feed.
 *
 * ⚠️⚠️ THIS IS THE ONE AD TYPE THAT IS NOT VERIFIED, AND IT SHIPS OFF.
 *
 *   `whatsapp_positions: ['status']` is a new, market-gated placement.
 *   There is no example in Meta's Marketing API Postman collection, the
 *   eligibility rules differ by country and ad account, and we have not
 *   been able to confirm it against a real ad account (see
 *   docs/meta-ads-manager-requirements.md §4 — it is the first item).
 *
 *   So `ADS_WHATSAPP_STATUS_ENABLED` defaults to false and
 *   `unavailableReason` returns a sentence explaining why. The card
 *   renders disabled with that reason rather than accepting a wizard the
 *   user cannot publish — a flow that fails at the last of five Graph
 *   calls, after they have written the copy and uploaded the image, is
 *   worse than a card that says "not yet".
 *
 *   The builder below is complete and reviewable so that turning the flag
 *   on is the only step once the placement is confirmed. Treat its field
 *   names as a hypothesis until then.
 *
 * WHY AWARENESS RATHER THAN ENGAGEMENT
 *   A Status placement is a full-screen interstitial between people's
 *   updates. There is no link surface to click in the way a feed ad has,
 *   so optimising for clicks would bid for an action the format barely
 *   affords. Reach and impressions are what this placement is for.
 */
export const whatsappStatusBuilder: AdTypeBuilder = {
  id: 'whatsapp_status',
  label: 'WhatsApp Status Ad',
  description: 'Reach customers inside WhatsApp Status.',
  objective: 'OUTCOME_AWARENESS',

  performanceGoals: [
    {
      value: 'REACH',
      label: 'Maximise reach',
      description:
        'Shown to as many different people as possible — what a Status placement is for.',
      isDefault: true,
    },
    {
      value: 'IMPRESSIONS',
      label: 'Maximise impressions',
      description:
        'Total views rather than unique people. The same person may see it several times.',
    },
  ],

  callToActions: [
    { value: 'LEARN_MORE', label: 'Learn more' },
    { value: 'WHATSAPP_MESSAGE', label: 'Send WhatsApp message' },
  ],

  needsLink: false,
  needsWhatsApp: true,
  needsLeadForm: false,
  needsPixel: false,

  unavailableReason(context) {
    if (!whatsappStatusAdsEnabled()) {
      return 'WhatsApp Status ads are not enabled for this workspace yet. The placement is still being rolled out by Meta and availability varies by country and ad account.';
    }
    if (!context.whatsappPhoneNumberId) {
      return 'Link a WhatsApp number first.';
    }
    return null;
  },

  build(input, context) {
    requireMedia(input.creative);

    const callToAction = input.creative.callToAction
      ? {
          type: input.creative.callToAction,
          value:
            input.creative.callToAction === 'WHATSAPP_MESSAGE'
              ? { app_destination: 'WHATSAPP' }
              : { link: `https://www.facebook.com/${context.pageId}` },
        }
      : undefined;

    const linkData = isVideo(input.creative)
      ? buildVideoData(
          input.creative,
          callToAction ? { call_to_action: callToAction } : {},
        )
      : buildLinkData(input.creative, {
          link: `https://www.facebook.com/${context.pageId}`,
          ...(callToAction ? { call_to_action: callToAction } : {}),
        });

    return {
      campaign: {
        name: input.campaignName,
        objective: this.objective,
        specialAdCategories: input.specialAdCategories,
      },
      adSet: {
        name: `${input.campaignName} — audience`,
        optimizationGoal: input.optimizationGoal,
        billingEvent: 'IMPRESSIONS',
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        promotedObject: { page_id: context.pageId },
        targeting: {
          ...buildTargeting(input.targeting),
          // The placement itself. Overrides whatever platforms the
          // targeting step chose, because a Status ad runs in exactly one
          // place and offering Facebook Feed alongside it would be a lie.
          publisher_platforms: ['whatsapp'],
          whatsapp_positions: ['status'],
          // Explicitly cleared: leaving these in alongside a whatsapp-only
          // publisher_platforms is a 400.
          facebook_positions: undefined,
          instagram_positions: undefined,
        },
        ...buildBudgetFields(input.budget),
      },
      creative: {
        name: `${input.campaignName} — creative`,
        objectStorySpec: {
          page_id: context.pageId,
          [isVideo(input.creative) ? 'video_data' : 'link_data']: linkData,
        },
      },
      adName: resolveAdName(input),
    };
  },
};
