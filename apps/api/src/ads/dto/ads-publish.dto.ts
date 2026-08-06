import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { AD_TYPE_IDS } from '../services/ad-types';
import { PIXEL_EVENTS } from '../services/ad-types/website.builder';

/**
 * The publish payload.
 *
 * ⚠️ EVERY MONEY FIELD IS MINOR UNITS, AND THAT IS ENFORCED HERE.
 *   `amountMinor` is an integer, not a decimal. A client that sends 500
 *   meaning "₹500" gets a ₹5 ad set — which is why the field is named for
 *   its unit and validated as an integer, so a decimal is rejected at the
 *   boundary rather than silently floored.
 *
 * The limits below (2200 / 40 / 30 characters) are Meta's own. They are
 * enforced here because Meta's rejection for an over-long headline is a
 * generic "Invalid parameter" that names neither the field nor the limit,
 * and it arrives after four other Graph calls have already succeeded.
 */

const META_ID = /^[A-Za-z0-9_]+$/;

// ------------------------------------------------------------
// Budget
// ------------------------------------------------------------

export class AdScheduleBlockDto {
  /** 0 = Sunday … 6 = Saturday, matching Meta. */
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days!: number[];

  /** Minutes from midnight, 0–1440. */
  @IsInt()
  @Min(0)
  @Max(1440)
  start_minute!: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  end_minute!: number;
}

export class AdBudgetDto {
  @IsIn(['daily', 'lifetime'])
  mode!: 'daily' | 'lifetime';

  /**
   * MINOR units of the ad account's currency. 50000 = ₹500.00.
   *
   * Floor of 100 (₹1) rather than 1: Meta's own per-currency minimum is
   * far above a single minor unit, and a 1-paise budget is always a units
   * mistake rather than an intention. The real ceiling is enforced
   * server-side by `AdPublishService.assertBudgetWithinCeiling`, which
   * knows the account's configured limit.
   */
  @IsInt({
    message:
      'amountMinor must be a whole number of minor currency units (5000 = 50.00), not a decimal.',
  })
  @Min(100)
  amountMinor!: number;

  @IsOptional()
  @IsISO8601()
  startTime?: string;

  @IsOptional()
  @IsISO8601()
  endTime?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(168) // one block per hour of the week, at most
  @ValidateNested({ each: true })
  @Type(() => AdScheduleBlockDto)
  schedule?: AdScheduleBlockDto[];
}

// ------------------------------------------------------------
// Targeting
// ------------------------------------------------------------

export class GeoSelectionDto {
  @IsString()
  @MaxLength(64)
  key!: string;

  @IsIn(['country', 'region', 'city', 'zip'])
  type!: 'country' | 'region' | 'city' | 'zip';

  /** Kilometres around a city. Meta allows 1–80. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  radius?: number;
}

export class TargetingCategoryDto {
  @IsString()
  @MaxLength(64)
  @Matches(META_ID)
  id!: string;

  @IsIn(['interests', 'behaviors', 'demographics'])
  category!: 'interests' | 'behaviors' | 'demographics';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class AdTargetingDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => GeoSelectionDto)
  locations?: GeoSelectionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => GeoSelectionDto)
  excludedLocations?: GeoSelectionDto[];

  /**
   * Floor of 18 rather than Meta's 13.
   *
   * Several objectives and every restricted ad category require 18+, and
   * `buildTargeting` clamps to it anyway. Rejecting it here means the user
   * finds out in the form rather than having their choice silently
   * changed.
   */
  @IsOptional()
  @IsInt()
  @Min(18)
  @Max(65)
  ageMin?: number;

  @IsOptional()
  @IsInt()
  @Min(18)
  @Max(65)
  ageMax?: number;

  /** `[]` = all, `[1]` = male, `[2]` = female. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2, { each: true })
  genders?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(['facebook', 'instagram', 'audience_network', 'messenger'], {
    each: true,
  })
  publisherPlatforms?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(48, { each: true })
  facebookPositions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(48, { each: true })
  instagramPositions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TargetingCategoryDto)
  interests?: TargetingCategoryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  customAudienceIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  excludedCustomAudienceIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  savedAudienceId?: string;

  @IsOptional()
  @IsBoolean()
  audienceExpansion?: boolean;
}

// ------------------------------------------------------------
// Creative
// ------------------------------------------------------------

export class AdCreativeDto {
  @IsString()
  @MaxLength(255)
  adName!: string;

  /** Meta's limit for `link_data.message`. */
  @IsString()
  @MaxLength(2200)
  primaryText!: string;

  /** Meta's limit for `link_data.name`. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  headline?: string;

  /** Meta's limit for `link_data.description`. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  callToAction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  imageHash?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  videoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  videoThumbnailUrl?: string;

  /**
   * Destination URL. Validated as a string here and parsed properly in
   * `requireLink` — a regex that accepts every valid URL and rejects every
   * invalid one does not exist, so the real check is `new URL()`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  link?: string;

  /** Prefilled first WhatsApp message. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  whatsappWelcomeMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  leadFormId?: string;

  /**
   * Validated against Meta's standard-event list rather than free text: an
   * unknown value is rejected by Graph with a generic error, after the
   * campaign has already been created.
   */
  @IsOptional()
  @IsIn(PIXEL_EVENTS.map((event) => event.value))
  conversionEvent?: string;
}

// ------------------------------------------------------------
// The request
// ------------------------------------------------------------

/**
 * Meta's special ad categories.
 *
 * An allowlist, not free text: these carry legal targeting restrictions,
 * and an unrecognised value would be rejected by Meta after the campaign
 * call. `NONE` is deliberately absent — "none of these" is the empty
 * array, which is what Meta wants.
 */
export const SPECIAL_AD_CATEGORIES = [
  'HOUSING',
  'CREDIT',
  'EMPLOYMENT',
  'ISSUES_ELECTIONS_POLITICS',
  'ONLINE_GAMBLING_AND_GAMING',
  'FINANCIAL_PRODUCTS_SERVICES',
] as const;

export class PublishAdDto {
  @IsIn(AD_TYPE_IDS as unknown as string[])
  adType!: string;

  @IsString()
  @MaxLength(255)
  campaignName!: string;

  /**
   * Required, and an empty array is a real answer.
   *
   * Not `@IsOptional()`: Meta rejects a campaign create without the field,
   * and more importantly the user has to have been *asked*. Defaulting it
   * to `[]` in the DTO would mean a housing advertiser silently declaring
   * their ad is not a housing ad.
   */
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(SPECIAL_AD_CATEGORIES as unknown as string[], { each: true })
  specialAdCategories!: string[];

  @IsString()
  @MaxLength(64)
  optimizationGoal!: string;

  @ValidateNested()
  @Type(() => AdBudgetDto)
  budget!: AdBudgetDto;

  @ValidateNested()
  @Type(() => AdTargetingDto)
  targeting!: AdTargetingDto;

  @ValidateNested()
  @Type(() => AdCreativeDto)
  creative!: AdCreativeDto;
}

/**
 * Body for the preview: the same payload as a publish.
 *
 * Extends `PublishAdDto` rather than defining a looser shape, so a preview
 * cannot succeed on input the publish would reject — the whole point of a
 * preview is to show what will actually be created.
 */
export class PreviewAdDto extends PublishAdDto {
  /** Meta's placement format, e.g. `MOBILE_FEED_STANDARD`. */
  @IsOptional()
  @IsIn([
    'MOBILE_FEED_STANDARD',
    'DESKTOP_FEED_STANDARD',
    'INSTAGRAM_STANDARD',
    'INSTAGRAM_STORY',
    'FACEBOOK_STORY_MOBILE',
  ])
  adFormat?: string;
}

/** Body for the reach estimate — targeting plus the goal it is measured for. */
export class EstimateReachDto {
  @IsIn(AD_TYPE_IDS as unknown as string[])
  adType!: string;

  @IsString()
  @MaxLength(64)
  optimizationGoal!: string;

  @ValidateNested()
  @Type(() => AdTargetingDto)
  targeting!: AdTargetingDto;
}
