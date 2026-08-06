import {
  buildBudgetFields,
  buildLinkData,
  buildTargeting,
  buildVideoData,
  isVideo,
  requireMedia,
  resolveAdName,
} from './shared';
import { requireLink } from './website.builder';
import type { AdTypeBuilder } from './types';

/**
 * Website-to-WhatsApp — the click opens the advertiser's site, and the
 * site carries the WhatsApp button.
 *
 * HOW THIS DIFFERS FROM CLICK-TO-WHATSAPP, AND WHY BOTH EXIST
 *   A Click-to-WhatsApp ad opens a chat directly: fewer steps, but the
 *   visitor never sees the site, so there is no pixel event, no
 *   remarketing audience and no chance to pre-sell. This type trades a
 *   step for that: `OUTCOME_TRAFFIC` to the site, with the WhatsApp
 *   button doing the conversion once they are there.
 *
 *   The important consequence for reporting: Meta cannot attribute the
 *   conversation to this ad, because the conversation starts on the
 *   advertiser's site rather than from the ad. So its "results" column
 *   counts landing-page views, not conversations — and the actual
 *   WhatsApp conversion is attributed by our own `ctwa_clicks` if the
 *   site's button carries the tracking link.
 *
 * NO `destination_type: WHATSAPP` HERE.
 *   That field is what routes the click into a chat, which is exactly what
 *   this type does not want. Setting it would silently turn this into a
 *   Click-to-WhatsApp ad and the website would never be seen.
 */
export const websiteToWhatsAppBuilder: AdTypeBuilder = {
  id: 'website_to_whatsapp',
  label: 'Website to WhatsApp Ad',
  description: 'Website visits with a WhatsApp button.',
  objective: 'OUTCOME_TRAFFIC',

  performanceGoals: [
    {
      value: 'LANDING_PAGE_VIEWS',
      label: 'Maximise landing page views',
      description:
        'Optimises for people who wait for your page to load — the ones who can actually find the WhatsApp button.',
      isDefault: true,
    },
    {
      value: 'LINK_CLICKS',
      label: 'Maximise link clicks',
      description: 'Cheaper taps, more of which never reach your page.',
    },
  ],

  callToActions: [
    { value: 'LEARN_MORE', label: 'Learn more' },
    { value: 'SHOP_NOW', label: 'Shop now' },
    { value: 'GET_OFFER', label: 'Get offer' },
    { value: 'CONTACT_US', label: 'Contact us' },
  ],

  needsLink: true,
  needsWhatsApp: true,
  needsLeadForm: false,
  needsPixel: false,

  unavailableReason(context) {
    if (!context.whatsappPhoneNumberId) {
      return 'Link a WhatsApp number first — this ad type exists to send website visitors into a WhatsApp chat.';
    }
    return null;
  },

  build(input, context) {
    requireMedia(input.creative);
    const link = requireLink(input.creative.link);

    const callToAction = {
      type: input.creative.callToAction ?? 'LEARN_MORE',
      value: { link },
    };

    const linkData = isVideo(input.creative)
      ? buildVideoData(input.creative, { call_to_action: callToAction })
      : buildLinkData(input.creative, { link, call_to_action: callToAction });

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
        // Deliberately no destinationType and no promotedObject — see the
        // docblock. The destination is the website, not a chat.
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
