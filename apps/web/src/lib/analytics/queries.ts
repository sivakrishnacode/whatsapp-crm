/**
 * The only place the analytics RPCs from migration 089 are called.
 *
 * Every function takes an already-resolved `accountId`. That is not an
 * authority — the RPCs are SECURITY DEFINER and carry their own
 * `analytics_guard()` check, which refuses an account the caller is not
 * a member of. Passing a foreign id here produces a database error, not
 * another workspace's numbers.
 *
 * Row mapping (snake_case → camelCase) happens here and nowhere else.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { stripToRpcFilters } from './filters'
import type { DateRange } from './range'
import { viewerTimeZone } from './range'
import type {
  AnalyticsChannel,
  AnalyticsFilters,
  BroadcastStat,
  ChannelAlert,
  ChannelKpis,
  CommercePoint,
  CtwaStat,
  HeatCell,
  IgCommentPoint,
  IgFunnelStat,
  IgPostStat,
  LeadPoint,
  TemplateStat,
  TopContact,
  TopProduct,
  VolumePoint,
  WebSessionPoint,
  WebSourceRow,
} from './types'

type DB = SupabaseClient

/**
 * Supabase error objects carry non-enumerable properties, so
 * `console.error(error)` prints `{}`. Always go through this.
 */
function rpcError(fn: string, error: unknown): Error {
  const e = error as { message?: string; code?: string; details?: string; hint?: string } | null
  const missing = e?.code === 'PGRST202'
  console.error(
    `[analytics] ${fn} failed${missing ? ' — function not found, apply migration 089' : ''}:`,
    { message: e?.message, code: e?.code, details: e?.details, hint: e?.hint },
  )
  return new Error(e?.message ?? `${fn} failed`)
}

export async function resolveAccountId(db: DB): Promise<string | null> {
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return null
  const { data } = await db
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  return (data as { account_id: string } | null)?.account_id ?? null
}

// Postgres returns BIGINT as a string over PostgREST when it exceeds
// the JS safe-integer range, and NUMERIC as a string always. Coerce
// once, here, so no chart has to think about it.
const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

const bounds = (range: DateRange) => ({
  p_start: range.start.toISOString(),
  p_end: range.end.toISOString(),
})

// ------------------------------------------------------------
// Channel-generic
// ------------------------------------------------------------

export async function loadKpis(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
  range: DateRange,
  filters: AnalyticsFilters,
): Promise<ChannelKpis> {
  const { data, error } = await db.rpc('get_channel_kpis', {
    p_account_id: accountId,
    p_channel: channel,
    ...bounds(range),
    p_filters: stripToRpcFilters(filters),
  })
  if (error) throw rpcError('get_channel_kpis', error)

  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  const pair = (cur: string, prev: string) => ({
    current: num(r?.[cur]),
    previous: num(r?.[prev]),
  })
  return {
    msgsOut: pair('msgs_out', 'prev_msgs_out'),
    msgsIn: pair('msgs_in', 'prev_msgs_in'),
    delivered: pair('delivered', 'prev_delivered'),
    read: pair('read_count', 'prev_read_count'),
    failed: pair('failed', 'prev_failed'),
    convsNew: pair('convs_new', 'prev_convs_new'),
    convsActive: pair('convs_active', 'prev_convs_active'),
    contactsNew: pair('contacts_new', 'prev_contacts_new'),
    aiReplies: pair('ai_replies', 'prev_ai_replies'),
    humanReplies: pair('human_replies', 'prev_human_replies'),
    handoffs: pair('handoffs', 'prev_handoffs'),
    avgResponseMinutes: {
      current: numOrNull(r?.avg_response_minutes),
      previous: numOrNull(r?.prev_avg_response_minutes),
    },
  }
}

export async function loadVolume(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
  range: DateRange,
  filters: AnalyticsFilters,
): Promise<VolumePoint[]> {
  const { data, error } = await db.rpc('get_channel_series', {
    p_account_id: accountId,
    p_channel: channel,
    ...bounds(range),
    p_tz: viewerTimeZone(),
    p_filters: stripToRpcFilters(filters),
  })
  if (error) throw rpcError('get_channel_series', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    incoming: num(r.incoming),
    outgoing: num(r.outgoing),
    delivered: num(r.delivered),
    read: num(r.read_count),
    failed: num(r.failed),
  }))
}

export async function loadHeatmap(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
  range: DateRange,
): Promise<HeatCell[]> {
  const { data, error } = await db.rpc('get_channel_heatmap', {
    p_account_id: accountId,
    p_channel: channel,
    ...bounds(range),
    p_tz: viewerTimeZone(),
  })
  if (error) throw rpcError('get_channel_heatmap', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    dow: num(r.dow),
    hour: num(r.hour),
    inbound: num(r.inbound),
    outbound: num(r.outbound),
  }))
}

export async function loadLeads(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
  range: DateRange,
): Promise<LeadPoint[]> {
  const { data, error } = await db.rpc('get_channel_leads', {
    p_account_id: accountId,
    p_channel: channel,
    ...bounds(range),
    p_tz: viewerTimeZone(),
  })
  if (error) throw rpcError('get_channel_leads', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    contacts: num(r.contacts),
    deals: num(r.deals),
    dealsWon: num(r.deals_won),
    dealValue: num(r.deal_value),
    wonValue: num(r.won_value),
  }))
}

export async function loadTopContacts(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
  range: DateRange,
  limit = 8,
): Promise<TopContact[]> {
  const { data, error } = await db.rpc('get_channel_top_contacts', {
    p_account_id: accountId,
    p_channel: channel,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_channel_top_contacts', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    contactId: String(r.contact_id),
    name: (r.name as string) ?? null,
    handle: (r.handle as string) ?? null,
    inbound: num(r.inbound),
    outbound: num(r.outbound),
    lastAt: (r.last_at as string) ?? null,
  }))
}

export async function loadAlerts(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
): Promise<ChannelAlert[]> {
  const { data, error } = await db.rpc('get_channel_alerts', {
    p_account_id: accountId,
    p_channel: channel,
  })
  if (error) throw rpcError('get_channel_alerts', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    kind: String(r.kind),
    severity: r.severity === 'error' ? 'error' : 'warn',
    count: num(r.count),
    detail: (r.detail as string) ?? null,
  }))
}

// ------------------------------------------------------------
// WhatsApp
// ------------------------------------------------------------

export async function loadBroadcastStats(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 25,
): Promise<BroadcastStat[]> {
  const { data, error } = await db.rpc('get_wa_broadcast_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_wa_broadcast_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    broadcastId: String(r.broadcast_id),
    name: String(r.name ?? 'Untitled'),
    templateName: String(r.template_name ?? ''),
    status: String(r.status ?? 'draft'),
    createdAt: (r.created_at as string) ?? null,
    scheduledAt: (r.scheduled_at as string) ?? null,
    recipients: num(r.recipients),
    sent: num(r.sent),
    delivered: num(r.delivered),
    read: num(r.read_count),
    replied: num(r.replied),
    failed: num(r.failed),
  }))
}

export async function loadTemplateStats(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 15,
): Promise<TemplateStat[]> {
  const { data, error } = await db.rpc('get_wa_template_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_wa_template_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    templateName: String(r.template_name ?? ''),
    category: (r.category as string) ?? null,
    status: (r.status as string) ?? null,
    qualityScore: (r.quality_score as string) ?? null,
    sends: num(r.sends),
    delivered: num(r.delivered),
    read: num(r.read_count),
    failed: num(r.failed),
  }))
}

export async function loadCommerce(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<CommercePoint[]> {
  const { data, error } = await db.rpc('get_wa_commerce_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_tz: viewerTimeZone(),
  })
  if (error) throw rpcError('get_wa_commerce_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    orders: num(r.orders),
    revenue: num(r.revenue),
    pending: num(r.pending),
    currency: (r.currency as string) ?? null,
  }))
}

export async function loadTopProducts(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 8,
): Promise<TopProduct[]> {
  const { data, error } = await db.rpc('get_wa_top_products', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_wa_top_products', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    retailerId: String(r.retailer_id ?? 'unknown'),
    title: (r.title as string) ?? null,
    units: num(r.units),
    revenue: num(r.revenue),
  }))
}

export async function loadCtwa(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 15,
): Promise<CtwaStat[]> {
  const { data, error } = await db.rpc('get_wa_ctwa_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_wa_ctwa_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    campaignId: String(r.campaign_id),
    name: String(r.name ?? 'Untitled'),
    status: String(r.status ?? 'active'),
    clicks: num(r.clicks),
    conversations: num(r.conversations),
    converted: num(r.converted),
  }))
}

// ------------------------------------------------------------
// Instagram
// ------------------------------------------------------------

export async function loadIgComments(
  db: DB,
  accountId: string,
  range: DateRange,
  mediaId?: string,
): Promise<IgCommentPoint[]> {
  const { data, error } = await db.rpc('get_ig_comment_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_tz: viewerTimeZone(),
    p_media_id: mediaId ?? null,
  })
  if (error) throw rpcError('get_ig_comment_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    received: num(r.received),
    replied: num(r.replied),
    open: num(r.open_count),
    hidden: num(r.hidden),
    privateReplies: num(r.private_replies),
  }))
}

export async function loadIgFunnels(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 15,
): Promise<IgFunnelStat[]> {
  const { data, error } = await db.rpc('get_ig_funnel_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_ig_funnel_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    funnelId: String(r.funnel_id),
    name: String(r.name ?? 'Untitled'),
    isActive: Boolean(r.is_active),
    matched: num(r.matched),
    awaitingOptin: num(r.awaiting_optin),
    awaitingFollow: num(r.awaiting_follow),
    delivered: num(r.delivered),
    failed: num(r.failed),
    wasFollowing: num(r.was_following),
  }))
}

export async function loadIgPosts(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 10,
): Promise<IgPostStat[]> {
  const { data, error } = await db.rpc('get_ig_post_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_ig_post_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    igMediaId: String(r.ig_media_id),
    permalink: (r.permalink as string) ?? null,
    thumbnailUrl: (r.thumbnail_url as string) ?? null,
    caption: (r.caption as string) ?? null,
    mediaProductType: (r.media_product_type as string) ?? null,
    postedAt: (r.posted_at as string) ?? null,
    likeCount: numOrNull(r.like_count),
    commentsTotal: numOrNull(r.comments_total),
    commentsInRange: num(r.comments_in_range),
    dmsStarted: num(r.dms_started),
  }))
}

// ------------------------------------------------------------
// Web
// ------------------------------------------------------------

export async function loadWebSessions(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<WebSessionPoint[]> {
  const { data, error } = await db.rpc('get_web_session_stats', {
    p_account_id: accountId,
    ...bounds(range),
    p_tz: viewerTimeZone(),
  })
  if (error) throw rpcError('get_web_session_stats', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    sessions: num(r.sessions),
    visitors: num(r.visitors),
    withConversation: num(r.with_conversation),
    identified: num(r.identified),
    pagesViewed: num(r.pages_viewed),
  }))
}

export async function loadWebSources(
  db: DB,
  accountId: string,
  range: DateRange,
  limit = 8,
): Promise<WebSourceRow[]> {
  const { data, error } = await db.rpc('get_web_top_sources', {
    p_account_id: accountId,
    ...bounds(range),
    p_limit: limit,
  })
  if (error) throw rpcError('get_web_top_sources', error)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    dimension: r.dimension as WebSourceRow['dimension'],
    label: String(r.label ?? '(unknown)'),
    sessions: num(r.sessions),
    conversations: num(r.conversations),
  }))
}

// ------------------------------------------------------------
// Connection state — decides between the connect CTA and honest zeros
// ------------------------------------------------------------

const CONFIG_TABLE: Record<AnalyticsChannel, string> = {
  whatsapp: 'whatsapp_config',
  instagram: 'instagram_config',
  web: 'web_config',
}

/**
 * Whether the channel is connected at all.
 *
 * ⚠️ Fails OPEN (returns `true`) when the lookup itself errors. A
 * broken config read must not replace a working dashboard with a
 * "connect your channel" screen for an account that plainly is
 * connected — the same reasoning as the `/welcome` gate.
 */
export async function loadIsConnected(
  db: DB,
  accountId: string,
  channel: AnalyticsChannel,
): Promise<boolean> {
  const { data, error } = await db
    .from(CONFIG_TABLE[channel])
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[analytics] connection check failed:', error.message)
    return true
  }
  if (!data) return false
  return (data as { status: string | null }).status === 'connected'
}
