import { Injectable, Logger } from '@nestjs/common';

import { adsSandbox } from '../ads.config';
import {
  getDeliveryEstimate,
  groupGeoResults,
  searchAdGeoLocations,
  searchAdInterests,
  type GeoResult,
  type GeoType,
  type TargetingCategory,
} from '../marketing-targeting.util';
import { AD_TYPES, type AdTypeId } from './ad-types';
import { buildTargeting } from './ad-types/shared';
import type { AdTargetingInput } from './ad-types/types';
import type { AdTargetingDto } from '../dto/ads-publish.dto';
import { AdsConfigService } from './ads-config.service';

export interface ReachEstimate {
  lowerBound: number | null;
  upperBound: number | null;
  /** Why there is no usable number, when there isn't. */
  unavailableReason: string | null;
}

/**
 * Location and interest search, and the reach estimate.
 *
 * Also owns the DTO → builder-input translation, because that mapping has
 * one genuinely non-obvious step (grouping locations into Meta's
 * inconsistently-shaped `geo_locations`) and it should exist once rather
 * than in both the publish controller and the estimate path.
 */
@Injectable()
export class AdsTargetingService {
  private readonly logger = new Logger(AdsTargetingService.name);

  constructor(private readonly config: AdsConfigService) {}

  async searchLocations(args: {
    accountId: string;
    query: string;
    types?: GeoType[];
  }): Promise<GeoResult[]> {
    if (adsSandbox()) return sandboxLocations(args.query);

    const connection = await this.config.requireConnection(args.accountId);
    return searchAdGeoLocations({
      accessToken: connection.accessToken,
      query: args.query,
      types: args.types,
    });
  }

  async searchInterests(args: {
    accountId: string;
    query: string;
  }): Promise<TargetingCategory[]> {
    if (adsSandbox()) return sandboxInterests(args.query);

    const connection = await this.config.requireConnection(args.accountId);
    return searchAdInterests({
      accessToken: connection.accessToken,
      query: args.query,
    });
  }

  /**
   * DTO → the builders' `AdTargetingInput`.
   *
   * The one interesting step is `groupGeoResults`: Meta's `geo_locations`
   * wants `countries` as bare strings but `regions` / `cities` / `zips` as
   * `{ key }` objects, and getting that wrong is a 400 naming the object
   * rather than the field. Doing it here means neither the wizard nor the
   * builders have to know.
   */
  toTargetingInput(dto: AdTargetingDto): AdTargetingInput {
    const input: AdTargetingInput = {
      ageMin: dto.ageMin,
      ageMax: dto.ageMax,
      genders: dto.genders,
      publisherPlatforms: dto.publisherPlatforms,
      facebookPositions: dto.facebookPositions,
      instagramPositions: dto.instagramPositions,
      customAudienceIds: dto.customAudienceIds,
      excludedCustomAudienceIds: dto.excludedCustomAudienceIds,
      savedAudienceId: dto.savedAudienceId,
      audienceExpansion: dto.audienceExpansion,
    };

    if (dto.locations?.length) {
      input.geoLocations = groupGeoResults(dto.locations);
    }
    if (dto.excludedLocations?.length) {
      input.excludedGeoLocations = groupGeoResults(dto.excludedLocations);
    }

    // `flexible_spec` is an array of OR-groups, each mapping a category
    // key to its members. One group means "any of these interests", which
    // is what a single chip list expresses — separate groups would AND
    // them together and shrink the audience to almost nobody.
    if (dto.interests?.length) {
      const grouped: Record<string, Array<{ id: string; name?: string }>> = {};
      for (const interest of dto.interests) {
        grouped[interest.category] ??= [];
        grouped[interest.category].push({
          id: interest.id,
          name: interest.name,
        });
      }
      input.flexibleSpec = [grouped];
    }

    return input;
  }

  /**
   * Estimated audience size.
   *
   * Returns a reason rather than throwing when Meta cannot answer. The
   * reference product shows a bare "Unable To Fetch" here, which tells the
   * user nothing they can act on — and a targeting step that errors out
   * because an *optional* estimate failed would block a publish that would
   * have worked.
   */
  async estimateReach(args: {
    accountId: string;
    adType: AdTypeId;
    optimizationGoal: string;
    targeting: AdTargetingDto;
  }): Promise<ReachEstimate> {
    const builder = AD_TYPES[args.adType];

    if (adsSandbox()) {
      // Deterministic, and derived from the spec so narrowing the
      // targeting visibly narrows the estimate — a fixed number would
      // make the control look broken.
      const breadth =
        (args.targeting.locations?.length ?? 1) * 900_000 +
        (args.targeting.interests?.length ?? 0) * -120_000;
      const base = Math.max(50_000, breadth);
      return {
        lowerBound: base,
        upperBound: Math.round(base * 1.4),
        unavailableReason: null,
      };
    }

    const connection = await this.config.findConnection(args.accountId);
    if (!connection?.adAccountId) {
      return {
        lowerBound: null,
        upperBound: null,
        unavailableReason:
          'Connect an ad account to see the estimated audience size.',
      };
    }

    try {
      const spec = buildTargeting(this.toTargetingInput(args.targeting));
      const estimate = await getDeliveryEstimate({
        accessToken: connection.accessToken,
        adAccountId: connection.adAccountId,
        targeting: spec,
        optimizationGoal: args.optimizationGoal || builder.objective,
      });

      if (!estimate || estimate.unsupported) {
        return {
          lowerBound: null,
          upperBound: null,
          unavailableReason:
            'Meta could not estimate this audience yet. Broaden the targeting, or publish and check delivery after a few hours.',
        };
      }

      return {
        lowerBound: estimate.lowerBound,
        upperBound: estimate.upperBound,
        unavailableReason: null,
      };
    } catch (err) {
      // Never fatal: the estimate is advisory, and Meta rejects a spec
      // here for reasons (a brand-new ad account, a throttle) that do not
      // prevent the ad itself.
      const message =
        err instanceof Error ? err.message : 'Meta could not be reached.';
      this.logger.debug(
        `Reach estimate failed for account ${args.accountId}: ${message}`,
      );
      return {
        lowerBound: null,
        upperBound: null,
        unavailableReason: message,
      };
    }
  }
}

// ============================================================
// Sandbox
// ============================================================

const SANDBOX_PLACES: GeoResult[] = [
  {
    key: 'IN',
    name: 'India',
    type: 'country',
    context: null,
    countryCode: 'IN',
  },
  {
    key: 'AE',
    name: 'United Arab Emirates',
    type: 'country',
    context: null,
    countryCode: 'AE',
  },
  {
    key: 'GB',
    name: 'United Kingdom',
    type: 'country',
    context: null,
    countryCode: 'GB',
  },
  {
    key: '2696',
    name: 'Bengaluru',
    type: 'city',
    context: 'Karnataka, India',
    countryCode: 'IN',
  },
  {
    key: '2734',
    name: 'Mumbai',
    type: 'city',
    context: 'Maharashtra, India',
    countryCode: 'IN',
  },
  {
    key: '2743',
    name: 'New Delhi',
    type: 'city',
    context: 'Delhi, India',
    countryCode: 'IN',
  },
  {
    key: '3159',
    name: 'Karnataka',
    type: 'region',
    context: 'India',
    countryCode: 'IN',
  },
  {
    key: '560001',
    name: '560001',
    type: 'zip',
    context: 'Bengaluru, India',
    countryCode: 'IN',
  },
];

function sandboxLocations(query: string): GeoResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return SANDBOX_PLACES.slice(0, 5);
  return SANDBOX_PLACES.filter((p) => p.name.toLowerCase().includes(q));
}

const SANDBOX_INTERESTS: TargetingCategory[] = [
  {
    id: '6003139266461',
    name: 'Online shopping',
    category: 'interests',
    audienceSize: 780_000_000,
    path: ['Interests', 'Shopping'],
    description: null,
  },
  {
    id: '6003107902433',
    name: 'Small business owners',
    category: 'interests',
    audienceSize: 210_000_000,
    path: ['Interests', 'Business'],
    description: null,
  },
  {
    id: '6002714895372',
    name: 'Frequent travellers',
    category: 'behaviors',
    audienceSize: 96_000_000,
    path: ['Behaviours', 'Travel'],
    description: null,
  },
  {
    id: '6015559470583',
    name: 'Engaged shoppers',
    category: 'behaviors',
    audienceSize: 430_000_000,
    path: ['Behaviours', 'Purchase'],
    description: null,
  },
  {
    id: '6002714398172',
    name: 'Parents with young children',
    category: 'demographics',
    audienceSize: 120_000_000,
    path: ['Demographics', 'Family'],
    description: null,
  },
];

function sandboxInterests(query: string): TargetingCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return SANDBOX_INTERESTS;
  return SANDBOX_INTERESTS.filter((i) => i.name.toLowerCase().includes(q));
}
