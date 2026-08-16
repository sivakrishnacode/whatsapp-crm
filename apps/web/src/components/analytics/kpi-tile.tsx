'use client'

import type { ComponentType } from 'react'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/dashboard/skeleton'
import { percentChange } from '@/lib/analytics/range'
import { Sparkline } from './sparkline'

export interface KpiTileProps {
  label: string
  /** Pre-formatted headline value — "12,480", "98.1%", "₹4,200". */
  value: string
  icon?: ComponentType<{ className?: string }>
  current?: number
  previous?: number
  /** "vs previous 30 days". Rendered next to the delta. */
  comparisonLabel?: string
  /** Daily values driving the sparkline. Omit to hide it. */
  trend?: number[]
  accent: string
  /**
   * Set for metrics where DOWN is good — failures, response time.
   * Only the colour flips; the arrow still points the way the number
   * moved, because an arrow that lies about direction is worse than
   * no arrow.
   */
  invertDelta?: boolean
  /** Shown instead of the delta row. */
  hint?: string
  onClick?: () => void
  active?: boolean
}

export function KpiTile({
  label,
  value,
  icon: Icon,
  current,
  previous,
  comparisonLabel,
  trend,
  accent,
  invertDelta,
  hint,
  onClick,
  active,
}: KpiTileProps) {
  const pct =
    current !== undefined && previous !== undefined ? percentChange(current, previous) : null
  const delta = current !== undefined && previous !== undefined ? current - previous : 0

  const Wrapper = onClick ? 'button' : 'div'

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border bg-card p-4 text-left transition-colors',
        active ? 'border-transparent ring-2' : 'border-border',
        onClick && 'hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
      style={active ? ({ '--tw-ring-color': accent } as React.CSSProperties) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </div>

      <p className="mt-2 text-2xl leading-none font-bold tabular-nums text-foreground">{value}</p>

      {hint ? (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{hint}</p>
      ) : current !== undefined && previous !== undefined ? (
        <DeltaRow
          pct={pct}
          delta={delta}
          invert={invertDelta}
          comparisonLabel={comparisonLabel}
        />
      ) : (
        <div className="mt-1.5 h-[15px]" />
      )}

      {trend && trend.length > 1 && (
        <div className="-mx-4 -mb-4 mt-2">
          <Sparkline values={trend} color={accent} className="w-full" height={30} />
        </div>
      )}
    </Wrapper>
  )
}

function DeltaRow({
  pct,
  delta,
  invert,
  comparisonLabel,
}: {
  pct: number | null
  delta: number
  invert?: boolean
  comparisonLabel?: string
}) {
  // No prior data is a real, common state on a young workspace.
  // Showing "+100%" or "∞" there is a lie dressed as a metric.
  if (pct === null) {
    return (
      <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
        {delta === 0 ? 'No prior data' : `${delta > 0 ? '+' : ''}${delta.toLocaleString()} — no prior data`}
      </p>
    )
  }

  const rising = delta > 0
  const flat = delta === 0
  const good = invert ? !rising : rising
  const tone = flat
    ? 'text-muted-foreground'
    : good
      ? 'text-accent-green'
      : 'text-accent-red'
  const Arrow = flat ? Minus : rising ? ArrowUp : ArrowDown

  return (
    <p className={cn('mt-1.5 flex items-center gap-1 truncate text-[11px]', tone)}>
      <Arrow className="h-3 w-3 shrink-0" aria-hidden />
      <span className="tabular-nums">
        {Math.abs(pct) >= 999 ? '>999' : Math.abs(pct).toFixed(1)}%
      </span>
      {comparisonLabel && (
        <span className="truncate text-muted-foreground">{comparisonLabel}</span>
      )}
    </p>
  )
}

export function KpiTileSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-16" />
      <Skeleton className="mt-2 h-3 w-20" />
      <Skeleton className="mt-3 h-[30px] w-full" />
    </div>
  )
}
