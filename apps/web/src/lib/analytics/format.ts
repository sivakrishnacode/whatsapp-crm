/**
 * Display formatting shared by the analytics pages.
 *
 * Every function here answers the same question the same way on all
 * three channels, which is what stops "98.1%" on one page meaning
 * something subtly different from "98.1%" on another.
 */

/**
 * A rate as a percentage string.
 *
 * ⚠️ Returns an em dash, not "0%", when the denominator is zero. A
 * delivery rate of 0% reads as "everything failed"; no sends at all is
 * a different fact and must look different.
 */
export function rate(numerator: number, denominator: number, digits = 1): string {
  if (denominator <= 0) return '—'
  return `${((numerator / denominator) * 100).toFixed(digits)}%`
}

/** The same rate as a number, for sorting and colour thresholds. */
export function rateValue(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return (numerator / denominator) * 100
}

/** "4.2 min", "1 h 12 m", "—" when there were no samples. */
export function duration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—'
  if (minutes < 1) return `${Math.round(minutes * 60)} s`
  if (minutes < 60) return `${minutes.toFixed(1)} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

export function count(n: number): string {
  return n.toLocaleString()
}

/** Short day label for chart axes — "17 Mar". */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Long day label for tooltips — "Mon, 17 Mar". */
export function dayLabelLong(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

/** Relative time for "last message" columns. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diffMin = Math.round((Date.now() - then) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.round(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.round(diffH / 24)
  if (diffD < 30) return `${diffD}d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Truncate a caption or page URL for a table cell. */
export function truncate(value: string | null, max = 60): string {
  if (!value) return '—'
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
