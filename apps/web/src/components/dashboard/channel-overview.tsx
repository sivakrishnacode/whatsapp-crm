'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Plug } from 'lucide-react'

import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useChannelStatus, type ChannelStatus } from '@/hooks/use-channel-status'
import {
  CHANNELS,
  CHANNEL_ORDER,
  channelConnectHref,
  channelLandingHref,
  type ChannelDef,
  type ChannelId,
} from '@/lib/nav/channels'
import { CHANNEL_ANALYTICS } from '@/lib/analytics/config'
import { loadKpis } from '@/lib/analytics/queries'
import type { AnalyticsChannel, ChannelKpis } from '@/lib/analytics/types'
import type { DateRange } from '@/lib/analytics/range'
import { count, duration } from '@/lib/analytics/format'
import { ChannelMark } from '@/components/analytics/channel-mark'
import { Skeleton } from '@/components/dashboard/skeleton'

/**
 * The cross-channel row: one card per channel, each carrying that
 * channel's CONNECTION STATE and its numbers for the selected range.
 *
 * Why the two live together rather than in a status strip and a metrics
 * strip: they answer the same question. "Instagram shows nothing" is
 * either a quiet week or a channel that was never connected, and a card
 * that shows zeros without saying which one is actively misleading — an
 * unconnected channel therefore renders a Connect button INSTEAD of a
 * row of zeros, never alongside it.
 *
 * The numbers come from `get_channel_kpis` (migration 089), the same RPC
 * the per-channel analytics pages use, so a total here and the tile on
 * /channels/<id>/analytics can never disagree for the same range.
 */

/**
 * `ChannelId` minus the one channel with no conversations.
 *
 * Written as a narrowing function rather than a lookup table so the
 * compiler checks it: `AnalyticsChannel` is exactly `ChannelId` without
 * 'phone', and adding a fifth channel to the registry without an
 * analytics page fails here instead of at run time.
 */
function analyticsChannel(id: ChannelId): AnalyticsChannel | null {
  return id === 'phone' ? null : id
}

type KpiMap = Partial<Record<AnalyticsChannel, ChannelKpis>>

export function ChannelOverview({
  accountId,
  range,
}: {
  accountId: string | null
  range: DateRange
}) {
  const statuses = useChannelStatus()
  const [kpis, setKpis] = useState<KpiMap>({})

  /**
   * Loading is DERIVED from "which key did we last finish loading",
   * not a flag set at the top of the effect — `react-hooks/
   * set-state-in-effect` refuses the latter, and this way a range
   * change marks the row stale immediately instead of leaving last
   * week's numbers sitting under the new range for one render.
   */
  const dataKey = accountId ? `${accountId}:${range.start.getTime()}:${range.end.getTime()}` : null
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const loading = dataKey !== null && loadedKey !== dataKey

  useEffect(() => {
    if (!accountId || !dataKey) return
    let cancelled = false
    const db = createClient()

    const channels = CHANNEL_ORDER.map(analyticsChannel).filter(
      (c): c is AnalyticsChannel => c !== null,
    )

    // allSettled, not all: one channel's RPC failing must not blank the
    // other two. A channel that errors keeps its previous card rather
    // than reporting zero, which would read as "no traffic".
    void Promise.allSettled(
      channels.map((channel) => loadKpis(db, accountId, channel, range, {})),
    )
      .then((results) => {
        if (cancelled) return
        const next: KpiMap = {}
        results.forEach((result, i) => {
          const channel = channels[i]
          if (channel && result.status === 'fulfilled') next[channel] = result.value
        })
        setKpis(next)
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(dataKey)
      })

    return () => {
      cancelled = true
    }
  }, [accountId, dataKey, range])

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {CHANNEL_ORDER.map((id) => {
        const analytics = analyticsChannel(id)
        return (
          <ChannelCard
            key={id}
            channel={CHANNELS[id]}
            status={statuses[id]}
            kpis={analytics ? kpis[analytics] : undefined}
            loading={loading}
          />
        )
      })}
    </div>
  )
}

/**
 * One channel, in three lines.
 *
 * The WHOLE CARD is the link — to the channel's analytics when it is
 * connected, to its settings when it is not. That is what let the
 * footer row ("View analytics →") go: it was a third of the card's
 * height spent restating where the card already pointed.
 *
 * Locked channels render as a plain div, since there is nowhere to go.
 */
function ChannelCard({
  channel,
  status,
  kpis,
  loading,
}: {
  channel: ChannelDef
  status: ChannelStatus | undefined
  kpis: ChannelKpis | undefined
  loading: boolean
}) {
  const locked = channel.status === 'locked'
  const analytics = analyticsChannel(channel.id)
  const config = analytics ? CHANNEL_ANALYTICS[analytics] : null
  const state = locked ? 'unavailable' : (status?.state ?? 'loading')
  const connected = state === 'connected'

  const body = (
    <>
      {config ? (
        <ChannelMark
          icon={channel.icon}
          markStyle={config.markStyle}
          accent={config.accent}
          gradient={config.gradient}
          className="h-8 w-8"
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <channel.icon className="h-4 w-4" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-foreground">{channel.label}</p>
          <StatusDot state={state} />
        </div>

        {locked ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">Coming soon</p>
        ) : state === 'loading' || (connected && (loading || !kpis)) ? (
          <Skeleton className="mt-1.5 h-7 w-full" />
        ) : connected && kpis ? (
          <>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              <Num>{count(kpis.msgsOut.current)}</Num> sent ·{' '}
              <Num>{count(kpis.msgsIn.current)}</Num> received
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {count(kpis.convsNew.current)} new chat{kpis.convsNew.current === 1 ? '' : 's'} ·{' '}
              {duration(kpis.avgResponseMinutes.current)} reply
            </p>
          </>
        ) : (
          // Not connected: the next action, never a row of zeros — a
          // quiet week and a channel that was never set up must not
          // render identically.
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-primary">
            <Plug className="h-3 w-3 shrink-0" />
            Connect {channel.label}
          </p>
        )}
      </div>

      {!locked && (
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </>
  )

  const shell = 'group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3'

  if (locked) {
    return <div className={cn(shell, 'opacity-60')}>{body}</div>
  }

  return (
    <Link
      href={connected ? channelLandingHref(channel.id) : channelConnectHref(channel.id)}
      className={cn(shell, 'transition-colors hover:bg-muted/60')}
    >
      {body}
    </Link>
  )
}

/** Emphasised figure inside an otherwise muted sentence. */
function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold tabular-nums text-foreground">{children}</span>
}

/**
 * Connection state as a dot with an accessible name, rather than a dot
 * plus a word. At this size the label was half the line and it repeats
 * on every card; the name is still announced and still on hover.
 */
function StatusDot({ state }: { state: ChannelStatus['state'] }) {
  const tone =
    state === 'connected'
      ? { dot: 'bg-accent-green', label: 'Connected' }
      : state === 'loading'
        ? { dot: 'bg-muted-foreground/50', label: 'Checking connection' }
        : state === 'unavailable'
          ? { dot: 'bg-muted-foreground/50', label: 'Coming soon' }
          : { dot: 'bg-accent-amber', label: 'Not connected' }

  return (
    <span
      title={tone.label}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone.dot,
        state === 'loading' && 'animate-pulse',
      )}
    >
      <span className="sr-only">{tone.label}</span>
    </span>
  )
}
