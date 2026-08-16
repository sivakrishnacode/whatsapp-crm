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
  const state = status?.state ?? 'loading'

  return (
    <section
      className={cn(
        'flex flex-col rounded-xl border border-border bg-card p-4',
        locked && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-3">
        {config ? (
          <ChannelMark
            icon={channel.icon}
            markStyle={config.markStyle}
            accent={config.accent}
            gradient={config.gradient}
            className="h-9 w-9"
          />
        ) : (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <channel.icon className="h-4.5 w-4.5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{channel.label}</p>
          <StatusLine state={locked ? 'unavailable' : state} locked={locked} />
        </div>
      </div>

      <div className="mt-4 flex-1">
        {locked ? (
          <p className="text-xs text-muted-foreground">{channel.tagline}</p>
        ) : state === 'loading' ? (
          <Skeleton className="h-14 w-full" />
        ) : state === 'not_connected' ? (
          <p className="text-xs text-muted-foreground">{status?.message ?? channel.tagline}</p>
        ) : loading || !kpis ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <Numbers kpis={kpis} />
        )}
      </div>

      {!locked && (
        <div className="mt-4 border-t border-border pt-3">
          {state === 'not_connected' ? (
            <Link
              href={channelConnectHref(channel.id)}
              className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <Plug className="h-3.5 w-3.5" />
              Connect {channel.label}
            </Link>
          ) : (
            <Link
              href={channelLandingHref(channel.id)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              View analytics
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      )}
    </section>
  )
}

function Numbers({ kpis }: { kpis: ChannelKpis }) {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Sent" value={count(kpis.msgsOut.current)} />
        <Stat label="Received" value={count(kpis.msgsIn.current)} />
      </div>
      <p className="text-xs text-muted-foreground">
        {count(kpis.convsNew.current)} new chat{kpis.convsNew.current === 1 ? '' : 's'} ·{' '}
        {duration(kpis.avgResponseMinutes.current)} avg reply
      </p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xl leading-none font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function StatusLine({
  state,
  locked,
}: {
  state: ChannelStatus['state']
  locked: boolean
}) {
  const tone =
    state === 'connected'
      ? { dot: 'bg-accent-green', text: 'text-accent-green', label: 'Connected' }
      : state === 'loading'
        ? { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', label: 'Checking…' }
        : locked
          ? { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', label: 'Coming soon' }
          : { dot: 'bg-accent-amber', text: 'text-accent-amber', label: 'Not connected' }

  return (
    <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs', tone.text)}>
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot, state === 'loading' && 'animate-pulse')}
      />
      {tone.label}
    </span>
  )
}
