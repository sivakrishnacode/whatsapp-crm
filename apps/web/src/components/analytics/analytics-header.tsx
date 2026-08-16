'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Calendar, Download, RefreshCw, X } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { localDayKey } from '@/lib/dashboard/date-utils'
import { RANGE_PRESETS, rangeLabel, type DateRange, type RangePreset } from '@/lib/analytics/range'
import { describeFilters, hasAnyFilter, withoutFilter } from '@/lib/analytics/filters'
import type { AnalyticsFilters } from '@/lib/analytics/types'
import type { QuickAction } from '@/lib/analytics/config'

export function AnalyticsHeader({
  title,
  subtitle,
  accent,
  gradient,
  icon: Icon,
  range,
  onPreset,
  onCustomRange,
  filters,
  onFiltersChange,
  resolveFilterLabel,
  quickActions,
  onRefresh,
  refreshing,
  lastUpdated,
  onExport,
}: {
  title: string
  subtitle: string
  accent: string
  gradient?: string
  icon: React.ComponentType<{ className?: string }>
  range: DateRange
  onPreset: (p: RangePreset) => void
  onCustomRange: (startKey: string, endKey: string) => boolean
  filters: AnalyticsFilters
  onFiltersChange: (next: AnalyticsFilters) => void
  resolveFilterLabel?: (key: keyof AnalyticsFilters, value: string) => string | undefined
  quickActions: QuickAction[]
  onRefresh: () => void
  refreshing: boolean
  lastUpdated: Date | null
  onExport: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [startKey, setStartKey] = useState(() => localDayKey(range.start))
  const [endKey, setEndKey] = useState(() => {
    const last = new Date(range.end)
    last.setDate(last.getDate() - 1)
    return localDayKey(last)
  })
  const [pickerError, setPickerError] = useState<string | null>(null)

  const chips = describeFilters(filters, resolveFilterLabel)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
            style={gradient ? { backgroundImage: gradient } : { backgroundColor: accent }}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-foreground">{title}</h1>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPreset(p)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  range.preset === p
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p}d
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className={cn(
                'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range.preset === 'custom'
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Calendar className="h-3 w-3" />
              {range.preset === 'custom' ? rangeLabel(range) : 'Custom'}
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {/* Quick actions + last-updated. The timestamp is what makes a
          manual-refresh page honest: without it there is no way to know
          how stale the numbers are. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Anchor styled with `buttonVariants` rather than a Button
              wrapping a Link — this Button has no `asChild`, and a
              nested <a> inside a <button> is invalid markup. Same
              pattern as invite-member-dialog.tsx. */}
          {quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <action.icon className="h-3.5 w-3.5" />
              {action.label}
            </Link>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {lastUpdated
            ? `Updated ${lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
            : 'Loading…'}
        </p>
      </div>

      {hasAnyFilter(filters) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">Filtered by</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onFiltersChange(withoutFilter(filters, chip.key))}
              className="group flex max-w-[18rem] items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
            >
              <span className="truncate">{chip.label}</span>
              <X className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onFiltersChange({})}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom date range</DialogTitle>
            <DialogDescription>
              Both dates are included. Every widget on this page uses the range you pick.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="space-y-1.5">
              <label htmlFor="range-start" className="text-sm font-medium">
                Start
              </label>
              <Input
                id="range-start"
                type="date"
                value={startKey}
                max={endKey}
                onChange={(e) => setStartKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="range-end" className="text-sm font-medium">
                End
              </label>
              <Input
                id="range-end"
                type="date"
                value={endKey}
                min={startKey}
                onChange={(e) => setEndKey(e.target.value)}
              />
            </div>
          </div>
          {pickerError && <p className="text-sm text-accent-red">{pickerError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (onCustomRange(startKey, endKey)) {
                  setPickerError(null)
                  setPickerOpen(false)
                } else {
                  setPickerError('Pick a valid start and end date, with start no later than end.')
                }
              }}
            >
              Apply range
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
