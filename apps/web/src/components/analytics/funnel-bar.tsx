'use client'

import { cn } from '@/lib/utils'

export interface FunnelStep {
  key: string
  label: string
  value: number
  color: string
}

/**
 * A stepped funnel — sent → delivered → read → replied, or
 * clicks → conversations → converted.
 *
 * ⚠️ Each step's percentage is of the FIRST step, not of the step
 * before it. Both are defensible, but only one can be shown, and
 * "72% read" meaning 72% of everyone sent is what people assume when
 * they glance at a funnel. The step-over-step rate is in the tooltip
 * for anyone who wants it.
 */
export function FunnelBar({
  steps,
  className,
}: {
  steps: FunnelStep[]
  className?: string
}) {
  const base = steps[0]?.value ?? 0

  return (
    <div className={cn('space-y-2.5', className)}>
      {steps.map((step, i) => {
        const pctOfFirst = base === 0 ? 0 : (step.value / base) * 100
        const prev = i > 0 ? steps[i - 1].value : null
        const pctOfPrev = prev && prev > 0 ? (step.value / prev) * 100 : null
        return (
          <div key={step.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">{step.label}</span>
              <span className="shrink-0 tabular-nums text-foreground">
                <span className="font-medium">{step.value.toLocaleString()}</span>
                {base > 0 && (
                  <span className="ml-1.5 text-muted-foreground">{pctOfFirst.toFixed(0)}%</span>
                )}
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              title={
                pctOfPrev === null
                  ? undefined
                  : `${pctOfPrev.toFixed(1)}% of the previous step`
              }
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${Math.max(pctOfFirst, base > 0 && step.value > 0 ? 1.5 : 0)}%`, backgroundColor: step.color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
