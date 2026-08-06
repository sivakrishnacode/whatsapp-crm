/**
 * Marketing API — targeting search and audience-size estimation.
 *
 * These are the calls behind the wizard's targeting step: the location
 * and interest autocompletes, and the "estimated reach" figure.
 */

import {
  graphRequest,
  toActPath,
  type GraphParamValue,
} from './marketing-api.util';

// ============================================================
// Geo
// ============================================================

export type GeoType = 'country' | 'region' | 'city' | 'zip';

export interface GeoResult {
  /** Meta's key. A country uses its 2-letter code; others use numeric keys. */
  key: string;
  name: string;
  type: GeoType;
  /** "Karnataka, India" — what disambiguates two cities with one name. */
  context: string | null;
  countryCode: string | null;
}

interface RawGeo {
  key?: string;
  name?: string;
  type?: string;
  country_code?: string;
  country_name?: string;
  region?: string;
  supports_region?: boolean;
}

/**
 * Meta's type strings → ours.
 *
 * Meta returns `country`, `region`, `city`, `zip`, `geo_market`,
 * `electoral_district`, `subneighborhood`, `neighborhood`, `subcity`,
 * `medium_geo_area`, `small_geo_area`, `metro_area`… The wizard offers the
 * four a user thinks in; anything else is folded into the nearest of
 * those rather than shown with a name nobody recognises.
 */
function mapGeoType(metaType: string | undefined): GeoType {
  switch (metaType) {
    case 'country':
      return 'country';
    case 'region':
      return 'region';
    case 'zip':
      return 'zip';
    default:
      return 'city';
  }
}

/**
 * Location autocomplete.
 *
 * The result `key` is what goes into `geo_locations`, and the shape
 * differs by type: countries go in as bare codes (`countries: ['IN']`)
 * while everything else goes in as `{ key }` objects. `groupGeoResults`
 * below does that split so no caller has to remember it.
 */
export async function searchAdGeoLocations(args: {
  accessToken: string;
  query: string;
  /** Restrict the search. Omit for all four types. */
  types?: GeoType[];
  limit?: number;
}): Promise<GeoResult[]> {
  const params: Record<string, GraphParamValue> = {
    type: 'adgeolocation',
    q: args.query,
    limit: args.limit ?? 25,
  };

  if (args.types?.length) {
    // Meta's parameter name for this filter is `location_types`, and it
    // takes its own vocabulary — not ours.
    params.location_types = args.types.map((t) =>
      t === 'city' ? 'city' : t === 'zip' ? 'zip' : t,
    );
  }

  const { data } = await graphRequest<{ data?: RawGeo[] }>({
    path: '/search',
    accessToken: args.accessToken,
    params,
    fallbackError: 'Could not search locations.',
  });

  return (data.data ?? [])
    .filter((row): row is RawGeo & { key: string } => Boolean(row.key))
    .map((row) => ({
      key: row.key,
      name: row.name ?? row.key,
      type: mapGeoType(row.type),
      context:
        [row.region, row.country_name].filter(Boolean).join(', ') || null,
      countryCode: row.country_code ?? null,
    }));
}

/**
 * A flat list of chosen locations → Meta's `geo_locations` object.
 *
 * Exists because the shape is genuinely inconsistent: `countries` is an
 * array of strings, while `regions`, `cities` and `zips` are arrays of
 * `{ key }`. Getting it wrong is a 400 that names the object, not the
 * field.
 */
export function groupGeoResults(
  selections: Array<{ key: string; type: GeoType; radius?: number }>,
): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};

  const countries = selections.filter((s) => s.type === 'country');
  const regions = selections.filter((s) => s.type === 'region');
  const cities = selections.filter((s) => s.type === 'city');
  const zips = selections.filter((s) => s.type === 'zip');

  if (countries.length) grouped.countries = countries.map((c) => c.key);
  if (regions.length) grouped.regions = regions.map((r) => ({ key: r.key }));
  if (cities.length) {
    grouped.cities = cities.map((c) => ({
      key: c.key,
      // Meta's own default when a city is targeted without a radius.
      radius: c.radius ?? 25,
      distance_unit: 'kilometer',
    }));
  }
  if (zips.length) grouped.zips = zips.map((z) => ({ key: z.key }));

  return grouped;
}

// ============================================================
// Interests, behaviours, demographics
// ============================================================

export interface TargetingCategory {
  id: string;
  name: string;
  /** `interests` | `behaviors` | `demographics` — which flexible_spec key. */
  category: 'interests' | 'behaviors' | 'demographics';
  audienceSize: number | null;
  path: string[];
  description: string | null;
}

interface RawInterest {
  id?: string;
  name?: string;
  type?: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  audience_size?: number;
  path?: string[];
  description?: string;
}

/**
 * Which `flexible_spec` bucket a search result belongs in.
 *
 * Meta returns everything from one `adinterest` search but the spec has
 * three separate keys, and putting a behaviour under `interests` is
 * silently ignored rather than rejected — the targeting is simply
 * narrower than the user asked for, with nothing to show why.
 */
function mapCategory(
  raw: RawInterest,
): 'interests' | 'behaviors' | 'demographics' {
  const type = raw.type ?? '';
  if (type.includes('behavior')) return 'behaviors';
  if (
    type.includes('demographic') ||
    type.includes('life_event') ||
    type.includes('income') ||
    type.includes('education') ||
    type.includes('family')
  ) {
    return 'demographics';
  }
  return 'interests';
}

export async function searchAdInterests(args: {
  accessToken: string;
  query: string;
  limit?: number;
}): Promise<TargetingCategory[]> {
  const { data } = await graphRequest<{ data?: RawInterest[] }>({
    path: '/search',
    accessToken: args.accessToken,
    params: {
      type: 'adinterest',
      q: args.query,
      limit: args.limit ?? 25,
    },
    fallbackError: 'Could not search interests.',
  });

  return (data.data ?? [])
    .filter((row): row is RawInterest & { id: string } => Boolean(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name ?? row.id,
      category: mapCategory(row),
      // Meta gives a bound pair for some rows and a single number for
      // others. The lower bound is the honest one to show — an upper
      // bound of 40 million invites the user to expect 40 million.
      audienceSize: row.audience_size_lower_bound ?? row.audience_size ?? null,
      path: row.path ?? [],
      description: row.description ?? null,
    }));
}

// ============================================================
// Reach estimate
// ============================================================

export interface DeliveryEstimate {
  /** Lower and upper bound of the addressable audience. */
  lowerBound: number;
  upperBound: number;
  /** Meta's own note when the estimate is unreliable. */
  unsupported: boolean;
}

/**
 * Estimated audience size for a targeting spec.
 *
 * `/delivery_estimate` on the AD ACCOUNT, which needs no ad set to exist
 * yet — the wizard has to show this before anything is created. It takes
 * the optimisation goal too, because the addressable audience for
 * `CONVERSATIONS` is narrower than for `REACH`: Meta only counts people
 * it believes can perform the optimised action.
 *
 * The reference product shows "Unable To Fetch" here. It is worth getting
 * right — it is the only feedback a user has that their targeting is sane
 * before they spend money on it.
 */
export async function getDeliveryEstimate(args: {
  accessToken: string;
  adAccountId: string;
  targeting: Record<string, unknown>;
  optimizationGoal: string;
}): Promise<DeliveryEstimate | null> {
  const { data } = await graphRequest<{
    data?: Array<{
      estimate_mau_lower_bound?: number;
      estimate_mau_upper_bound?: number;
      estimate_dau?: number;
      estimate_ready?: boolean;
    }>;
  }>({
    path: `/${toActPath(args.adAccountId)}/delivery_estimate`,
    accessToken: args.accessToken,
    params: {
      targeting_spec: args.targeting,
      optimization_goal: args.optimizationGoal,
    },
    fallbackError: 'Could not estimate the audience size.',
  });

  const row = data.data?.[0];
  if (!row) return null;

  const lower = row.estimate_mau_lower_bound ?? 0;
  const upper = row.estimate_mau_upper_bound ?? 0;

  return {
    lowerBound: lower,
    upperBound: upper,
    // `estimate_ready: false` means Meta is still computing and the
    // numbers are provisional. Reporting a provisional estimate as final
    // is how a user concludes their targeting reaches 300 people.
    unsupported: row.estimate_ready === false || (lower === 0 && upper === 0),
  };
}
