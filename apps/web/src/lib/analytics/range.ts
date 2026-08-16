/**
 * The time range every analytics widget shares.
 *
 * One rule underpins all of it: **`end` is EXCLUSIVE**. A range is
 * `[start, end)` in the viewer's local timezone, and the SQL in
 * migration 089 compares with `>= start AND < end` throughout. Using an
 * inclusive end is how "last 7 days" quietly becomes eight buckets and
 * how the previous-period comparison double-counts its boundary day.
 */

import { localDayKey, startOfLocalDay } from '@/lib/dashboard/date-utils'

/** Preset lengths offered in the header, in days. */
export const RANGE_PRESETS = [7, 30, 90] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

export interface DateRange {
  /** Inclusive lower bound, local midnight. */
  start: Date
  /** EXCLUSIVE upper bound, local midnight. */
  end: Date
  /** Whole days covered. Drives the comparison window and bucket fill. */
  days: number
  /** Preset length, or 'custom' when the dates came from the picker. */
  preset: RangePreset | 'custom'
}

/**
 * The viewer's IANA timezone, passed to every bucketing RPC. A
 * "busiest hour" in UTC is not a fact anyone can act on, so the
 * server buckets on local wall-clock time rather than the client
 * re-bucketing after the fact.
 */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * The last `days` calendar days INCLUDING today. `end` is tomorrow's
 * local midnight, so today's partial data is included and today is one
 * whole bucket.
 */
export function presetRange(days: RangePreset): DateRange {
  const end = startOfLocalDay()
  end.setDate(end.getDate() + 1)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return { start, end, days, preset: days }
}

/**
 * A custom range from two YYYY-MM-DD strings, both INCLUSIVE as the
 * user typed them — the picker says "1 Mar to 7 Mar" and the user
 * means seven days, so `end` is advanced to the 8th's midnight.
 *
 * Returns null when either date is unparseable or start is after end;
 * the caller keeps the previous range and shows an error rather than
 * querying a nonsense window.
 */
export function customRange(startKey: string, endKey: string): DateRange | null {
  const start = parseDayKey(startKey)
  const end = parseDayKey(endKey)
  if (!start || !end) return null
  if (start > end) return null
  const exclusiveEnd = new Date(end)
  exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
  const days = Math.round((exclusiveEnd.getTime() - start.getTime()) / 86_400_000)
  return { start, end: exclusiveEnd, days, preset: 'custom' }
}

function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  return d
}

/** Every local-day key in the range, chronologically. */
export function rangeDayKeys(range: DateRange): string[] {
  const keys: string[] = []
  const cursor = new Date(range.start)
  while (cursor < range.end) {
    keys.push(localDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/**
 * Pad a sparse server series out to one row per day in the range.
 *
 * The RPCs return only days that HAVE data — a day with no traffic is
 * absent, not zero. Filling happens here rather than in SQL because
 * only the client knows the requested range; a server that invented
 * zero rows would make "no rows at all" (a failed or empty query)
 * indistinguishable from "a quiet week".
 */
export function fillDays<T extends { day: string }>(
  range: DateRange,
  rows: T[],
  zero: (day: string) => T,
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  return rangeDayKeys(range).map((day) => byDay.get(day) ?? zero(day))
}

/** Human label for the header, e.g. "1 – 30 Mar 2026". */
export function rangeLabel(range: DateRange): string {
  if (range.preset !== 'custom') return `Last ${range.days} days`
  const last = new Date(range.end)
  last.setDate(last.getDate() - 1)
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${fmt.format(range.start)} – ${fmt.format(last)}`
}

/** The comparison window: the equal-length period immediately before. */
export function previousRangeLabel(range: DateRange): string {
  return `vs previous ${range.days} days`
}

/**
 * Percent change, or null when there is nothing to compare against.
 *
 * Returning null for `previous === 0` is deliberate: growth from zero
 * is not "+100%", and rendering an infinity symbol next to a real
 * number reads as a bug. The UI shows "no prior data" instead.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return ((current - previous) / previous) * 100
}
