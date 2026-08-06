import { BadRequestException } from '@nestjs/common';

import {
  buildBudgetFields,
  buildLinkData,
  buildTargeting,
  buildVideoData,
  isVideo,
  requireMedia,
  resolveAdName,
} from './shared';
import type { AdBuildContext, AdTypeBuilder } from './types';

/**
 * Website ads — send the click to a page the advertiser owns.
 *
 * THE OBJECTIVE DEPENDS ON THE GOAL, WHICH IS UNUSUAL
 *   Every other builder pins one objective. This one cannot: optimising
 *   for conversions requires `OUTCOME_SALES` plus a `promoted_object`
 *   naming a pixel and an event, while optimising for clicks or landing
 *   page views is `OUTCOME_TRAFFIC` with no promoted object at all.
 *   Sending `OFFSITE_CONVERSIONS` under `OUTCOME_TRAFFIC` is rejected, and
 *   sending `LINK_CLICKS` under `OUTCOME_SALES` optimises for the wrong
 *   thing while looking fine. So `objective` here is the traffic default
 *   and `build` overrides it when the chosen goal is a conversion goal.
 */

/** Goals that require a pixel and shift the campaign to OUTCOME_SALES. */
const CONVERSION_GOALS = new Set(['OFFSITE_CONVERSIONS', 'VALUE']);

function resolveObjective(optimizationGoal: string): string {
  return CONVERSION_GOALS.has(optimizationGoal)
    ? 'OUTCOME_SALES'
    : 'OUTCOME_TRAFFIC';
}

/** Shared by this builder and website-to-whatsapp. */
export function requireLink(link: string | undefined): string {
  if (!link) {
    throw new BadRequestException('Enter the web address the ad should open.');
  }
  // Meta rejects a non-http(s) link with a generic error, and an
  // `http://` link will be upgraded or blocked by most browsers anyway.
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new BadRequestException(
      'That web address is not valid. Include https:// at the start.',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException(
      'The web address must start with https:// (or http://).',
    );
  }
  return parsed.toString();
}

/**
 * Meta's standard pixel events, as the wizard offers them.
 *
 * A fixed enum rather than a list read from the pixel, and that is not a
 * shortcut: `custom_event_type` accepts only these values, and a pixel's
 * *observed* events are a different thing — a brand-new pixel has fired
 * nothing, yet you may legitimately want to optimise for the purchase
 * event it is about to start reporting. The Events page shows what has
 * actually fired; this is what Meta will accept.
 */
export const PIXEL_EVENTS = [
  { value: 'PURCHASE', label: 'Purchase' },
  { value: 'LEAD', label: 'Lead' },
  { value: 'COMPLETE_REGISTRATION', label: 'Registration' },
  { value: 'ADD_TO_CART', label: 'Add to cart' },
  { value: 'INITIATED_CHECKOUT', label: 'Checkout started' },
  { value: 'ADD_PAYMENT_INFO', label: 'Payment info added' },
  { value: 'SUBMIT_APPLICATION', label: 'Application submitted' },
  { value: 'SUBSCRIBE', label: 'Subscription' },
  { value: 'CONTACT', label: 'Contact' },
  { value: 'SEARCH', label: 'Search' },
  { value: 'CONTENT_VIEW', label: 'Content view' },
] as const;

export const DEFAULT_PIXEL_EVENT = 'PURCHASE';

export function isPixelEvent(value: string): boolean {
  return PIXEL_EVENTS.some((event) => event.value === value);
}

export function requirePixelForConversions(
  optimizationGoal: string,
  context: AdBuildContext,
  conversionEvent?: string,
): Record<string, unknown> | undefined {
  if (!CONVERSION_GOALS.has(optimizationGoal)) return undefined;

  if (!context.pixelId) {
    throw new BadRequestException(
      'Optimising for conversions needs a Meta Pixel. Select one in Ads Manager → Setup, or choose a click-based goal instead.',
    );
  }

  const event = conversionEvent ?? DEFAULT_PIXEL_EVENT;
  if (!isPixelEvent(event)) {
    // Caught here rather than at Graph, which rejects an unknown event with
    // a generic "Invalid parameter" after the campaign already exists.
    throw new BadRequestException(
      `"${event}" is not a Meta standard event. Choose one of: ${PIXEL_EVENTS.map((e) => e.value).join(', ')}.`,
    );
  }

  return {
    pixel_id: context.pixelId,
    custom_event_type: event,
  };
}

export const websiteBuilder: AdTypeBuilder = {
  id: 'website',
  label: 'Website Ad',
  description: 'Send people to a product or landing page.',
  objective: 'OUTCOME_TRAFFIC',

  performanceGoals: [
    {
      value: 'LANDING_PAGE_VIEWS',
      label: 'Maximise landing page views',
      description:
        'Optimises for people who actually wait for the page to load, not just tap. Usually better value than raw clicks.',
      isDefault: true,
    },
    {
      value: 'LINK_CLICKS',
      label: 'Maximise link clicks',
      description: 'The cheapest clicks. More of them bounce.',
    },
    {
      value: 'OFFSITE_CONVERSIONS',
      label: 'Maximise conversions',
      description:
        'Optimises for a purchase or sign-up your pixel reports. Requires a Meta Pixel.',
    },
  ],

  callToActions: [
    { value: 'LEARN_MORE', label: 'Learn more' },
    { value: 'SHOP_NOW', label: 'Shop now' },
    { value: 'SIGN_UP', label: 'Sign up' },
    { value: 'BOOK_TRAVEL', label: 'Book now' },
    { value: 'GET_OFFER', label: 'Get offer' },
  ],

  needsLink: true,
  needsWhatsApp: false,
  needsLeadForm: false,
  needsPixel: false,

  unavailableReason() {
    return null;
  },

  build(input, context) {
    requireMedia(input.creative);
    const link = requireLink(input.creative.link);
    const promotedObject = requirePixelForConversions(
      input.optimizationGoal,
      context,
      input.creative.conversionEvent,
    );

    const callToAction = {
      type: input.creative.callToAction ?? 'LEARN_MORE',
      value: { link },
    };

    const linkData = isVideo(input.creative)
      ? buildVideoData(input.creative, {
          call_to_action: callToAction,
          link_description: input.creative.description,
        })
      : buildLinkData(input.creative, { link, call_to_action: callToAction });

    return {
      campaign: {
        name: input.campaignName,
        objective: resolveObjective(input.optimizationGoal),
        specialAdCategories: input.specialAdCategories,
      },
      adSet: {
        name: `${input.campaignName} — audience`,
        optimizationGoal: input.optimizationGoal,
        billingEvent: 'IMPRESSIONS',
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        promotedObject,
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
