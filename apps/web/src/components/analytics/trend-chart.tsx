'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

export interface TrendSeries {
  key: string
  label: string
  color: string
  values: number[]
  /** Fill the area under the line with a fade of `color`. */
  area?: boolean
  /** Render dashed — for secondary/comparison series. */
  dashed?: boolean
}

const VB_W = 760
const VB_H = 240
const PAD = { top: 16, right: 16, bottom: 26, left: 42 }

/**
 * The multi-series area/line chart the analytics pages are built on.
 *
 * Hand-rolled SVG rather than a chart library, matching
 * `components/dashboard/conversations-chart.tsx`: it keeps the app's
 * one charting idiom, uses theme tokens for every non-brand colour so
 * light and dark both work, and adds no bundle weight.
 */
export function TrendChart({
  labels,
  series,
  className,
  height = 240,
  /** Formats the tooltip's header — usually a date. */
  formatLabel = (l: string) => l,
  formatValue = (v: number) => v.toLocaleString(),
}: {
  /** One label per x position; must match every series' length. */
  labels: string[]
  series: TrendSeries[]
  className?: string
  height?: number
  formatLabel?: (label: string) => string
  formatValue?: (value: number) => string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ idx: number; leftPx: number } | null>(null)

  const { maxY, ticks } = useMemo(() => {
    const max = series.reduce(
      (m, s) => s.values.reduce((mm, v) => Math.max(mm, v), m),
      0,
    )
    const ceil = niceCeil(max)
    return {
      maxY: ceil,
      ticks: Array.from(new Set([0, ceil / 4, ceil / 2, (ceil * 3) / 4, ceil].map(Math.round))),
    }
  }, [series])

  const chartW = VB_W - PAD.left - PAD.right
  const chartH = VB_H - PAD.top - PAD.bottom
  const n = labels.length
  const stepX = n > 1 ? chartW / (n - 1) : 0
  const xFor = (i: number) => PAD.left + i * stepX
  const yFor = (v: number) =>
    maxY === 0 ? PAD.top + chartH : PAD.top + chartH - (v / maxY) * chartH

  // Map pointer position back through the SVG's screen CTM rather than
  // measuring the DOM rect: the default preserveAspectRatio
  // letterboxes the viewBox on wide containers, and rect-based math
  // snaps to the wrong point by hundreds of pixels there.
  useEffect(() => {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap || n === 0) return

    const onMove = (e: PointerEvent) => {
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      if (local.x < PAD.left - 8 || local.x > VB_W - PAD.right + 8) {
        setHover(null)
        return
      }
      const idx = Math.max(
        0,
        Math.min(n - 1, Math.round(stepX === 0 ? 0 : (local.x - PAD.left) / stepX)),
      )
      const marker = svg.createSVGPoint()
      marker.x = PAD.left + idx * stepX
      marker.y = 0
      const screen = marker.matrixTransform(ctm)
      setHover({ idx, leftPx: screen.x - wrap.getBoundingClientRect().left })
    }
    const onLeave = () => setHover(null)

    svg.addEventListener('pointermove', onMove)
    svg.addEventListener('pointerleave', onLeave)
    return () => {
      svg.removeEventListener('pointermove', onMove)
      svg.removeEventListener('pointerleave', onLeave)
    }
  }, [n, stepX])

  const labelStride = Math.max(1, Math.ceil(n / 7))

  return (
    <div ref={wrapRef} className={cn('relative w-full', className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        style={{ height }}
        className="w-full touch-none"
        role="img"
        aria-label={series.map((s) => s.label).join(', ')}
      >
        <defs>
          {series
            .filter((s) => s.area)
            .map((s) => (
              <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={VB_W - PAD.right}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <text
              x={PAD.left - 8}
              y={yFor(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {compact(t)}
            </text>
          </g>
        ))}

        {labels.map((l, i) =>
          i % labelStride === 0 ? (
            <text
              key={`${l}-${i}`}
              x={xFor(i)}
              y={VB_H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {formatLabel(l)}
            </text>
          ) : null,
        )}

        {/* Areas first so every line draws on top of every fill. */}
        {series
          .filter((s) => s.area)
          .map((s) => (
            <path
              key={`area-${s.key}`}
              d={`${linePath(s.values, xFor, yFor)} L${xFor(n - 1)},${PAD.top + chartH} L${xFor(0)},${PAD.top + chartH} Z`}
              fill={`url(#${uid}-${s.key})`}
              stroke="none"
            />
          ))}

        {series.map((s) => (
          <path
            key={`line-${s.key}`}
            d={linePath(s.values, xFor, yFor)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '4 4' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {hover && (
          <g pointerEvents="none">
            <line
              x1={xFor(hover.idx)}
              x2={xFor(hover.idx)}
              y1={PAD.top}
              y2={PAD.top + chartH}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
            />
            {series.map((s) => (
              <circle
                key={`dot-${s.key}`}
                cx={xFor(hover.idx)}
                cy={yFor(s.values[hover.idx] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            ))}
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: `${hover.leftPx}px` }}
        >
          <div className="font-medium text-popover-foreground">
            {formatLabel(labels[hover.idx] ?? '')}
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="tabular-nums text-popover-foreground">
                  {formatValue(s.values[hover.idx] ?? 0)}
                </span>
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChartLegend({ series }: { series: TrendSeries[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ background: s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function linePath(
  values: number[],
  xFor: (i: number) => number,
  yFor: (v: number) => number,
): string {
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(' ')
}

function compact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`
  return String(v)
}

/** Round up to 1/2/5×10ⁿ so the axis ticks land on readable numbers. */
function niceCeil(max: number): number {
  if (max <= 0) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}
