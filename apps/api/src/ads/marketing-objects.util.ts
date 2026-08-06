/**
 * Marketing API — campaigns, ad sets, ads, creatives.
 *
 * The object graph: Ad Account → Campaign (objective) → Ad Set (budget,
 * schedule, targeting, optimisation, destination) → Ad → Ad Creative.
 *
 * Split from marketing-api.util.ts (which owns the request primitive,
 * money parsing and the asset pickers) purely for file size — same
 * conventions: one named-options object per function, no Prisma, no
 * Nest, ad account ids without the `act_` prefix.
 *
 * ⚠️ Every `create*` here is a WRITE that costs money once activated,
 * and `graphRequest` deliberately does not retry writes. See
 * `AdPublishService` for the ordering and rollback rules that make a
 * partial failure recoverable.
 */

import {
  graphRequest,
  parseBudgetMinor,
  toActPath,
  type GraphParamValue,
} from './marketing-api.util';

// ============================================================
// Field lists
//
// Explicit rather than `fields=*` (which Graph does not support) and
// deliberately narrow: every extra field is latency on a call whose
// rate limit is shared by the whole workspace. Each list mirrors the
// columns in migration 068 — if you add a column, add it here.
// ============================================================

const CAMPAIGN_FIELDS = [
  'id',
  'name',
  'objective',
  'status',
  'effective_status',
  'buying_type',
  'daily_budget',
  'lifetime_budget',
  'special_ad_categories',
  'start_time',
  'stop_time',
].join(',');

const ADSET_FIELDS = [
  'id',
  'campaign_id',
  'name',
  'optimization_goal',
  'billing_event',
  'bid_strategy',
  'bid_amount',
  'daily_budget',
  'lifetime_budget',
  'destination_type',
  'targeting',
  'promoted_object',
  'adset_schedule',
  'status',
  'effective_status',
  'start_time',
  'end_time',
].join(',');

const AD_FIELDS = [
  'id',
  'adset_id',
  'name',
  'status',
  'effective_status',
  'creative{id,object_story_spec,thumbnail_url,effective_object_story_id}',
].join(',');

// ============================================================
// Types
// ============================================================

export interface MetaCampaign {
  id: string;
  name: string;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  buyingType: string | null;
  /** Minor units. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  specialAdCategories: string[];
  startTime: Date | null;
  stopTime: Date | null;
}

export interface MetaAdSet {
  id: string;
  campaignId: string | null;
  name: string;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  /** Minor units. */
  bidAmount: number | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  destinationType: string | null;
  targeting: Record<string, unknown> | null;
  promotedObject: Record<string, unknown> | null;
  adsetSchedule: unknown[] | null;
  status: string | null;
  effectiveStatus: string | null;
}

export interface MetaAd {
  id: string;
  adsetId: string | null;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  creative: Record<string, unknown> | null;
  thumbnailUrl: string | null;
}

interface RawCampaign {
  id: string;
  name?: string;
  objective?: string;
  status?: string;
  effective_status?: string;
  buying_type?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  special_ad_categories?: string[];
  start_time?: string;
  stop_time?: string;
}

interface RawAdSet {
  id: string;
  campaign_id?: string;
  name?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  bid_amount?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  destination_type?: string;
  targeting?: Record<string, unknown>;
  promoted_object?: Record<string, unknown>;
  adset_schedule?: unknown[];
  status?: string;
  effective_status?: string;
}

interface RawAd {
  id: string;
  adset_id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  creative?: {
    id?: string;
    object_story_spec?: Record<string, unknown>;
    thumbnail_url?: string;
  };
}

/** Graph returns "" for a cleared timestamp, which `new Date("")` makes Invalid. */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapCampaign(raw: RawCampaign): MetaCampaign {
  return {
    id: raw.id,
    name: raw.name ?? 'Untitled campaign',
    objective: raw.objective ?? null,
    status: raw.status ?? null,
    effectiveStatus: raw.effective_status ?? null,
    buyingType: raw.buying_type ?? null,
    dailyBudget: parseBudgetMinor(raw.daily_budget),
    lifetimeBudget: parseBudgetMinor(raw.lifetime_budget),
    specialAdCategories: raw.special_ad_categories ?? [],
    startTime: parseDate(raw.start_time),
    stopTime: parseDate(raw.stop_time),
  };
}

function mapAdSet(raw: RawAdSet): MetaAdSet {
  return {
    id: raw.id,
    campaignId: raw.campaign_id ?? null,
    name: raw.name ?? 'Untitled ad set',
    optimizationGoal: raw.optimization_goal ?? null,
    billingEvent: raw.billing_event ?? null,
    bidStrategy: raw.bid_strategy ?? null,
    bidAmount: parseBudgetMinor(raw.bid_amount),
    dailyBudget: parseBudgetMinor(raw.daily_budget),
    lifetimeBudget: parseBudgetMinor(raw.lifetime_budget),
    destinationType: raw.destination_type ?? null,
    targeting: raw.targeting ?? null,
    promotedObject: raw.promoted_object ?? null,
    adsetSchedule: raw.adset_schedule ?? null,
    status: raw.status ?? null,
    effectiveStatus: raw.effective_status ?? null,
  };
}

function mapAd(raw: RawAd): MetaAd {
  return {
    id: raw.id,
    adsetId: raw.adset_id ?? null,
    name: raw.name ?? 'Untitled ad',
    status: raw.status ?? null,
    effectiveStatus: raw.effective_status ?? null,
    creativeId: raw.creative?.id ?? null,
    creative: raw.creative?.object_story_spec ?? null,
    thumbnailUrl: raw.creative?.thumbnail_url ?? null,
  };
}

// ============================================================
// Reads
//
// `effective_status` filtering is deliberately absent: the sync has to
// see ARCHIVED and DELETED objects too, or a campaign deleted in Meta's
// own Ads Manager would stay "active" in our mirror forever.
// ============================================================

interface PagedEnvelope<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Page through an edge.
 *
 * Local to this module rather than shared: unlike the asset pickers
 * (which are lists a human scrolls and can safely cap at a few pages),
 * a sync that silently stopped at page 5 would under-report spend. The
 * cap here is high and the caller is told when it was hit.
 */
async function pageThrough<T>(args: {
  path: string;
  accessToken: string;
  params: Record<string, GraphParamValue>;
  fallbackError: string;
  maxPages?: number;
}): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = args.maxPages ?? 25;
  const items: T[] = [];
  let after: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const { data } = await graphRequest<PagedEnvelope<T>>({
      path: args.path,
      accessToken: args.accessToken,
      params: { ...args.params, ...(after ? { after } : {}) },
      fallbackError: args.fallbackError,
    });

    items.push(...(data.data ?? []));
    after = data.paging?.cursors?.after;

    if (!data.paging?.next || !after) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { items, truncated };
}

export async function getCampaigns(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<{ items: MetaCampaign[]; truncated: boolean }> {
  const { items, truncated } = await pageThrough<RawCampaign>({
    path: `/${toActPath(args.adAccountId)}/campaigns`,
    accessToken: args.accessToken,
    params: { fields: CAMPAIGN_FIELDS, limit: 100 },
    fallbackError: 'Could not read the campaigns on this ad account.',
  });
  return { items: items.map(mapCampaign), truncated };
}

export async function getAdSets(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<{ items: MetaAdSet[]; truncated: boolean }> {
  const { items, truncated } = await pageThrough<RawAdSet>({
    path: `/${toActPath(args.adAccountId)}/adsets`,
    accessToken: args.accessToken,
    params: { fields: ADSET_FIELDS, limit: 100 },
    fallbackError: 'Could not read the ad sets on this ad account.',
  });
  return { items: items.map(mapAdSet), truncated };
}

export async function getAds(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<{ items: MetaAd[]; truncated: boolean }> {
  const { items, truncated } = await pageThrough<RawAd>({
    path: `/${toActPath(args.adAccountId)}/ads`,
    accessToken: args.accessToken,
    params: { fields: AD_FIELDS, limit: 100 },
    fallbackError: 'Could not read the ads on this ad account.',
  });
  return { items: items.map(mapAd), truncated };
}

// ============================================================
// Writes
// ============================================================

export interface CreateCampaignArgs {
  accessToken: string;
  adAccountId: string;
  name: string;
  objective: string;
  /**
   * Mandatory, and `[]` is a real answer rather than a default we may
   * assume. Housing / credit / employment / social-issue ads have
   * legally restricted targeting, so the wizard asks explicitly.
   */
  specialAdCategories: string[];
  /** Always 'PAUSED' from the publish path — see AdPublishService. */
  status: 'ACTIVE' | 'PAUSED';
  buyingType?: string;
  /** Minor units. Campaign-level budget is optional (we budget per ad set). */
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
}

export async function createCampaign(
  args: CreateCampaignArgs,
): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/campaigns`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      name: args.name,
      objective: args.objective,
      status: args.status,
      special_ad_categories: args.specialAdCategories,
      buying_type: args.buyingType,
      daily_budget: args.dailyBudgetMinor,
      lifetime_budget: args.lifetimeBudgetMinor,
    },
    fallbackError: 'Meta rejected the campaign.',
  });
  return data;
}

export interface CreateAdSetArgs {
  accessToken: string;
  adAccountId: string;
  campaignId: string;
  name: string;
  optimizationGoal: string;
  billingEvent: string;
  bidStrategy?: string;
  /** Minor units. Exactly one of daily/lifetime, enforced by the builder. */
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
  bidAmountMinor?: number;
  /** `WHATSAPP` for Click-to-WhatsApp, `ON_AD` for instant lead forms. */
  destinationType?: string;
  targeting: Record<string, unknown>;
  promotedObject?: Record<string, unknown>;
  /** ISO strings including the ad account's UTC offset, not the browser's. */
  startTime?: string;
  endTime?: string;
  /** Day-parting blocks. Requires `pacing_type: ['day_parting']`. */
  adsetSchedule?: unknown[];
  status: 'ACTIVE' | 'PAUSED';
}

export async function createAdSet(
  args: CreateAdSetArgs,
): Promise<{ id: string }> {
  const params: Record<string, GraphParamValue> = {
    campaign_id: args.campaignId,
    name: args.name,
    optimization_goal: args.optimizationGoal,
    billing_event: args.billingEvent,
    bid_strategy: args.bidStrategy,
    daily_budget: args.dailyBudgetMinor,
    lifetime_budget: args.lifetimeBudgetMinor,
    bid_amount: args.bidAmountMinor,
    destination_type: args.destinationType,
    targeting: args.targeting,
    promoted_object: args.promotedObject,
    start_time: args.startTime,
    end_time: args.endTime,
    status: args.status,
  };

  if (args.adsetSchedule?.length) {
    params.adset_schedule = args.adsetSchedule;
    // Meta ignores adset_schedule without this, silently — the ad runs
    // around the clock and the day-parting the user configured is lost
    // with no error to explain it.
    params.pacing_type = ['day_parting'];
  }

  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/adsets`,
    accessToken: args.accessToken,
    method: 'POST',
    params,
    fallbackError: 'Meta rejected the ad set.',
  });
  return data;
}

export interface CreateAdCreativeArgs {
  accessToken: string;
  adAccountId: string;
  name: string;
  objectStorySpec: Record<string, unknown>;
  /** Advantage+ creative enhancements, when the ad type opts in. */
  degreesOfFreedomSpec?: Record<string, unknown>;
}

export async function createAdCreative(
  args: CreateAdCreativeArgs,
): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/adcreatives`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      name: args.name,
      object_story_spec: args.objectStorySpec,
      degrees_of_freedom_spec: args.degreesOfFreedomSpec,
    },
    fallbackError: 'Meta rejected the ad creative.',
  });
  return data;
}

export async function createAd(args: {
  accessToken: string;
  adAccountId: string;
  adsetId: string;
  name: string;
  creativeId: string;
  status: 'ACTIVE' | 'PAUSED';
}): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/ads`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      adset_id: args.adsetId,
      name: args.name,
      creative: { creative_id: args.creativeId },
      status: args.status,
    },
    fallbackError: 'Meta rejected the ad.',
  });
  return data;
}

/**
 * Flip an object's status.
 *
 * Works on a campaign, ad set or ad — Graph dispatches on the id. Used
 * for the activate step of a publish, and for pause/resume from the
 * Overview page.
 */
export async function updateObjectStatus(args: {
  accessToken: string;
  objectId: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
}): Promise<void> {
  await graphRequest({
    path: `/${args.objectId}`,
    accessToken: args.accessToken,
    method: 'POST',
    params: { status: args.status },
    fallbackError: `Could not set the status of ${args.objectId}.`,
  });
}

/**
 * Delete an object.
 *
 * Used only by the publish rollback. Users pause or archive; they never
 * delete, because a deleted campaign takes its spend history with it.
 */
export async function deleteObject(args: {
  accessToken: string;
  objectId: string;
}): Promise<void> {
  await graphRequest({
    path: `/${args.objectId}`,
    accessToken: args.accessToken,
    method: 'DELETE',
    fallbackError: `Could not delete ${args.objectId}.`,
  });
}

/**
 * Meta's own rendered preview for a creative spec.
 *
 * Returns an `<iframe>` snippet, which is why the UI does not use it
 * yet: embedding it needs a CSP `frame-src` entry for facebook.com, and
 * this app's CSP is Report-Only today — it would work in dev and break
 * on enforcement. Exposed here so the wizard can adopt it deliberately
 * rather than discovering the constraint later.
 */
export async function generatePreviews(args: {
  accessToken: string;
  adAccountId: string;
  creativeSpec: Record<string, unknown>;
  /** e.g. `MOBILE_FEED_STANDARD`, `INSTAGRAM_STORY`. */
  adFormat: string;
}): Promise<string[]> {
  const { data } = await graphRequest<{ data?: Array<{ body?: string }> }>({
    path: `/${toActPath(args.adAccountId)}/generatepreviews`,
    accessToken: args.accessToken,
    params: {
      creative: args.creativeSpec,
      ad_format: args.adFormat,
    },
    fallbackError: 'Could not generate an ad preview.',
  });
  return (data.data ?? [])
    .map((row) => row.body)
    .filter((body): body is string => Boolean(body));
}
