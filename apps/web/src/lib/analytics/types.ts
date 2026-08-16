/**
 * Result shapes for the per-channel analytics pages.
 *
 * These mirror migration 089's RPC return columns one-for-one, in
 * camelCase. The mapping happens once, in `queries.ts` — no component
 * ever reads a snake_case key, so a column rename is a single-file
 * change.
 */

/**
 * The channels that have an analytics page. A subset of `ChannelId`
 * (lib/nav/channels.ts): 'phone' is locked and has no conversations,
 * so it has no numbers to show.
 */
export type AnalyticsChannel = 'whatsapp' | 'instagram' | 'web'

/**
 * A metric and the same metric over the immediately preceding window
 * of equal length. Both come from one RPC call so the two can never
 * describe different ranges.
 */
export interface KpiPair {
  current: number
  previous: number
}

/** Averages are null when there were no samples — not zero. */
export interface KpiAvgPair {
  current: number | null
  previous: number | null
}

export interface ChannelKpis {
  msgsOut: KpiPair
  msgsIn: KpiPair
  delivered: KpiPair
  read: KpiPair
  failed: KpiPair
  convsNew: KpiPair
  convsActive: KpiPair
  contactsNew: KpiPair
  aiReplies: KpiPair
  humanReplies: KpiPair
  handoffs: KpiPair
  avgResponseMinutes: KpiAvgPair
}

export interface VolumePoint {
  /** YYYY-MM-DD in the viewer's timezone. */
  day: string
  incoming: number
  outgoing: number
  delivered: number
  read: number
  failed: number
}

export interface HeatCell {
  /** 0 = Mon … 6 = Sun. */
  dow: number
  /** 0 … 23. */
  hour: number
  inbound: number
  outbound: number
}

export interface LeadPoint {
  day: string
  contacts: number
  deals: number
  dealsWon: number
  dealValue: number
  wonValue: number
}

export interface TopContact {
  contactId: string
  name: string | null
  handle: string | null
  inbound: number
  outbound: number
  lastAt: string | null
}

export interface BroadcastStat {
  broadcastId: string
  name: string
  templateName: string
  status: string
  createdAt: string | null
  scheduledAt: string | null
  recipients: number
  sent: number
  delivered: number
  read: number
  replied: number
  failed: number
}

export interface TemplateStat {
  templateName: string
  category: string | null
  /** Meta approval status — APPROVED / PENDING / REJECTED. Null when the template is no longer in the library. */
  status: string | null
  qualityScore: string | null
  sends: number
  delivered: number
  read: number
  failed: number
}

export interface CommercePoint {
  day: string
  orders: number
  revenue: number
  pending: number
  currency: string | null
}

export interface TopProduct {
  retailerId: string
  title: string | null
  units: number
  revenue: number
}

export interface CtwaStat {
  campaignId: string
  name: string
  status: string
  clicks: number
  conversations: number
  converted: number
}

export interface IgCommentPoint {
  day: string
  received: number
  replied: number
  open: number
  hidden: number
  privateReplies: number
}

export interface IgFunnelStat {
  funnelId: string
  name: string
  isActive: boolean
  matched: number
  awaitingOptin: number
  awaitingFollow: number
  delivered: number
  failed: number
  wasFollowing: number
}

export interface IgPostStat {
  igMediaId: string
  permalink: string | null
  thumbnailUrl: string | null
  caption: string | null
  mediaProductType: string | null
  postedAt: string | null
  likeCount: number | null
  /** Instagram's own lifetime total, including comments from before we connected. */
  commentsTotal: number | null
  /** What we recorded inside the selected range. */
  commentsInRange: number
  dmsStarted: number
}

export interface WebSessionPoint {
  day: string
  sessions: number
  visitors: number
  withConversation: number
  identified: number
  pagesViewed: number
}

export interface WebSourceRow {
  dimension: 'page' | 'referrer' | 'country'
  label: string
  sessions: number
  conversations: number
}

/**
 * Something the page can offer to FIX. Rows only exist when something
 * is wrong, so an empty array is a healthy channel — the strip renders
 * nothing rather than a reassuring "all good" banner nobody reads.
 */
export interface ChannelAlert {
  kind: string
  severity: 'error' | 'warn'
  count: number
  detail: string | null
}

/**
 * Cross-filters. Every widget on the page re-queries with these
 * applied, and they round-trip through the URL so a filtered view is
 * shareable.
 *
 * Keys map 1:1 onto migration 089's `p_filters` JSONB, except the
 * channel-specific `mediaId` / `funnelId`, which are passed as their
 * own RPC arguments. `stripToRpcFilters()` in `filters.ts` is what
 * decides which is which — do not hand this object to an RPC directly.
 */
export interface AnalyticsFilters {
  status?: 'sent' | 'delivered' | 'read' | 'failed'
  direction?: 'in' | 'out'
  agent?: 'ai' | 'human'
  template?: string
  broadcastId?: string
  /** Instagram only — scopes comment and post widgets to one post. */
  mediaId?: string
  /** Instagram only — scopes the funnel table to one funnel. */
  funnelId?: string
}
