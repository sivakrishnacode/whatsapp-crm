import { BadRequestException } from '@nestjs/common';

import type {
  AdBudgetInput,
  AdBuildInput,
  AdCreativeInput,
  AdTargetingInput,
} from './types';

/**
 * Pieces every ad-type builder shares: the targeting spec, the budget
 * fields, and the creative's `link_data`.
 *
 * These live apart from the builders so the five types differ only where
 * they genuinely differ. A shared bug here is one fix; five near-copies
 * of a targeting mapper would be five.
 */

/**
 * Our targeting input → Meta's `targeting` spec.
 *
 * ⚠️ A SAVED AUDIENCE IS EXCLUSIVE.
 *   Meta rejects `saved_audience_id` combined with hand-built targeting
 *   fields, with an error that names neither. A saved audience already
 *   encodes geo, age, gender and interests, so this returns *only* the
 *   platform/placement choices alongside it — the two things a saved
 *   audience does not cover.
 */
export function buildTargeting(
  input: AdTargetingInput,
): Record<string, unknown> {
  const placements: Record<string, unknown> = {};
  if (input.publisherPlatforms?.length) {
    placements.publisher_platforms = input.publisherPlatforms;
    // Positions are only valid for a platform that was actually selected.
    // Sending `instagram_positions` without `instagram` in
    // publisher_platforms is a 400.
    if (
      input.facebookPositions?.length &&
      input.publisherPlatforms.includes('facebook')
    ) {
      placements.facebook_positions = input.facebookPositions;
    }
    if (
      input.instagramPositions?.length &&
      input.publisherPlatforms.includes('instagram')
    ) {
      placements.instagram_positions = input.instagramPositions;
    }
  }

  if (input.savedAudienceId) {
    return { saved_audience_id: input.savedAudienceId, ...placements };
  }

  const targeting: Record<string, unknown> = { ...placements };

  if (input.geoLocations) targeting.geo_locations = input.geoLocations;
  if (input.excludedGeoLocations) {
    targeting.excluded_geo_locations = input.excludedGeoLocations;
  }

  // Meta's own floor is 18 for several objectives and for every
  // restricted category; clamping here rather than trusting the client
  // means a crafted payload cannot target minors.
  if (input.ageMin !== undefined)
    targeting.age_min = Math.max(18, input.ageMin);
  if (input.ageMax !== undefined)
    targeting.age_max = Math.min(65, input.ageMax);

  // An empty array means "all genders" to Meta, which is also our
  // default — so omit it rather than sending `[]`.
  if (input.genders?.length) targeting.genders = input.genders;

  if (input.flexibleSpec?.length) targeting.flexible_spec = input.flexibleSpec;
  if (input.customAudienceIds?.length) {
    targeting.custom_audiences = input.customAudienceIds.map((id) => ({ id }));
  }
  if (input.excludedCustomAudienceIds?.length) {
    targeting.excluded_custom_audiences = input.excludedCustomAudienceIds.map(
      (id) => ({ id }),
    );
  }

  // Advantage+ audience. Meta has renamed this field more than once
  // (`targeting_optimization`, then `targeting_automation`), so it is
  // flagged in the verification list — the shape below is current for
  // v23.0 and is the ONE place to change if it moves again.
  targeting.targeting_automation = {
    advantage_audience: input.audienceExpansion ? 1 : 0,
  };

  return targeting;
}

/** Budget + schedule fields, in the shape `createAdSet` wants. */
export function buildBudgetFields(budget: AdBudgetInput): {
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
  startTime?: string;
  endTime?: string;
  adsetSchedule?: unknown[];
} {
  const fields: ReturnType<typeof buildBudgetFields> = {
    startTime: budget.startTime,
    endTime: budget.endTime,
  };

  if (budget.mode === 'daily') {
    fields.dailyBudgetMinor = budget.amountMinor;
  } else {
    fields.lifetimeBudgetMinor = budget.amountMinor;
  }

  if (budget.schedule?.length) {
    fields.adsetSchedule = budget.schedule;
  }

  return fields;
}

/**
 * The common `link_data` block of an `object_story_spec`.
 *
 * `message` / `name` / `description` map to the wizard's Primary text /
 * Headline / Description, whose character limits (2200 / 40 / 30) are
 * enforced in the DTO — Meta's rejection for an over-long headline is a
 * generic "Invalid parameter" that names neither the field nor the limit.
 */
export function buildLinkData(
  creative: AdCreativeInput,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const linkData: Record<string, unknown> = {
    message: creative.primaryText,
    ...extras,
  };

  if (creative.headline) linkData.name = creative.headline;
  if (creative.description) linkData.description = creative.description;
  if (creative.imageHash) linkData.image_hash = creative.imageHash;

  return linkData;
}

/**
 * `video_data` for a video creative.
 *
 * Meta requires a thumbnail alongside a video id and rejects the creative
 * without one, so the absence is caught here with a sentence rather than
 * at Graph with "Invalid parameter".
 */
export function buildVideoData(
  creative: AdCreativeInput,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!creative.videoThumbnailUrl) {
    throw new BadRequestException(
      'A video ad needs a thumbnail image. Re-upload the video so a thumbnail can be captured.',
    );
  }

  const videoData: Record<string, unknown> = {
    video_id: creative.videoId,
    image_url: creative.videoThumbnailUrl,
    message: creative.primaryText,
    ...extras,
  };

  if (creative.headline) videoData.title = creative.headline;
  if (creative.description) videoData.link_description = creative.description;

  return videoData;
}

/** True when the creative is a video rather than an image. */
export function isVideo(creative: AdCreativeInput): boolean {
  return Boolean(creative.videoId);
}

/**
 * Assert the creative carries some media.
 *
 * Every one of the five types needs an image or a video: Meta will build
 * a creative without one and then refuse to deliver it, which is worse
 * than refusing to create it.
 */
export function requireMedia(creative: AdCreativeInput): void {
  if (!creative.imageHash && !creative.videoId) {
    throw new BadRequestException(
      'Add an image or a video to the ad. Meta will not deliver an ad with no media.',
    );
  }
}

/** A campaign name is required by Meta; keep the ad name in step by default. */
export function resolveAdName(input: AdBuildInput): string {
  return input.creative.adName.trim() || `${input.campaignName} — ad`;
}
