import type { SupabaseClient } from '@supabase/supabase-js'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// All queries. RLS scopes every query to the signed-in user
// automatically.
//
// Perf strategy: heavy aggregations (metric cards, response time,
// activity feed) are delegated to SQL RPCs added in migration 047
// (`get_dashboard_metrics`, `get_response_time_buckets`,
// `get_activity_feed`). This reduces the dashboard load from 14
// round-trips to 3.
//
// `loadConversationsSeries` and `loadPipelineDonut` remain as
// PostgREST queries because their dataset is already bounded and
// the client-side bucketing is negligible overhead.
// ------------------------------------------------------------

type DB = SupabaseClient

// Supabase error objects have non-enumerable properties — console.error
// with the raw object prints `{}`. Use this helper everywhere.
function logRpcError(fn: string, error: { message?: string; code?: string; details?: string; hint?: string } | null) {
  const isPgrstMissing = error?.code === 'PGRST202'
  console.error(
    `[dashboard] ${fn} failed${isPgrstMissing ? ' (function not found — run: npx supabase db push)' : ''}:`,
    { message: error?.message, code: error?.code, details: error?.details, hint: error?.hint },
  )
}

// --- 0. The account these queries run against --------------------
//
// ⚠️ PASSED IN, NOT RESOLVED HERE. This used to be
// `profiles.account_id` for the signed-in user, which was the only
// answer there could be. Since migration 095 a user can be in several
// workspaces and the active one is decided by ONE resolver — apps/api's
// active-workspace.ts, surfaced as `useAuth().accountId`. A second
// resolver in this file would have to reimplement that fallback chain
// (cookie → last_account_id → owned → oldest) and would disagree with
// the server on exactly the cases the chain exists for, leaving these
// charts describing one workspace while the page around them showed
// another.
//
// Every loader below therefore takes `accountId` and every caller is a
// React component that already has it. A null id means "not known yet",
// and each loader returns its empty shape rather than querying.

// --- 1. Metric cards (via RPC) ------------------------------------

export async function loadMetrics(db: DB, accountId: string | null, startDate?: string, endDate?: string): Promise<MetricsBundle> {
  const sinceTs = startDate || startOfLocalDay().toISOString()
  const rangeEnd = endDate || new Date().toISOString()

  if (!accountId) {
    return {
      activeConversations: { current: 0, previous: 0 },
      newContactsToday: { current: 0, previous: 0 },
      openDealsValue: 0,
      openDealsCount: 0,
      messagesSentToday: { current: 0, previous: 0 },
    }
  }

  const { data, error } = await db.rpc('get_dashboard_metrics', {
    p_account_id: accountId,
    p_since_ts: sinceTs,
    p_range_end: rangeEnd,
  })

  if (error || !data || !data.length) {
    logRpcError('get_dashboard_metrics', error)
    return {
      activeConversations: { current: 0, previous: 0 },
      newContactsToday: { current: 0, previous: 0 },
      openDealsValue: 0,
      openDealsCount: 0,
      messagesSentToday: { current: 0, previous: 0 },
    }
  }

  const row = data[0] as {
    active_conversations_total: number
    new_convs_in_range: number
    new_contacts_in_range: number
    open_deals_count: number
    open_deals_value: number
    messages_sent_in_range: number
    new_convs_yesterday: number
    new_contacts_yesterday: number
    messages_sent_yesterday: number
  }

  return {
    activeConversations: {
      current: row.active_conversations_total ?? 0,
      // Delta: new open conversations today vs yesterday
      previous: (row.new_convs_in_range ?? 0) - (row.new_convs_yesterday ?? 0),
    },
    newContactsToday: {
      current: row.new_contacts_in_range ?? 0,
      previous: row.new_contacts_yesterday ?? 0,
    },
    openDealsValue: row.open_deals_value ?? 0,
    openDealsCount: row.open_deals_count ?? 0,
    messagesSentToday: {
      current: row.messages_sent_in_range ?? 0,
      previous: row.messages_sent_yesterday ?? 0,
    },
  }
}

// --- 2. Conversations over time -----------------------------------
// Not migrated to an RPC: the dataset is bounded (N days × 2 sender
// types) and the JS bucketing is trivial. Left as-is.

export async function loadConversationsSeries(
  db: DB,
  accountId: string | null,
  rangeDays: number,
  startDate?: string,
  endDate?: string,
): Promise<ConversationsSeriesPoint[]> {
  const keysEmpty = lastNDayKeys(rangeDays)
  if (!accountId) {
    return keysEmpty.map((day) => ({ day, incoming: 0, outgoing: 0 }))
  }
  const start = startDate || daysAgoStart(rangeDays - 1).toISOString()
  const end = endDate || new Date().toISOString()
  // ⚠️ Scoped through the CONVERSATION. `messages` has no account_id of its
  // own — its tenancy comes from `conversations`, which is also how its RLS
  // policy is written — so the scope has to be an inner-joined embed with a
  // dotted filter, not a column on this table. Without it this counted every
  // message in every workspace the caller belonged to, and the dashboard's
  // volume chart summed an agency's clients together.
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type, conversations!inner(account_id)')
    .eq('conversations.account_id', accountId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true })
  if (error) throw error

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of (data ?? []) as { created_at: string; sender_type: string }[]) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------

export async function loadPipelineDonut(
  db: DB,
  accountId: string | null,
): Promise<PipelineDonutData> {
  if (!accountId) return { stages: [], totalValue: 0 }
  // `pipeline_stages` has no account_id of its own — it hangs off a pipeline —
  // so it is scoped through the workspace's pipelines. `deals` does carry one.
  const [pipelinesRes, dealsRes] = await Promise.all([
    db.from('pipelines').select('id').eq('account_id', accountId),
    db.from('deals').select('stage_id, value, status').eq('account_id', accountId).eq('status', 'open'),
  ])
  const pipelineIds = ((pipelinesRes.data ?? []) as { id: string }[]).map((p) => p.id)
  if (pipelineIds.length === 0) return { stages: [], totalValue: 0 }
  const stagesRes = await db
    .from('pipeline_stages')
    .select('id, name, color, pipeline_id, position')
    .in('pipeline_id', pipelineIds)
    .order('position')

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const deals = (dealsRes.data ?? []) as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time (via RPC) ----------------------------------

export async function loadResponseTime(db: DB, accountId: string | null): Promise<ResponseTimeSummary> {

  // Silence unused-import warning — kept because date-utils exports
  // it and other callers may still use it.
  void DOW_SHORT_MON_FIRST

  if (!accountId) {
    return {
      buckets: Array.from({ length: 7 }, (_, dow) => ({ dow, avgMinutes: null, samples: 0 })),
      thisWeekAvg: null,
      lastWeekAvg: null,
    }
  }

  const { data, error } = await db.rpc('get_response_time_buckets', {
    p_account_id: accountId,
    p_days: 14,
  })

  if (error) {
    logRpcError('get_response_time_buckets', error)
    return {
      buckets: Array.from({ length: 7 }, (_, dow) => ({ dow, avgMinutes: null, samples: 0 })),
      thisWeekAvg: null,
      lastWeekAvg: null,
    }
  }

  // Build a 7-slot array keyed by day-of-week (0=Mon … 6=Sun)
  const byDow = new Map<number, { avgMinutes: number; samples: number }>()
  for (const row of (data ?? []) as { dow: number; avg_minutes: number | null; sample_count: number }[]) {
    byDow.set(row.dow, {
      avgMinutes: row.avg_minutes ?? 0,
      samples: row.sample_count ?? 0,
    })
  }

  const rpcBuckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => ({
    dow,
    avgMinutes: byDow.get(dow)?.avgMinutes ?? null,
    samples: byDow.get(dow)?.samples ?? 0,
  }))

  // Derive this-week / last-week averages: two cheap parallel RPC
  // calls each returning ≤7 rows.
  const now = new Date()
  const [thisWeekRes, lastWeekRes] = await Promise.all([
    db.rpc('get_response_time_buckets', {
      p_account_id: accountId,
      p_days: mondayIndex(now) + 1,     // days from Monday to today
    }),
    db.rpc('get_response_time_buckets', {
      p_account_id: accountId,
      p_days: mondayIndex(now) + 8,     // back to cover last Mon–Sun
    }),
  ])

  const avgOfRows = (rows: { avg_minutes: number | null; sample_count: number }[]) => {
    const totalSamples = rows.reduce((s, r) => s + (r.sample_count ?? 0), 0)
    if (totalSamples === 0) return null
    const weightedSum = rows.reduce(
      (s, r) => s + (r.avg_minutes ?? 0) * (r.sample_count ?? 0),
      0,
    )
    return weightedSum / totalSamples
  }

  const thisWeekAvg = avgOfRows(
    (thisWeekRes.data ?? []) as { avg_minutes: number | null; sample_count: number }[],
  )
  const lastWeekAvg = avgOfRows(
    (lastWeekRes.data ?? []) as { avg_minutes: number | null; sample_count: number }[],
  )

  return { buckets: rpcBuckets, thisWeekAvg, lastWeekAvg }
}

// --- 5. Activity feed (via RPC) ----------------------------------

export async function loadActivity(db: DB, accountId: string | null, limit = 20): Promise<ActivityItem[]> {
  if (!accountId) return []

  const { data, error } = await db.rpc('get_activity_feed', {
    p_account_id: accountId,
    p_limit: limit,
  })

  if (error) {
    logRpcError('get_activity_feed', error)
    return []
  }

  return (
    (data ?? []) as {
      id: string
      kind: string
      text: string
      at: string
      href: string | null
    }[]
  ).map((row) => ({
    id: row.id,
    kind: row.kind as ActivityItem['kind'],
    text: row.text,
    at: row.at,
    ...(row.href ? { href: row.href } : {}),
  }))
}
