'use client'

import { cn } from '@/lib/utils'

export interface BarRow {
  id: string
  label: string
  /** Small right-aligned text under/next to the label. */
  sublabel?: string
  value: number
  /** Pre-formatted display value. Defaults to `value.toLocaleString()`. */
  display?: string
  href?: string
}

/**
 * Ranked horizontal bars — top products, top pages, top contacts.
 *
 * Bars are scaled against the LARGEST row, not against the total: the
 * question these answer is "which is biggest", and share-of-total
 * shrinks every bar into an unreadable sliver as soon as there is a
 * long tail.
 */
export function BarList({
  rows,
  accent,
  onSelect,
  selectedId,
}: {
  rows: BarRow[]
  accent: string
  onSelect?: (row: BarRow) => void
  selectedId?: string
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1

  return (
    <ul className="space-y-1">
      {rows.map((row) => {
        const pct = (row.value / max) * 100
        const selected = selectedId === row.id
        const interactive = Boolean(onSelect)
        return (
          <li key={row.id}>
            <button
              type="button"
              disabled={!interactive}
              onClick={() => onSelect?.(row)}
              className={cn(
                'group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors',
                interactive && 'hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selected && 'bg-muted/60',
                !interactive && 'cursor-default',
              )}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-lg transition-[width]"
                style={{ width: `${pct}%`, backgroundColor: accent, opacity: selected ? 0.24 : 0.13 }}
              />
              <span className="relative min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{row.label}</span>
                {row.sublabel && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {row.sublabel}
                  </span>
                )}
              </span>
              <span className="relative shrink-0 text-sm font-medium tabular-nums text-foreground">
                {row.display ?? row.value.toLocaleString()}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
