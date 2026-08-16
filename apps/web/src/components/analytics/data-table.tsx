'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  header: string
  /** Right-align numeric columns so digits line up down the page. */
  align?: 'left' | 'right'
  className?: string
  cell: (row: T) => ReactNode
}

/**
 * The table used by every entity list on the analytics pages.
 *
 * Rows are clickable when `onSelect` is given — that is the
 * cross-filter entry point. It is a real `<button>` inside the first
 * cell rather than an onClick on the `<tr>`, so the row is reachable by
 * keyboard and announced as an action.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onSelect,
  selectedKey,
  maxHeight = '20rem',
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  onSelect?: (row: T) => void
  selectedKey?: string
  maxHeight?: string
}) {
  return (
    // The wrapper scrolls in BOTH axes on its own so a wide table never
    // makes the page itself scroll sideways.
    <div className="-mx-2 overflow-auto" style={{ maxHeight }}>
      <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'border-b border-border px-2 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase',
                  c.align === 'right' ? 'text-right' : 'text-left',
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const selected = selectedKey === key
            return (
              <tr
                key={key}
                className={cn(
                  'transition-colors',
                  onSelect && 'hover:bg-muted/40',
                  selected && 'bg-muted/60',
                )}
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      'border-b border-border/60 px-2 py-2 text-foreground',
                      c.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                      c.className,
                    )}
                  >
                    {i === 0 && onSelect ? (
                      <button
                        type="button"
                        onClick={() => onSelect(row)}
                        className="max-w-full truncate rounded text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {c.cell(row)}
                      </button>
                    ) : (
                      c.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Small status pill used inside table cells. */
export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    good: 'bg-accent-green-surface text-accent-green',
    warn: 'bg-accent-amber-surface text-accent-amber',
    bad: 'bg-accent-red-surface text-accent-red',
  } as const
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

/** Maps a Meta template/broadcast status onto a pill tone. */
export function statusTone(status: string | null): 'neutral' | 'good' | 'warn' | 'bad' {
  const s = (status ?? '').toUpperCase()
  if (['APPROVED', 'SENT', 'ACTIVE', 'CONNECTED', 'GREEN'].includes(s)) return 'good'
  if (['PENDING', 'QUEUED', 'SENDING', 'SCHEDULED', 'DRAFT', 'YELLOW'].includes(s)) return 'warn'
  if (['REJECTED', 'FAILED', 'PAUSED', 'DISABLED', 'RED'].includes(s)) return 'bad'
  return 'neutral'
}
