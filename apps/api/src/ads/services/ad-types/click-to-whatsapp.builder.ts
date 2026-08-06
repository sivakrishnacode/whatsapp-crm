import {
  buildBudgetFields,
  buildLinkData,
  buildTargeting,
  buildVideoData,
  isVideo,
  requireMedia,
  resolveAdName,
} from './shared';
import type { AdTypeBuilder } from './types';

/**
 * Click-to-WhatsApp — the flagship type, and the only one whose result
 * lands inside this CRM.
 *
 * WHAT MAKES AN AD A CTWA AD
 *   Three things together, which is exactly why `ad_type` has to be our
 *   own column (Meta has no such field):
 *     1. `destination_type: 'WHATSAPP'` on the ad set
 *     2. `promoted_object: { page_id }` — the page whose linked WhatsApp
 *        number receives the conversation
 *     3. a creative whose call-to-action is `WHATSAPP_MESSAGE` with
 *        `value.app_destination: 'WHATSAPP'`
 *   Miss any one and Meta either rejects the ad set or silently builds a
 *   link ad that opens a web page instead of a chat.
 *
 * ⚠️ VERIFY BEFORE TRUSTING (docs/meta-ads-manager-requirements.md §4)
 *   The exact `promoted_object` shape for CTWA and which objectives permit
 *   `destination_type: WHATSAPP` are the two items in the verification
 *   list with no example in Meta's Postman collection. The shape below is
 *   what current Meta docs describe; the sandbox path exists so the flow
 *   is walkable while that is confirmed against a real ad account.
 *
 * WHY OUTCOME_ENGAGEMENT
 *   `OUTCOME_SALES` and `OUTCOME_LEADS` also permit a WhatsApp
 *   destination, but both optimise toward a conversion event Meta can
 *   only observe if a pixel or CAPI is reporting one. A workspace whose
 *   conversion happens in a WhatsApp thread has no such signal, so those
 *   objectives would spend against a goal Meta cannot measure.
 *   `OUTCOME_ENGAGEMENT` + `CONVERSATIONS` optimises for the thing that
 *   actually happens.
 */
export const clickToWhatsAppBuilder: AdTypeBuilder = {
  id: 'click_to_whatsapp',
  label: 'Click to WhatsApp Ad',
  description: 'Start a WhatsApp conversation from your ad.',
  objective: 'OUTCOME_ENGAGEMENT',

  performanceGoals: [
    {
      value: 'CONVERSATIONS',
      label: 'Maximise conversations',
      description:
        'Shown to people most likely to start a WhatsApp chat. The right choice for almost every CTWA ad.',
      isDefault: true,
    },
    {
      value: 'LINK_CLICKS',
      label: 'Maximise link clicks',
      description:
        'Cheaper clicks, but more of them go nowhere — Meta optimises for the tap, not the conversation.',
    },
    {
      value: 'REACH',
      label: 'Maximise reach',
      description:
        'Shown to as many different people as possible. Use for awareness, not for enquiries.',
    },
  ],

  callToActions: [
    { value: 'WHATSAPP_MESSAGE', label: 'Send WhatsApp message' },
  ],

  needsLink: false,
  needsWhatsApp: true,
  needsLeadForm: false,
  needsPixel: false,

  unavailableReason(context) {
    if (!context.whatsappPhoneNumberId) {
      return 'Link a WhatsApp number first — a Click-to-WhatsApp ad needs somewhere to deliver the conversation.';
    }
    return null;
  },

  build(input, context) {
    requireMedia(input.creative);

    const callToAction = {
      type: 'WHATSAPP_MESSAGE',
      value: {
        app_destination: 'WHATSAPP',
        // The prefilled first message. Optional to Meta, but a blank
        // opener means the customer has to compose one, which is the
        // single biggest drop-off in a CTWA funnel.
        ...(input.creative.whatsappWelcomeMessage
          ? { whatsapp_number: context.whatsappDisplayNumber ?? undefined }
          : {}),
      },
    };

    const linkData = isVideo(input.creative)
      ? buildVideoData(input.creative, { call_to_action: callToAction })
      : buildLinkData(input.creative, {
          // `link` is required on link_data even for a WhatsApp
          // destination; Meta ignores it and uses the CTA's
          // app_destination. Pointing it at the page rather than an
          // arbitrary URL keeps it meaningful if Meta ever renders it.
          link: `https://www.facebook.com/${context.pageId}`,
          call_to_action: callToAction,
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
        // Lowest cost without a cap. A bid cap on a first campaign
        // usually means no delivery at all, which reads as "the product
        // is broken" rather than "the bid was too low".
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        destinationType: 'WHATSAPP',
        promotedObject: { page_id: context.pageId },
        targeting: buildTargeting(input.targeting),
        ...buildBudgetFields(input.budget),
      },
      creative: {
        name: `${input.campaignName} — creative`,
        objectStorySpec: {
          page_id: context.pageId,
          ...(context.instagramActorId
            ? { instagram_actor_id: context.instagramActorId }
            : {}),
          [isVideo(input.creative) ? 'video_data' : 'link_data']: linkData,
        },
      },
      adName: resolveAdName(input),
    };
  },
};
