/**
 * Meta **Marketing API** helpers — the Ads Manager surface.
 *
 * A deliberately separate file from `whatsapp/meta-api.util.ts` even
 * though both talk to `graph.facebook.com`. They are different products
 * with different objects, different version cadences and different
 * failure modes: a WhatsApp send that fails costs a message, an ad-set
 * create that fails costs money. Sharing one module would mean sharing
 * one version pin, and these two must be able to move independently.
 *
 * What IS shared: the error classification in
 * `common/messaging/meta-errors.ts` (same envelope, same codes) and
 * `formatMetaError` (same useless generic `message` with the real cause
 * hiding in `error_user_title`/`error_user_msg`).
 *
 * Conventions, matching the rest of the repo:
 *   * every function takes ONE named-options object, never positional args
 *   * every function is pure I/O — no Prisma, no Nest, no logging
 *   * ad account ids are passed WITHOUT the `act_` prefix; `toActPath`
 *     is the only place that prefix exists
 *
 * Reference: notes/Facebook Marketing API (MAPI).postman_collection.json
 */

import { formatMetaError } from '../whatsapp/meta-api.util';
import {
  MetaApiError,
  MetaRateLimitError,
  MetaTokenExpiredError,
} from '../common/messaging/meta-errors';

/**
 * Pinned Graph version for the Marketing API.
 *
 * This is the THIRD version pinned in this codebase — WhatsApp is on
 * v21.0 (`whatsapp/meta-api.util.ts`) and the Facebook Pages/lead-gen
 * integration on v20.0 (`integrations/controllers/facebook.controller.ts`).
 * That is intentional (three independent surfaces, three upgrade
 * risks), but it means three things to keep current rather than one.
 *
 * Marketing API versions are supported for ~2 years and Meta breaks
 * things across them more aggressively than on the messaging side.
 * Verify this is a live version before go-live — see
 * docs/meta-ads-manager-requirements.md.
 */
export const META_MARKETING_VERSION = 'v23.0';

const GRAPH_BASE = `https://graph.facebook.com/${META_MARKETING_VERSION}`;

// ============================================================
// Ad account id normalisation
//
// Graph is inconsistent about the `act_` prefix: paths require it,
// `/me/adaccounts` returns objects carrying BOTH `id` ("act_123") and
// `account_id` ("123"), and some nested fields use the bare form. We
// store the bare form (enforced by a CHECK constraint in migration
// 068) and add the prefix at exactly one place, so `act_act_123` — a
// 400 with a generic message — cannot happen.
// ============================================================

/** `123` → `act_123`. Idempotent, so an already-prefixed id is safe. */
export function toActPath(adAccountId: string): string {
  return adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
}

/** `act_123` → `123`. What we persist. */
export function stripActPrefix(adAccountId: string): string {
  return adAccountId.startsWith('act_') ? adAccountId.slice(4) : adAccountId;
}

// ============================================================
// Money
//
// ⚠️ META IS INCONSISTENT ABOUT UNITS, AND IT IS A 100× BUG.
//
//   BUDGETS AND BIDS — `daily_budget`, `lifetime_budget`, `bid_amount`
//   — are MINOR units, as a string: "50000" means ₹500.00.
//
//   INSIGHTS SPEND — `spend`, `cpc`, `cpm`, `action_values` — are MAJOR
//   units, as a decimal string: "500.00" means ₹500.00.
//
// Both arrive as strings from the same API, often in the same screen,
// and "50000" versus "500.00" both look plausible. We store everything
// as minor-unit BIGINT (migration 068), so these two functions are the
// ONLY places the difference is handled. Never call Number() on a Meta
// money field directly.
// ============================================================

/**
 * A Meta budget/bid field → minor units.
 *
 * Already minor, so this is a parse rather than a conversion. Rounds
 * because Meta has been observed returning "50000.0" on some edges.
 */
export function parseBudgetMinor(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * A Meta insights money field (major-unit decimal string) → minor units.
 *
 * `Math.round` after multiplying, not before: "0.07" * 100 is
 * 7.000000000000001 in IEEE 754, and a truncating cast would store 6 —
 * losing a paisa per row, on every row, forever.
 */
export function parseSpendMinor(
  value: string | number | null | undefined,
): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** A Meta ratio/float field (`ctr`, `frequency`) → number, or null. */
export function parseFloatOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// Rate limits
//
// Marketing API limits are per AD ACCOUNT and per app, not per user,
// and they are shared by everyone in the workspace. Meta reports
// current utilisation on every response in two headers, so we never
// have to guess: read them, surface them, and let the caller decide
// whether to slow a sync job down.
//
// This matters more here than on the messaging side because a
// dashboard that polls insights can exhaust an account's budget of
// calls and take the automation paths down with it.
// ============================================================

export interface AdsRateLimitUsage {
  /** Percent of the ad account's call budget used (0-100), if reported. */
  adAccountUtilPct: number | null;
  /** Seconds until the ad account's window resets, if reported. */
  adAccountResetSeconds: number | null;
  /** `development` | `standard` — which Marketing API tier the app is on. */
  accessTier: string | null;
  /** Worst per-business-use-case utilisation seen on this response. */
  businessUtilPct: number | null;
  /** Seconds until access returns, when Meta has already cut us off. */
  estimatedTimeToRegainAccess: number | null;
}

interface AdAccountUsageHeader {
  acc_id_util_pct?: number;
  reset_time_duration?: number;
  ads_api_access_tier?: string;
}

interface BusinessUseCaseUsageEntry {
  type?: string;
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
}

function parseJsonHeader<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Meta occasionally sends a truncated header. Not worth failing a
    // successful request over — we lose one datapoint of telemetry.
    return null;
  }
}

/** Read `x-ad-account-usage` + `x-business-use-case-usage` off a response. */
export function readRateLimitUsage(response: Response): AdsRateLimitUsage {
  const account = parseJsonHeader<AdAccountUsageHeader>(
    response.headers.get('x-ad-account-usage'),
  );

  const business = parseJsonHeader<Record<string, BusinessUseCaseUsageEntry[]>>(
    response.headers.get('x-business-use-case-usage'),
  );

  // The header is keyed by business id and each value is an array of
  // per-use-case entries. We only care about the worst one — that is
  // the one that will cut us off first.
  let businessUtilPct: number | null = null;
  let regain: number | null = null;
  for (const entries of Object.values(business ?? {})) {
    for (const entry of entries) {
      const worst = Math.max(
        entry.call_count ?? 0,
        entry.total_cputime ?? 0,
        entry.total_time ?? 0,
      );
      if (businessUtilPct === null || worst > businessUtilPct) {
        businessUtilPct = worst;
      }
      const wait = entry.estimated_time_to_regain_access ?? 0;
      if (wait > 0 && (regain === null || wait > regain)) regain = wait;
    }
  }

  return {
    adAccountUtilPct: account?.acc_id_util_pct ?? null,
    adAccountResetSeconds: account?.reset_time_duration ?? null,
    accessTier: account?.ads_api_access_tier ?? null,
    businessUtilPct,
    estimatedTimeToRegainAccess: regain,
  };
}

// ============================================================
// Parameter encoding
//
// The Marketing API takes nested structures (targeting,
// object_story_spec, promoted_object, time_range) as JSON-ENCODED
// STRINGS inside form/query parameters — not as nested JSON in an
// application/json body. Every request in Meta's own Postman
// collection is shaped this way (`creative={"creative_id":…}`,
// `time_range={"since":…}`), and it is the only encoding that works
// consistently across every endpoint here.
//
// So: one encoder, used by both GET query strings and POST bodies.
// Primitives pass through; everything else is JSON.stringify'd. Arrays
// too — `special_ad_categories` must arrive as `[]`, literally.
// ============================================================

export type GraphParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

export function encodeGraphParams(
  params: Record<string, GraphParamValue>,
): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // `undefined` means "not supplied". `null` is meaningful to Graph
    // for a few fields (clearing stop_time), so it is sent as an empty
    // string rather than dropped.
    if (value === undefined) continue;
    if (value === null) {
      search.set(key, '');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      search.set(key, String(value));
    } else {
      search.set(key, JSON.stringify(value));
    }
  }
  return search;
}

// ============================================================
// The one request primitive
// ============================================================

export interface GraphRequestArgs {
  /** Path after the version, with a leading slash: `/act_1/campaigns`. */
  path: string;
  accessToken: string;
  method?: 'GET' | 'POST' | 'DELETE';
  params?: Record<string, GraphParamValue>;
  /** Message used when Meta's response body carries nothing useful. */
  fallbackError?: string;
  /**
   * Retry budget for throttling. **GET only** — see the note in
   * `graphRequest`. Defaults to 2 retries for GET, 0 for writes.
   */
  maxRetries?: number;
}

export interface GraphResponse<T> {
  data: T;
  usage: AdsRateLimitUsage;
}

/** Exponential backoff with jitter, capped. Jitter stops a synced fleet
 *  of workers from retrying in lockstep and re-throttling the account. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  return base + Math.floor(Math.random() * 500);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Marketing API throttling codes.
 *
 * A superset of `RATE_LIMIT_CODES` in common/messaging/meta-errors.ts,
 * which is WhatsApp-shaped (4 / 80007 / 130429). The ads surface adds
 * 17 (per-user request limit) and the whole 80000-80009 business
 * use-case block, and hits them far more easily because insights calls
 * are expensive and the budget is per ad account.
 */
const ADS_THROTTLE_CODES = new Set([4, 17, 32, 80000, 80003, 80004, 80007]);

function isThrottled(status: number, code: number | undefined): boolean {
  return status === 429 || (code !== undefined && ADS_THROTTLE_CODES.has(code));
}

/**
 * Pick the error class for a failed response.
 *
 * Deliberately NOT `throwClassifiedMetaError`, which we would otherwise
 * reuse: it re-reads the response body and overwrites the message with
 * `error.message` — routinely the useless generic "Invalid parameter" —
 * throwing away the `error_user_title` / `error_user_msg` pair that
 * actually names the broken rule. On this surface that difference is
 * "Invalid parameter" versus "The daily budget must be at least ₹89",
 * so we classify here and keep the good message.
 *
 * The classes are the shared ones, so anything already branching on
 * MetaTokenExpiredError / MetaRateLimitError keeps working.
 */
function classifyAdsError(
  status: number,
  code: number | undefined,
  message: string,
): MetaApiError {
  if (status === 401 || code === 190) {
    return new MetaTokenExpiredError(message, code, status);
  }
  if (isThrottled(status, code)) {
    return new MetaRateLimitError(message, code, status);
  }
  return new MetaApiError(message, code, status);
}

/**
 * Every Marketing API call goes through here.
 *
 * RETRIES ARE GET-ONLY, AND THAT IS LOAD-BEARING.
 *   Retrying a throttled POST is how you create two campaigns with one
 *   click. Meta's 429 does not tell you whether the write landed before
 *   the limiter tripped, and `/act_X/campaigns` has no idempotency key.
 *   So writes fail fast and the caller decides — `AdPublishService`
 *   already has to unwind a partial publish, and unwinding a *known*
 *   partial state is strictly easier than reconciling a maybe-duplicate.
 */
export async function graphRequest<T>(
  args: GraphRequestArgs,
): Promise<GraphResponse<T>> {
  const {
    path,
    accessToken,
    method = 'GET',
    params = {},
    fallbackError = `Meta Marketing API error (${method} ${path})`,
  } = args;

  const isRead = method === 'GET';
  const maxRetries = args.maxRetries ?? (isRead ? 2 : 0);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const encoded = encodeGraphParams(params);

    let url = `${GRAPH_BASE}${path}`;
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
    };

    if (method === 'GET' || method === 'DELETE') {
      const qs = encoded.toString();
      if (qs) url += `?${qs}`;
    } else {
      init.body = encoded;
      init.headers = {
        ...init.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
    }

    const response = await fetch(url, init);
    const usage = readRateLimitUsage(response);

    if (response.ok) {
      // 204/empty bodies happen on some DELETEs.
      const text = await response.text();
      const data = (text ? JSON.parse(text) : {}) as T;
      return { data, usage };
    }

    // Preserve `error_user_title` / `error_user_msg`, which is where the
    // actionable cause lives — Meta's `message` is routinely just
    // "Invalid parameter". Read the body once: a Response body can only
    // be consumed once, which is also why classification happens here
    // rather than in a helper that would need to re-read it.
    let detailed = fallbackError;
    let code: number | undefined;
    try {
      const body = (await response.json()) as {
        error?: Parameters<typeof formatMetaError>[0];
      };
      detailed = formatMetaError(body.error, fallbackError);
      code = body.error?.code;
    } catch {
      // Non-JSON body — keep the fallback.
    }

    const error = classifyAdsError(response.status, code, detailed);

    if (error instanceof MetaRateLimitError && attempt < maxRetries) {
      lastError = error;
      // Meta tells us how long it will be before access returns; trust
      // that over our own curve when it is present and short enough to
      // wait out inside a request.
      const hinted = usage.estimatedTimeToRegainAccess;
      const waitMs =
        hinted !== null && hinted > 0 && hinted <= 30
          ? hinted * 1000
          : backoffMs(attempt);
      await sleep(waitMs);
      continue;
    }

    throw error;
  }

  throw lastError instanceof Error
    ? lastError
    : new MetaApiError(fallbackError);
}

/** `graphRequest` when only the payload matters. */
async function graphData<T>(args: GraphRequestArgs): Promise<T> {
  const { data } = await graphRequest<T>(args);
  return data;
}

/** Graph's paged-collection envelope. */
interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Follow `paging.next` until exhausted, with a hard page cap.
 *
 * The cap is not defensive padding: a business portfolio can legally
 * contain thousands of ad accounts, and a connect screen that pages
 * through all of them before rendering is a connect screen that times
 * out. Callers that hit the cap show what they have — every list this
 * is used for is a picker with a search box, not a report.
 */
async function graphPaged<T>(
  args: GraphRequestArgs & { maxPages?: number },
): Promise<T[]> {
  const maxPages = args.maxPages ?? 5;
  const out: T[] = [];
  let after: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const data = await graphData<Paged<T>>({
      ...args,
      params: { ...args.params, ...(after ? { after } : {}) },
    });
    out.push(...(data.data ?? []));
    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
  }

  return out;
}

// ============================================================
// Tokens
// ============================================================

export interface ExchangeLongLivedTokenArgs {
  appId: string;
  appSecret: string;
  /** The short-lived token the browser SDK / OAuth code exchange gave us. */
  shortLivedToken: string;
}

/**
 * Trade a short-lived user token for a ~60-day one.
 *
 * Note this endpoint is NOT authenticated with a Bearer header — the
 * app secret in the query string *is* the credential — so it bypasses
 * `graphRequest`.
 */
export async function exchangeLongLivedToken(
  args: ExchangeLongLivedTokenArgs,
): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const search = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: args.appId,
    client_secret: args.appSecret,
    fb_exchange_token: args.shortLivedToken,
  });

  const response = await fetch(
    `${GRAPH_BASE}/oauth/access_token?${search.toString()}`,
  );

  if (!response.ok) {
    const fallback =
      'Failed to exchange the Facebook access token. Try connecting again.';
    let message = fallback;
    let code: number | undefined;
    try {
      const body = (await response.json()) as {
        error?: Parameters<typeof formatMetaError>[0];
      };
      message = formatMetaError(body.error, fallback);
      code = body.error?.code;
    } catch {
      // Non-JSON body — keep the fallback.
    }
    throw classifyAdsError(response.status, code, message);
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new MetaApiError('Meta returned no access token.');
  }

  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in ?? null,
  };
}

export interface DebugTokenResult {
  /** Permissions Meta actually granted — NOT the ones we asked for. */
  scopes: string[];
  expiresAt: Date | null;
  isValid: boolean;
  fbUserId: string | null;
}

/**
 * Ask Meta what a token can actually do.
 *
 * Called on every connect because the consent dialog lets a user
 * decline individual permissions while still "succeeding". Without
 * this, a user who unticked ads_management gets a healthy-looking
 * connection that fails at publish with a generic permissions error
 * three screens later. Storing the granted list turns that into
 * "reconnect to grant ads_management" up front.
 */
export async function debugToken(args: {
  appId: string;
  appSecret: string;
  inputToken: string;
}): Promise<DebugTokenResult> {
  const data = await graphData<{
    data?: {
      scopes?: string[];
      expires_at?: number;
      is_valid?: boolean;
      user_id?: string;
    };
  }>({
    path: '/debug_token',
    // The app access token is `<app-id>|<app-secret>`.
    accessToken: `${args.appId}|${args.appSecret}`,
    params: { input_token: args.inputToken },
    fallbackError: 'Could not verify the Facebook access token.',
  });

  const info = data.data ?? {};
  return {
    scopes: info.scopes ?? [],
    // `expires_at: 0` means "never expires" (a system-user token), not
    // "expired at the epoch".
    expiresAt: info.expires_at ? new Date(info.expires_at * 1000) : null,
    isValid: info.is_valid ?? false,
    fbUserId: info.user_id ?? null,
  };
}

// ============================================================
// Assets — what the Setup screen picks between
// ============================================================

export interface MetaUserProfile {
  id: string;
  name: string | null;
}

export async function getMe(args: {
  accessToken: string;
}): Promise<MetaUserProfile> {
  const data = await graphData<{ id: string; name?: string }>({
    path: '/me',
    accessToken: args.accessToken,
    params: { fields: 'id,name' },
    fallbackError: 'Could not read your Facebook profile.',
  });
  return { id: data.id, name: data.name ?? null };
}

export interface MetaBusiness {
  id: string;
  name: string;
}

/** Business portfolios the user can administer. Needs `business_management`. */
export async function getBusinesses(args: {
  accessToken: string;
}): Promise<MetaBusiness[]> {
  return graphPaged<MetaBusiness>({
    path: '/me/businesses',
    accessToken: args.accessToken,
    params: { fields: 'id,name', limit: 100 },
    fallbackError:
      'Could not list your Meta business portfolios. The connection may be missing the business_management permission.',
  });
}

export interface MetaAdAccount {
  /** Bare id, no `act_` prefix — see the normalisation note above. */
  id: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  /** Meta's numeric status. 1 = ACTIVE; anything else cannot deliver. */
  accountStatus: number | null;
  /** True when a usable funding source exists. */
  fundingOk: boolean;
  /** Meta's own explanation when the account cannot spend. */
  disableReason: number | null;
}

interface RawAdAccount {
  id?: string;
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  disable_reason?: number;
  funding_source?: string;
  funding_source_details?: { id?: string; type?: number };
}

function mapAdAccount(raw: RawAdAccount): MetaAdAccount {
  return {
    id: stripActPrefix(raw.account_id ?? raw.id ?? ''),
    name: raw.name ?? 'Unnamed ad account',
    currency: raw.currency ?? null,
    timezoneName: raw.timezone_name ?? null,
    accountStatus: raw.account_status ?? null,
    // THE replacement for the reference product's ad-credit balance.
    // We are not the payer, so the only money question is whether the
    // customer's own account can spend: an active status plus some
    // funding source attached.
    fundingOk:
      raw.account_status === 1 &&
      Boolean(raw.funding_source ?? raw.funding_source_details?.id),
    disableReason: raw.disable_reason ?? null,
  };
}

const AD_ACCOUNT_FIELDS =
  'id,account_id,name,currency,timezone_name,account_status,disable_reason,funding_source,funding_source_details';

/** Ad accounts the user can act on, optionally narrowed to one business. */
export async function getAdAccounts(args: {
  accessToken: string;
  /** When set, lists that business's owned + client accounts instead of the user's. */
  businessId?: string;
}): Promise<MetaAdAccount[]> {
  const fallbackError =
    'Could not list your ad accounts. The connection may be missing the ads_management permission.';

  if (!args.businessId) {
    const raw = await graphPaged<RawAdAccount>({
      path: '/me/adaccounts',
      accessToken: args.accessToken,
      params: { fields: AD_ACCOUNT_FIELDS, limit: 100 },
      fallbackError,
    });
    return raw.map(mapAdAccount);
  }

  // A business exposes owned and client accounts on two separate
  // edges, and an agency's accounts live on the *client* one. Reading
  // only `owned_ad_accounts` is why agency users see an empty picker.
  const [owned, client] = await Promise.all([
    graphPaged<RawAdAccount>({
      path: `/${args.businessId}/owned_ad_accounts`,
      accessToken: args.accessToken,
      params: { fields: AD_ACCOUNT_FIELDS, limit: 100 },
      fallbackError,
    }),
    graphPaged<RawAdAccount>({
      path: `/${args.businessId}/client_ad_accounts`,
      accessToken: args.accessToken,
      params: { fields: AD_ACCOUNT_FIELDS, limit: 100 },
      fallbackError,
    }).catch(() => [] as RawAdAccount[]),
  ]);

  const seen = new Set<string>();
  return [...owned, ...client].map(mapAdAccount).filter((a) => {
    if (!a.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/** Re-read one ad account — used to refresh funding/status before a publish. */
export async function getAdAccount(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<MetaAdAccount> {
  const raw = await graphData<RawAdAccount>({
    path: `/${toActPath(args.adAccountId)}`,
    accessToken: args.accessToken,
    params: { fields: AD_ACCOUNT_FIELDS },
    fallbackError: 'Could not read that ad account.',
  });
  return mapAdAccount(raw);
}

export interface MetaPage {
  id: string;
  name: string;
  /** Page-scoped token. Encrypt before persisting. */
  accessToken: string | null;
  /** Tasks the user holds on the page. Running ads needs ADVERTISE. */
  tasks: string[];
  instagramActorId: string | null;
}

/** Pages the user administers, with their page tokens. */
export async function getPages(args: {
  accessToken: string;
}): Promise<MetaPage[]> {
  const raw = await graphPaged<{
    id: string;
    name?: string;
    access_token?: string;
    tasks?: string[];
    instagram_business_account?: { id?: string };
  }>({
    path: '/me/accounts',
    accessToken: args.accessToken,
    params: {
      fields: 'id,name,access_token,tasks,instagram_business_account{id}',
      limit: 100,
    },
    fallbackError: 'Could not list your Facebook pages.',
  });

  return raw.map((p) => ({
    id: p.id,
    name: p.name ?? 'Unnamed page',
    accessToken: p.access_token ?? null,
    tasks: p.tasks ?? [],
    instagramActorId: p.instagram_business_account?.id ?? null,
  }));
}

export interface MetaPixel {
  id: string;
  name: string;
  lastFiredAt: Date | null;
}

/** Pixels on the ad account. Needed for conversion-optimised website ads. */
export async function getPixels(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<MetaPixel[]> {
  const raw = await graphPaged<{
    id: string;
    name?: string;
    last_fired_time?: string;
  }>({
    path: `/${toActPath(args.adAccountId)}/adspixels`,
    accessToken: args.accessToken,
    params: { fields: 'id,name,last_fired_time', limit: 100 },
    fallbackError: 'Could not list the pixels on this ad account.',
  });

  return raw.map((p) => ({
    id: p.id,
    name: p.name ?? 'Unnamed pixel',
    lastFiredAt: p.last_fired_time ? new Date(p.last_fired_time) : null,
  }));
}
