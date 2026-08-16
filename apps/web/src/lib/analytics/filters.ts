/**
 * Cross-filter state: the chips in the header, the URL they live in,
 * and the JSONB the RPCs actually receive.
 *
 * Filters round-trip through the query string so a filtered view is a
 * link someone can paste into a thread. That makes every value
 * ATTACKER-SUPPLIED as far as this module is concerned — `parseFilters`
 * validates each one against a closed vocabulary and drops anything it
 * does not recognise, rather than forwarding it to the database.
 */

import type { AnalyticsFilters } from './types'

const STATUSES = ['sent', 'delivered', 'read', 'failed'] as const
const DIRECTIONS = ['in', 'out'] as const
const AGENTS = ['ai', 'human'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Query-string keys, kept short because they are typed by humans. */
const PARAM = {
  status: 'status',
  direction: 'dir',
  agent: 'by',
  template: 'tpl',
  broadcastId: 'bc',
  mediaId: 'post',
  funnelId: 'funnel',
} as const

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) return undefined
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

function uuid(value: string | null): string | undefined {
  if (!value) return undefined
  return UUID_RE.test(value) ? value : undefined
}

/** Read filters out of a URLSearchParams, discarding anything invalid. */
export function parseFilters(params: URLSearchParams): AnalyticsFilters {
  const template = params.get(PARAM.template)?.trim()
  const mediaId = params.get(PARAM.mediaId)?.trim()
  return {
    status: oneOf(params.get(PARAM.status), STATUSES),
    direction: oneOf(params.get(PARAM.direction), DIRECTIONS),
    agent: oneOf(params.get(PARAM.agent), AGENTS),
    // Template names are free text from Meta; cap the length so a
    // pasted URL cannot push a megabyte through the RPC.
    template: template && template.length <= 512 ? template : undefined,
    broadcastId: uuid(params.get(PARAM.broadcastId)),
    // Instagram media ids are numeric strings, not UUIDs.
    mediaId: mediaId && /^\d{1,32}$/.test(mediaId) ? mediaId : undefined,
    funnelId: uuid(params.get(PARAM.funnelId)),
  }
}

/** Serialise filters back into a query string (stable key order). */
export function serialiseFilters(filters: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of Object.keys(PARAM) as (keyof typeof PARAM)[]) {
    const value = filters[key]
    if (value) params.set(PARAM[key], value)
  }
  return params
}

/**
 * The subset that goes into `p_filters` on the message-based RPCs.
 *
 * `mediaId` and `funnelId` are deliberately excluded: they are not
 * message filters at all, and the SQL would silently ignore them. They
 * travel as their own RPC arguments instead.
 */
export function stripToRpcFilters(filters: AnalyticsFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.status) out.status = filters.status
  if (filters.direction) out.direction = filters.direction
  if (filters.agent) out.agent = filters.agent
  if (filters.template) out.template = filters.template
  if (filters.broadcastId) out.broadcastId = filters.broadcastId
  return out
}

export function hasAnyFilter(filters: AnalyticsFilters): boolean {
  return Object.values(filters).some(Boolean)
}

export function withoutFilter(
  filters: AnalyticsFilters,
  key: keyof AnalyticsFilters,
): AnalyticsFilters {
  const next = { ...filters }
  delete next[key]
  return next
}

/**
 * Toggle semantics: clicking the chart segment you already filtered by
 * clears it. Without this, the only way out of a filter is the chip's
 * ✕, and clicking the same bar twice looks broken.
 */
export function toggleFilter<K extends keyof AnalyticsFilters>(
  filters: AnalyticsFilters,
  key: K,
  value: NonNullable<AnalyticsFilters[K]>,
): AnalyticsFilters {
  if (filters[key] === value) return withoutFilter(filters, key)
  return { ...filters, [key]: value }
}

/** Chip labels. `resolve` supplies display names for id-shaped filters. */
export function describeFilters(
  filters: AnalyticsFilters,
  resolve: (key: keyof AnalyticsFilters, value: string) => string | undefined = () => undefined,
): { key: keyof AnalyticsFilters; label: string; value: string }[] {
  const out: { key: keyof AnalyticsFilters; label: string; value: string }[] = []
  const push = (key: keyof AnalyticsFilters, prefix: string, fallback?: string) => {
    const value = filters[key]
    if (!value) return
    out.push({ key, value, label: `${prefix}: ${resolve(key, value) ?? fallback ?? value}` })
  }
  push('status', 'Status')
  push('direction', 'Direction', filters.direction === 'in' ? 'Incoming' : 'Outgoing')
  push('agent', 'Sent by', filters.agent === 'ai' ? 'AI agent' : 'Teammate')
  push('template', 'Template')
  push('broadcastId', 'Broadcast')
  push('mediaId', 'Post')
  push('funnelId', 'Funnel')
  return out
}
