import {
  toMinorUnits,
  type AdType,
  type AdTypeInfo,
  type AdsSetupStatus,
  type GeoResult,
  type TargetingCategory,
} from '@/lib/ads/types';

/**
 * The wizard's whole state, and the per-step validation.
 *
 * VALIDATION LIVES HERE, NOT IN THE STEP COMPONENTS.
 *   Each step renders its own fields but does not decide whether they are
 *   acceptable, because two consumers need that answer: the step's own
 *   error list, and the Publish button (which must refuse before making a
 *   request). Splitting it would let those two disagree, so the button
 *   would enable on an invalid form.
 *
 *   These checks mirror the API's DTO and builders — they are the fast,
 *   local copy. The server remains the authority: `AdPublishService`
 *   re-checks the goal, the budget ceiling and the per-type requirements
 *   regardless of what this file said.
 */

export interface ScheduleBlock {
  days: number[];
  start_minute: number;
  end_minute: number;
}

export interface WizardState {
  // Step 1
  adType: AdType | null;
  campaignName: string;
  optimizationGoal: string;
  specialAdCategories: string[];

  // Step 2
  locations: GeoResult[];
  excludedLocations: GeoResult[];
  ageMin: number;
  ageMax: number;
  /** `[]` = all genders. */
  genders: number[];
  publisherPlatforms: string[];
  facebookPositions: string[];
  instagramPositions: string[];
  interests: TargetingCategory[];
  customAudienceIds: string[];
  excludedCustomAudienceIds: string[];
  savedAudienceId: string;
  audienceExpansion: boolean;

  // Step 3
  budgetMode: 'daily' | 'lifetime';
  /** MAJOR units, as typed. Converted once at submit. */
  budgetAmount: string;
  startDate: string;
  endDate: string;
  scheduleBlocks: ScheduleBlock[];

  // Step 4
  adName: string;
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
  imageHash: string;
  videoId: string;
  videoThumbnailUrl: string;
  /** Local preview URL for the chosen media. Never sent to the API. */
  mediaPreviewUrl: string | null;
  link: string;
  whatsappWelcomeMessage: string;
  leadFormId: string;
  /** Pixel event for a conversion-optimised website ad. */
  conversionEvent: string;
}

/**
 * Sensible defaults.
 *
 * Facebook + Instagram feeds selected, and audience expansion OFF. The
 * expansion default matters: on, Meta may show the ad well outside the
 * chosen audience, which is a reasonable option but a surprising default
 * for someone who just carefully picked a city and an interest.
 */
export const emptyWizardState: WizardState = {
  adType: null,
  campaignName: '',
  optimizationGoal: '',
  specialAdCategories: [],

  locations: [],
  excludedLocations: [],
  ageMin: 18,
  ageMax: 65,
  genders: [],
  publisherPlatforms: ['facebook', 'instagram'],
  facebookPositions: ['feed'],
  instagramPositions: ['stream'],
  interests: [],
  customAudienceIds: [],
  excludedCustomAudienceIds: [],
  savedAudienceId: '',
  audienceExpansion: false,

  budgetMode: 'daily',
  budgetAmount: '',
  startDate: '',
  endDate: '',
  scheduleBlocks: [],

  adName: '',
  primaryText: '',
  headline: '',
  description: '',
  callToAction: '',
  imageHash: '',
  videoId: '',
  videoThumbnailUrl: '',
  mediaPreviewUrl: null,
  link: '',
  whatsappWelcomeMessage: '',
  leadFormId: '',
  conversionEvent: '',
};

/** Meta's own field limits. Same numbers as the API's DTO. */
export const LIMITS = {
  adName: 255,
  primaryText: 2200,
  headline: 40,
  description: 30,
  welcomeMessage: 1024,
} as const;

export function validateStep(
  step: 1 | 2 | 3 | 4,
  state: WizardState,
  type: AdTypeInfo | null,
  setup?: AdsSetupStatus | null,
): string[] {
  const errors: string[] = [];

  if (step === 1) {
    if (!state.adType) errors.push('Choose where people should go after clicking.');
    if (type?.unavailableReason) errors.push(type.unavailableReason);
    if (!state.campaignName.trim()) errors.push('Give the campaign a name.');
    if (!state.optimizationGoal) errors.push('Choose a performance goal.');
    return errors;
  }

  if (step === 2) {
    if (!state.savedAudienceId && state.locations.length === 0) {
      // Meta will run the ad worldwide with no location, which is almost
      // never intended and is expensive to discover after the fact.
      errors.push('Add at least one location, or pick a saved audience.');
    }
    if (state.publisherPlatforms.length === 0) {
      errors.push('Select at least one platform.');
    }
    if (state.ageMin > state.ageMax) {
      errors.push('The minimum age cannot be above the maximum.');
    }
    return errors;
  }

  if (step === 3) {
    const minor = toMinorUnits(state.budgetAmount);
    if (!state.budgetAmount.trim() || minor <= 0) {
      errors.push('Enter a budget.');
    } else {
      if (minor < 100) errors.push('That budget is too small to run an ad.');

      // Mirrors the API's backstop so the user finds out here rather than
      // at Publish. The server still enforces it — this is a courtesy.
      const ceiling = setup?.maxDailyBudgetMinor;
      if (ceiling) {
        const days =
          state.budgetMode === 'lifetime' && state.startDate && state.endDate
            ? Math.max(
                1,
                Math.round(
                  (Date.parse(state.endDate) - Date.parse(state.startDate)) /
                    86_400_000,
                ),
              )
            : 1;
        if (Math.round(minor / days) > ceiling) {
          errors.push(
            'That works out above this workspace’s daily spend limit.',
          );
        }
      }
    }

    if (state.budgetMode === 'lifetime' && !state.endDate) {
      // Meta requires a stop time for a lifetime budget, and rejects the
      // ad set without one.
      errors.push('A total budget needs an end date.');
    }
    if (state.startDate && state.endDate && state.endDate < state.startDate) {
      errors.push('The end date is before the start date.');
    }
    return errors;
  }

  // Step 4
  if (!state.primaryText.trim()) errors.push('Write the ad copy.');
  if (state.primaryText.length > LIMITS.primaryText) {
    errors.push(`Ad copy must be ${LIMITS.primaryText} characters or fewer.`);
  }
  if (state.headline.length > LIMITS.headline) {
    errors.push(`The headline must be ${LIMITS.headline} characters or fewer.`);
  }
  if (state.description.length > LIMITS.description) {
    errors.push(
      `The description must be ${LIMITS.description} characters or fewer.`,
    );
  }
  if (!state.imageHash && !state.videoId) {
    errors.push('Add an image or a video — Meta will not deliver an ad without one.');
  }
  if (state.videoId && !state.videoThumbnailUrl) {
    errors.push('The video is still processing. Wait for it to finish.');
  }
  if (type?.needsLink && !state.link.trim()) {
    errors.push('Enter the web address the ad should open.');
  }
  if (type?.needsLink && state.link.trim() && !isHttpUrl(state.link)) {
    errors.push('The web address must start with https://');
  }
  if (type?.needsLeadForm && !state.leadFormId) {
    errors.push('Choose or create a lead form.');
  }
  // A conversion goal without an event would silently fall back to
  // PURCHASE server-side, which is the wrong thing to bid for on a
  // sign-up campaign.
  if (isConversionGoal(state.optimizationGoal) && !state.conversionEvent) {
    errors.push('Choose which conversion event the ad should optimise for.');
  }

  return errors;
}

/**
 * Goals that need a pixel and a conversion event. Mirrors
 * `CONVERSION_GOALS` in the API's website builder.
 */
export function isConversionGoal(goal: string): boolean {
  return goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
