'use client'

import Link from 'next/link'
import { AlertTriangle, ArrowRight, CircleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { alertActionLabel, alertSentence } from '@/lib/analytics/config'
import type { ChannelAlert } from '@/lib/analytics/types'

/**
 * The fix-it row: only things that are actually wrong, each linking to
 * where it gets fixed.
 *
 * Renders NOTHING when there is nothing wrong. A permanent green "all
 * systems normal" banner is the pattern that trains people to stop
 * reading the top of the page — the same reason the flow editor's
 * validation bar became a conditional badge.
 */
export function AlertsStrip({
  alerts,
  hrefs,
}: {
  alerts: ChannelAlert[]
  hrefs: Record<string, string>
}) {
  if (alerts.length === 0) return null

  // Errors first: a blocked send matters more than an unread thread,
  // and the first row is the one people act on.
  const ordered = [...alerts].sort((a, b) =>
    a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1,
  )

  return (
    <div className="flex flex-wrap gap-2">
      {ordered.map((alert) => {
        const href = hrefs[alert.kind]
        const isError = alert.severity === 'error'
        const Icon = isError ? CircleAlert : AlertTriangle
        const body = (
          <>
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{alertSentence(alert.kind, alert.count, alert.detail)}</span>
            {href && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium opacity-80 group-hover:opacity-100">
                {alertActionLabel(alert.kind)}
                <ArrowRight className="h-3 w-3" />
              </span>
            )}
          </>
        )
        const className = cn(
          'group flex min-w-[16rem] flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
          isError
            ? 'border-accent-red/30 bg-accent-red-surface text-accent-red'
            : 'border-accent-amber/30 bg-accent-amber-surface text-accent-amber',
          href && 'hover:brightness-105',
        )

        return href ? (
          <Link key={alert.kind} href={href} className={className}>
            {body}
          </Link>
        ) : (
          <div key={alert.kind} className={className}>
            {body}
          </div>
        )
      })}
    </div>
  )
}
