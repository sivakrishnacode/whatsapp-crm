/**
 * The ad-type builder contract.
 *
 * WHY A REGISTRY RATHER THAN A SWITCH
 *   The five ad types differ in *every* layer of the Meta object graph:
 *   the campaign objective, the ad set's optimisation goal and
 *   destination, the promoted object, and the creative's call-to-action.
 *   A switch per layer would spread one ad type's definition across four
 *   functions, so changing "what is a Click-to-WhatsApp ad" would mean
 *   editing four places and hoping they stayed consistent.
 *
 *   Here each type is one file that answers all four questions, and
 *   `AdPublishService` is entirely type-agnostic: it picks a builder, runs
 *   it, and executes the result. Adding a sixth ad type is one new file
 *   plus one registry line, with no change to the publish path.
 *
 * WHAT A BUILDER MAY AND MAY NOT DO
 *   A builder is pure: given validated input and a resolved account
 *   context, it returns parameter objects. It never calls Graph, never
 *   touches Prisma, and never reads `process.env`. That is what makes
 *   each one testable without a network or a database — and every one of
 *   them is tested, because a wrong `promoted_object` is a rejected
 *   publish and a wrong `optimization_goal` is wasted money.
 */

import type {
  CreateAdSetArgs,
  CreateCampaignArgs,
} from '../../marketing-objects.util';

/** The five types. Must match `meta_ads_campaigns_ad_type_chk` in migration 068. */
export const AD_TYPE_IDS = [
  'click_to_whatsapp',
  'whatsapp_status',
  'website_to_whatsapp',
  'website',
  'lead_form',
] as const;

export type AdTypeId = (typeof AD_TYPE_IDS)[number];

/**
 * Everything a builder is allowed to know about the workspace.
 *
 * Deliberately a resolved snapshot rather than the connection object:
 * a builder must not be able to reach `accessToken`, because a builder
 * that could make its own Graph call could bypass the publish path's
 * ordering and rollback.
 */
export interface AdBuildContext {
  adAccountId: string;
  /** The page ads run from. Every type needs one. */
  pageId: string;
  /** Present only when a WhatsApp number is linked. */
  whatsappPhoneNumberId: string | null;
  whatsappDisplayNumber: string | null;
  /** Present only when a pixel is selected. */
  pixelId: string | null;
  /** The ad account's currency + timezone, both fixed by Meta. */
  currency: string | null;
  timezoneName: string | null;
  /** Instagram actor, when the chosen page has a linked IG account. */
  instagramActorId: string | null;
}

/** Budget + schedule, shared by every type. Validated before it gets here. */
export interface AdBudgetInput {
  mode: 'daily' | 'lifetime';
  /** MINOR units of the ad account currency. */
  amountMinor: number;
  /** ISO date-time. */
  startTime?: string;
  endTime?: string;
  /** Day-parting blocks, when a custom schedule is used. */
  schedule?: Array<{
    days: number[];
    start_minute: number;
    end_minute: number;
    timezone_type?: string;
  }>;
}

/** Targeting, shared by every type. Mirrors Meta's spec, narrowed. */
export interface AdTargetingInput {
  geoLocations?: {
    countries?: string[];
    regions?: Array<{ key: string }>;
    cities?: Array<{ key: string; radius?: number; distance_unit?: string }>;
    zips?: Array<{ key: string }>;
  };
  excludedGeoLocations?: AdTargetingInput['geoLocations'];
  ageMin?: number;
  ageMax?: number;
  /** `[]` = all, `[1]` = male, `[2]` = female. */
  genders?: number[];
  publisherPlatforms?: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
  /** Interests / behaviours / demographics, as Meta's flexible_spec. */
  flexibleSpec?: Array<Record<string, Array<{ id: string; name?: string }>>>;
  customAudienceIds?: string[];
  excludedCustomAudienceIds?: string[];
  savedAudienceId?: string;
  /** Advantage+ audience expansion. */
  audienceExpansion?: boolean;
}

/** The creative fields the wizard collects. Not all types use all of them. */
export interface AdCreativeInput {
  adName: string;
  primaryText: string;
  headline?: string;
  description?: string;
  /** `WHATSAPP_MESSAGE`, `SIGN_UP`, `LEARN_MORE`, … */
  callToAction?: string;
  /** From `/act_X/adimages`. Exactly one of image/video. */
  imageHash?: string;
  videoId?: string;
  /** Required alongside `videoId` — Meta needs a thumbnail. */
  videoThumbnailUrl?: string;
  /** Website / Website→WhatsApp destination. */
  link?: string;
  /** Prefilled first message for a Click-to-WhatsApp ad. */
  whatsappWelcomeMessage?: string;
  /** Meta instant form, for lead-form ads. */
  leadFormId?: string;
  /**
   * The pixel event a conversion-optimised website ad bids for. Ignored
   * unless the chosen goal is a conversion goal — see `PIXEL_EVENTS`.
   */
  conversionEvent?: string;
}

export interface AdBuildInput {
  campaignName: string;
  /**
   * `[]` is a real answer, not an omission. Housing / credit /
   * employment / social-issue ads have legally restricted targeting and
   * Meta rejects a campaign create without the field.
   */
  specialAdCategories: string[];
  /** One of the type's `performanceGoals`. */
  optimizationGoal: string;
  budget: AdBudgetInput;
  targeting: AdTargetingInput;
  creative: AdCreativeInput;
}

/** What a builder returns — parameters, not calls. */
export interface BuiltAd {
  campaign: Omit<CreateCampaignArgs, 'accessToken' | 'adAccountId' | 'status'>;
  adSet: Omit<
    CreateAdSetArgs,
    'accessToken' | 'adAccountId' | 'campaignId' | 'status'
  >;
  creative: {
    name: string;
    objectStorySpec: Record<string, unknown>;
  };
  adName: string;
}

/**
 * A performance goal the user may pick, and what it means in plain words.
 *
 * Exposed to the wizard so the dropdown is built from the same source
 * that validates the choice — a UI offering a goal the builder rejects is
 * a publish that fails after four Graph calls.
 */
export interface PerformanceGoal {
  /** Meta's `optimization_goal`. */
  value: string;
  label: string;
  description: string;
  isDefault?: boolean;
}

export interface AdTypeBuilder {
  id: AdTypeId;
  label: string;
  description: string;
  /** Meta campaign objective. Fixed per type — never user-chosen. */
  objective: string;
  performanceGoals: PerformanceGoal[];
  /** Call-to-action buttons valid for this type. */
  callToActions: Array<{ value: string; label: string }>;
  /** Whether the wizard should collect a destination URL. */
  needsLink: boolean;
  /** Whether this type needs a linked WhatsApp number. */
  needsWhatsApp: boolean;
  /** Whether this type needs a Meta instant form. */
  needsLeadForm: boolean;
  /** Whether a pixel is required (as opposed to optional). */
  needsPixel: boolean;
  /**
   * Why this type cannot be used right now, or null when it can.
   *
   * Returned as a sentence for the user rather than a boolean, because
   * "unavailable" without a reason is the least useful thing a disabled
   * card can say.
   */
  unavailableReason(context: AdBuildContext): string | null;
  build(input: AdBuildInput, context: AdBuildContext): BuiltAd;
}
