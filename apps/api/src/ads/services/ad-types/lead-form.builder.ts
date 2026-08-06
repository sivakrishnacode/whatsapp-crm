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
import type { AdTypeBuilder } from './types';

/**
 * Lead Form ads — a Meta *instant form*, rendered by Facebook inside the
 * ad, with no website involved.
 *
 * `destination_type: 'ON_AD'` is what makes the form open in-place rather
 * than sending the click to a landing page. Together with
 * `optimization_goal: LEAD_GENERATION` and a `lead_gen_form_id` on the
 * creative's call-to-action, that is the whole difference from a website
 * ad.
 *
 * WHERE THE LEADS GO
 *   Nowhere new. Submissions arrive on the EXISTING
 *   `/webhooks/facebook-leads` endpoint in IntegrationsModule, which
 *   already turns a lead into a contact, a pipeline deal and a WhatsApp
 *   conversation. This builder only creates the ad that points at the
 *   form; the receiving half predates the Ads Manager entirely.
 *
 *   One consequence worth knowing: that webhook drops a lead with no
 *   usable phone number, because `contacts` requires a phone, an IGSID or
 *   a web visitor id. So a form without a phone question produces leads
 *   this CRM cannot store — which is why the lead-form builder in the
 *   wizard defaults to including one.
 */
export const leadFormBuilder: AdTypeBuilder = {
  id: 'lead_form',
  label: 'Lead Form Ads',
  description: 'Capture lead details without leaving Meta.',
  objective: 'OUTCOME_LEADS',

  performanceGoals: [
    {
      value: 'LEAD_GENERATION',
      label: 'Maximise number of leads',
      description:
        'Shown to people most likely to submit the form. The default, and right unless you have a reason otherwise.',
      isDefault: true,
    },
    {
      value: 'QUALITY_LEAD',
      label: 'Maximise quality leads',
      description:
        'Fewer, better-qualified submissions. Needs enough conversion history for Meta to learn what "quality" means for you.',
    },
  ],

  callToActions: [
    { value: 'SIGN_UP', label: 'Sign up' },
    { value: 'APPLY_NOW', label: 'Apply now' },
    { value: 'GET_QUOTE', label: 'Get quote' },
    { value: 'LEARN_MORE', label: 'Learn more' },
  ],

  needsLink: false,
  needsWhatsApp: false,
  needsLeadForm: true,
  needsPixel: false,

  unavailableReason() {
    // A form is chosen in the creative step rather than being a
    // precondition of the type, so there is nothing to block on here —
    // `build` enforces its presence.
    return null;
  },

  build(input, context) {
    requireMedia(input.creative);

    if (!input.creative.leadFormId) {
      throw new BadRequestException(
        'Choose or create a lead form before publishing a Lead Form ad.',
      );
    }

    const callToAction = {
      type: input.creative.callToAction ?? 'SIGN_UP',
      value: { lead_gen_form_id: input.creative.leadFormId },
    };

    const linkData = isVideo(input.creative)
      ? buildVideoData(input.creative, { call_to_action: callToAction })
      : buildLinkData(input.creative, {
          // Required by Meta even though the instant form is the real
          // destination; it is what a user sees if the form fails to open.
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
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        destinationType: 'ON_AD',
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
