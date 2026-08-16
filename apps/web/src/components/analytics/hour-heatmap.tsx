'use client'

import { useMemo } from 'react'

import { DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import type { HeatCell } from '@/lib/analytics/types'

/**
 * When customers actually message, as a day × hour grid.
 *
 * Buckets are computed server-side in the viewer's timezone (migration
 * 089 takes `p_tz`), so "busiest at 8pm" means 8pm where the business
 * is — not 8pm UTC, which is a fact nobody can staff against.
 */
export function HourHeatmap({
  cells,
  accent,
  /** 'inbound' is the useful default: staffing follows customers, not us. */
  metric = 'inbound',
}: {
  cells: HeatCell[]
  accent: string
  metric?: 'inbound' | 'outbound'
}) {
  const { grid, max, busiest } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
    let m = 0
    for (const c of cells) {
      if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue
      const v = metric === 'inbound' ? c.inbound : c.outbound
      g[c.dow][c.hour] += v
      if (g[c.dow][c.hour] > m) m = g[c.dow][c.hour]
    }
    // Hour-of-day totals across the week, for the "busiest" summary.
    let bestHour = 0
    let bestTotal = 0
    for (let h = 0; h < 24; h++) {
      let t = 0
      for (let d = 0; d < 7; d++) t += g[d][h]
      if (t > bestTotal) {
        bestTotal = t
        bestHour = h
      }
    }
    return { grid: g, max: m, busiest: bestTotal > 0 ? bestHour : null }
  }, [cells, metric])

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          {/* Hour ruler — every third hour, so the labels never collide. */}
          <div className="mb-1 flex pl-9">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="flex-1 text-center text-[9px] text-muted-foreground">
                {h % 3 === 0 ? h : ''}
              </div>
            ))}
          </div>

          {grid.map((row, dow) => (
            <div key={dow} className="mb-0.5 flex items-center">
              <div className="w-9 shrink-0 pr-2 text-right text-[10px] text-muted-foreground">
                {DOW_SHORT_MON_FIRST[dow]}
              </div>
              {row.map((value, hour) => (
                <div key={hour} className="flex-1 px-[1px]">
                  <div
                    className="h-5 rounded-[3px] border border-border/40"
                    style={{
                      // A flat opacity ramp makes small counts invisible
                      // next to one big spike; the square root keeps the
                      // quiet hours legible while the peak still reads
                      // as the peak.
                      backgroundColor: accent,
                      opacity: max === 0 ? 0.05 : 0.06 + 0.94 * Math.sqrt(value / max),
                    }}
                    title={`${DOW_SHORT_MON_FIRST[dow]} ${String(hour).padStart(2, '0')}:00 — ${value.toLocaleString()} ${metric}`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {busiest === null
            ? 'No messages in this period'
            : `Busiest around ${String(busiest).padStart(2, '0')}:00`}
        </span>
        <span className="flex items-center gap-1.5">
          Less
          {[0.1, 0.35, 0.6, 0.85, 1].map((o) => (
            <span
              key={o}
              className="inline-block h-2.5 w-2.5 rounded-[2px] border border-border/40"
              style={{ backgroundColor: accent, opacity: o }}
            />
          ))}
          More
        </span>
      </div>
    </div>
  )
}
