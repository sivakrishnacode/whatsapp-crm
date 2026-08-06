/**
 * Marketing API — insights (reporting).
 *
 * ⚠️ `spend`, `cpc`, `cpm` and `action_values` here are MAJOR units as
 * decimal strings ("500.00"), while budgets on campaigns and ad sets are
 * MINOR units ("50000"). Both are strings from the same API. Every money
 * field below goes through `parseSpendMinor`; see the money section of
 * marketing-api.util.ts.
 */

import {
  graphRequest,
  parseFloatOrNull,
  parseSpendMinor,
  toActPath,
  type GraphParamValue,
} from './marketing-api.util';
import { MetaApiError } from '../common/messaging/meta-errors';

export type InsightsLevel = 'account' | 'campaign' | 'adset' | 'ad';

/**
 * One action row (`actions` / `action_values`).
 *
 * Kept raw rather than reduced to a single "results" number: which
 * action type counts as *the* result depends on the objective —
 * `onsite_conversion.messaging_conversation_started_7d` for
 * Click-to-WhatsApp, `lead` for a lead form, `link_click` for traffic.
 * Reducing here would bake one objective's definition into the
 * transport.
 */
export interface MetaActionRow {
  action_type: string;
  value: string;
}

export interface MetaInsightRow {
  level: InsightsLevel;
  /** The Meta object this row measures. */
  objectId: string;
  /** `YYYY-MM-DD`. Daily grain (`time_increment=1`). */
  dateStart: string;
  /** Minor units. */
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number | null;
  /** Minor units. */
  cpc: number | null;
  cpm: number | null;
  frequency: number | null;
  actions: MetaActionRow[] | null;
  actionValues: MetaActionRow[] | null;
}

const INSIGHTS_FIELDS = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'frequency',
  'actions',
  'action_values',
  'date_start',
  'date_stop',
].join(',');

/** The id field Graph returns per level. */
const ID_FIELD: Record<InsightsLevel, string> = {
  account: 'account_id',
  campaign: 'campaign_id',
  adset: 'adset_id',
  ad: 'ad_id',
};

interface RawInsightRow {
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: MetaActionRow[];
  action_values?: MetaActionRow[];
}

function toInt(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function mapRow(
  raw: RawInsightRow,
  level: InsightsLevel,
): MetaInsightRow | null {
  const objectId = raw[ID_FIELD[level] as keyof RawInsightRow] as
    string | undefined;

  // A row with no object id cannot be upserted against our unique grain.
  // Dropping it silently would understate spend, so the caller counts
  // these — see `getInsights`'s `skipped`.
  if (!objectId || !raw.date_start) return null;

  return {
    level,
    objectId,
    dateStart: raw.date_start,
    spend: parseSpendMinor(raw.spend),
    impressions: toInt(raw.impressions),
    reach: toInt(raw.reach),
    clicks: toInt(raw.clicks),
    ctr: parseFloatOrNull(raw.ctr),
    cpc: raw.cpc ? parseSpendMinor(raw.cpc) : null,
    cpm: raw.cpm ? parseSpendMinor(raw.cpm) : null,
    frequency: parseFloatOrNull(raw.frequency),
    actions: raw.actions ?? null,
    actionValues: raw.action_values ?? null,
  };
}

export interface GetInsightsArgs {
  accessToken: string;
  adAccountId: string;
  level: InsightsLevel;
  /** `YYYY-MM-DD`, inclusive. */
  since: string;
  until: string;
  /**
   * Page cap. Daily rows × ads can be large; a 30-day window over 200
   * ads is 6,000 rows, which is 3 pages at 2,000. The default allows
   * plenty of headroom and reports truncation rather than hiding it.
   */
  maxPages?: number;
}

export interface GetInsightsResult {
  rows: MetaInsightRow[];
  /** True when the page cap was hit — the window is incomplete. */
  truncated: boolean;
  /** Rows Meta returned that had no object id or date; always report these. */
  skipped: number;
}

/**
 * Daily insights for one level over a date range.
 *
 * `time_increment=1` (one row per object per day) rather than a rollup,
 * because every range the UI offers is then a SUM over the same stored
 * rows and a range crossing a sync boundary stays correct.
 *
 * WHY THE CALLER RE-FETCHES THE TRAILING WEEK
 *   Meta restates attributed conversions for up to ~28 days, so a row
 *   written once is wrong later. The nightly sync asks for the last 7
 *   days every time and upserts on
 *   (account_id, level, object_id, date_start).
 */
export async function getInsights(
  args: GetInsightsArgs,
): Promise<GetInsightsResult> {
  const maxPages = args.maxPages ?? 20;
  const rows: MetaInsightRow[] = [];
  let skipped = 0;
  let after: string | undefined;
  let truncated = false;

  const params: Record<string, GraphParamValue> = {
    level: args.level,
    fields: INSIGHTS_FIELDS,
    time_increment: 1,
    time_range: { since: args.since, until: args.until },
    limit: 500,
    // Report what the ad account's own attribution setting says, so our
    // numbers match what the customer sees in Meta's Ads Manager. A
    // dashboard that disagrees with Meta is worse than no dashboard.
    use_unified_attribution_setting: true,
  };

  for (let page = 0; page < maxPages; page++) {
    const { data } = await graphRequest<{
      data?: RawInsightRow[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>({
      path: `/${toActPath(args.adAccountId)}/insights`,
      accessToken: args.accessToken,
      params: { ...params, ...(after ? { after } : {}) },
      fallbackError: 'Could not read ad performance from Meta.',
    });

    for (const raw of data.data ?? []) {
      const mapped = mapRow(raw, args.level);
      if (mapped) rows.push(mapped);
      else skipped++;
    }

    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { rows, truncated, skipped };
}

// ============================================================
// Async reports
//
// A synchronous /insights call times out on wide windows (a year of
// daily rows at ad level). Meta's answer is an async job: POST to start
// it, poll a report id, then GET the rows. The Postman collection shows
// this pattern (`async=true` → `{{report_id}}/insights`).
//
// Not used by the nightly sync — a rolling 7-day window is always small
// enough — but it is what any "export the last 12 months" feature has to
// use, so it lives here rather than being rediscovered later.
// ============================================================

export async function startAsyncInsightsReport(args: {
  accessToken: string;
  adAccountId: string;
  level: InsightsLevel;
  since: string;
  until: string;
}): Promise<{ reportRunId: string }> {
  const { data } = await graphRequest<{ report_run_id: string }>({
    path: `/${toActPath(args.adAccountId)}/insights`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      level: args.level,
      fields: INSIGHTS_FIELDS,
      time_increment: 1,
      time_range: { since: args.since, until: args.until },
      use_unified_attribution_setting: true,
      async: true,
    },
    fallbackError: 'Could not start the Meta insights report.',
  });
  return { reportRunId: data.report_run_id };
}

export interface AsyncReportStatus {
  status: string;
  percentComplete: number;
  /** Terminal and successful — the rows can be fetched. */
  ready: boolean;
  /** Terminal and unsuccessful. */
  failed: boolean;
}

export async function getAsyncReportStatus(args: {
  accessToken: string;
  reportRunId: string;
}): Promise<AsyncReportStatus> {
  const { data } = await graphRequest<{
    async_status?: string;
    async_percent_completion?: number;
  }>({
    path: `/${args.reportRunId}`,
    accessToken: args.accessToken,
    params: { fields: 'async_status,async_percent_completion' },
    fallbackError: 'Could not check the Meta insights report.',
  });

  const status = data.async_status ?? 'Unknown';
  return {
    status,
    percentComplete: data.async_percent_completion ?? 0,
    ready: status === 'Job Completed',
    // Both are terminal failures and must not be polled forever.
    failed: status === 'Job Failed' || status === 'Job Skipped',
  };
}

export async function fetchAsyncReportRows(args: {
  accessToken: string;
  reportRunId: string;
  level: InsightsLevel;
  maxPages?: number;
}): Promise<GetInsightsResult> {
  const maxPages = args.maxPages ?? 100;
  const rows: MetaInsightRow[] = [];
  let skipped = 0;
  let after: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const { data } = await graphRequest<{
      data?: RawInsightRow[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>({
      path: `/${args.reportRunId}/insights`,
      accessToken: args.accessToken,
      params: { limit: 500, ...(after ? { after } : {}) },
      fallbackError: 'Could not read the Meta insights report.',
    });

    for (const raw of data.data ?? []) {
      const mapped = mapRow(raw, args.level);
      if (mapped) rows.push(mapped);
      else skipped++;
    }

    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { rows, truncated, skipped };
}

/**
 * Start a report, wait for it, return the rows.
 *
 * Bounded by `timeoutMs` rather than looping forever: this runs inside a
 * job, and a report Meta never finishes must not pin a worker.
 */
export async function runAsyncInsightsReport(args: {
  accessToken: string;
  adAccountId: string;
  level: InsightsLevel;
  since: string;
  until: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<GetInsightsResult> {
  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = args.pollIntervalMs ?? 3000;

  const { reportRunId } = await startAsyncInsightsReport(args);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getAsyncReportStatus({
      accessToken: args.accessToken,
      reportRunId,
    });

    if (status.ready) {
      return fetchAsyncReportRows({
        accessToken: args.accessToken,
        reportRunId,
        level: args.level,
      });
    }

    if (status.failed) {
      throw new MetaApiError(
        `Meta could not build the insights report (${status.status}).`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new MetaApiError(
    'The Meta insights report did not finish in time. Try a shorter date range.',
  );
}

// ============================================================
// Result attribution
//
// Which action type is "the result" depends on the objective. Kept as
// data next to the transport because both the sync and the UI need the
// same answer, and because Meta's action-type vocabulary is the kind of
// thing that gains a member without warning.
// ============================================================

/**
 * Action types that count as a messaging conversation started.
 *
 * More than one because Meta reports CTWA results under different
 * attribution windows and has renamed this metric across versions.
 * Summing all matches would double-count, so `resultCount` takes the
 * FIRST that is present, in this order of preference.
 */
export const CONVERSATION_ACTION_TYPES = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.total_messaging_connection',
  'messaging_conversation_started_7d',
] as const;

export const RESULT_ACTION_TYPES: Record<string, readonly string[]> = {
  click_to_whatsapp: CONVERSATION_ACTION_TYPES,
  website_to_whatsapp: ['link_click', 'landing_page_view'],
  whatsapp_status: ['link_click'],
  website: ['offsite_conversion.fb_pixel_purchase', 'link_click'],
  lead_form: ['lead', 'onsite_conversion.lead_grouped'],
};

/**
 * The headline result count for an ad type, from an `actions` array.
 *
 * Returns the first matching action type rather than the sum: the
 * candidates are alternative names and attribution windows for the SAME
 * event, so adding them together would multiply the result.
 */
export function resultCount(
  actions: MetaActionRow[] | null | undefined,
  adType: string,
): number {
  if (!actions?.length) return 0;
  const candidates = RESULT_ACTION_TYPES[adType];
  if (!candidates) return 0;

  for (const type of candidates) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) {
      const n = Number(hit.value);
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
  }
  return 0;
}
