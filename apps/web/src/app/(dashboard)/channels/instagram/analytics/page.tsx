'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Bot,
  Clock,
  ExternalLink,
  Gift,
  Grid3x3,
  Heart,
  MessageCircle,
  MessageSquare,
  Send,
  Users,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useChannelAnalytics } from '@/hooks/use-channel-analytics'
import { CHANNEL_ANALYTICS } from '@/lib/analytics/config'
import { toggleFilter } from '@/lib/analytics/filters'
import { fillDays, previousRangeLabel } from '@/lib/analytics/range'
import { count, dayLabel, duration, rate, relativeTime, truncate } from '@/lib/analytics/format'
import { downloadCsv, exportFilename, joinSections, toCsv } from '@/lib/analytics/export'
import { localDayKey } from '@/lib/dashboard/date-utils'
import {
  loadAlerts,
  loadHeatmap,
  loadIgComments,
  loadIgFunnels,
  loadIgPosts,
  loadKpis,
  loadLeads,
  loadTopContacts,
  loadVolume,
} from '@/lib/analytics/queries'
import type {
  ChannelAlert,
  ChannelKpis,
  HeatCell,
  IgCommentPoint,
  IgFunnelStat,
  IgPostStat,
  LeadPoint,
  TopContact,
  VolumePoint,
} from '@/lib/analytics/types'

import { AnalyticsPageShell, KpiGrid } from '@/components/analytics/analytics-page-shell'
import { KpiTile } from '@/components/analytics/kpi-tile'
import { Panel, SectionHeading } from '@/components/analytics/panel'
import { ChartLegend, TrendChart } from '@/components/analytics/trend-chart'
import { HourHeatmap } from '@/components/analytics/hour-heatmap'
import { FunnelBar } from '@/components/analytics/funnel-bar'
import { BarList } from '@/components/analytics/bar-list'
import { Column, DataTable, Pill } from '@/components/analytics/data-table'

const CHANNEL = 'instagram' as const
const { accent, accentAlt } = CHANNEL_ANALYTICS[CHANNEL]
const PURPLE = '#8134AF'

export default function InstagramAnalyticsPage() {
  const controls = useChannelAnalytics(CHANNEL)
  const { accountId, range, filters, dataKey, markUpdated, setFilters } = controls

  /**
   * Loading is DERIVED, not a flag set at the top of the effect.
   * `react-hooks/set-state-in-effect` rightly refuses a synchronous
   * setState in an effect body, and comparing the key we last loaded
   * against the key we want is also more honest: a range or filter
   * change marks the page stale immediately, without a render where
   * the old numbers sit under the new controls.
   */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const loading = loadedKey !== dataKey
  const [kpis, setKpis] = useState<ChannelKpis | null>(null)
  const [volume, setVolume] = useState<VolumePoint[]>([])
  const [heat, setHeat] = useState<HeatCell[]>([])
  const [leads, setLeads] = useState<LeadPoint[]>([])
  const [contacts, setContacts] = useState<TopContact[]>([])
  const [comments, setComments] = useState<IgCommentPoint[]>([])
  const [funnels, setFunnels] = useState<IgFunnelStat[]>([])
  const [posts, setPosts] = useState<IgPostStat[]>([])
  const [alerts, setAlerts] = useState<ChannelAlert[]>([])

  const mediaFilter = filters.mediaId

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    const db = createClient()
    void Promise.all([
      loadKpis(db, accountId, CHANNEL, range, filters),
      loadVolume(db, accountId, CHANNEL, range, filters),
      loadHeatmap(db, accountId, CHANNEL, range),
      loadLeads(db, accountId, CHANNEL, range),
      loadTopContacts(db, accountId, CHANNEL, range),
      // The post filter is a real argument here, not a message filter —
      // it scopes which comments are counted.
      loadIgComments(db, accountId, range, mediaFilter),
      loadIgFunnels(db, accountId, range),
      loadIgPosts(db, accountId, range),
      loadAlerts(db, accountId, CHANNEL),
    ])
      .then(([k, v, h, l, c, cm, f, p, a]) => {
        if (cancelled) return
        setKpis(k)
        setVolume(v)
        setHeat(h)
        setLeads(l)
        setContacts(c)
        setComments(cm)
        setFunnels(f)
        setPosts(p)
        setAlerts(a)
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load Instagram analytics')
      })
      .finally(() => {
        if (cancelled) return
        setLoadedKey(dataKey)
        markUpdated()
      })

    return () => {
      cancelled = true
    }
  }, [accountId, range, filters, mediaFilter, dataKey, markUpdated])

  const volumeFull = useMemo(
    () =>
      fillDays(range, volume, (day) => ({
        day,
        incoming: 0,
        outgoing: 0,
        delivered: 0,
        read: 0,
        failed: 0,
      })),
    [range, volume],
  )
  const commentsFull = useMemo(
    () =>
      fillDays(range, comments, (day) => ({
        day,
        received: 0,
        replied: 0,
        open: 0,
        hidden: 0,
        privateReplies: 0,
      })),
    [range, comments],
  )
  const leadsFull = useMemo(
    () =>
      fillDays(range, leads, (day) => ({
        day,
        contacts: 0,
        deals: 0,
        dealsWon: 0,
        dealValue: 0,
        wonValue: 0,
      })),
    [range, leads],
  )

  const comparison = previousRangeLabel(range)

  const totals = useMemo(() => {
    const received = comments.reduce((s, c) => s + c.received, 0)
    const replied = comments.reduce((s, c) => s + c.replied, 0)
    const open = comments.reduce((s, c) => s + c.open, 0)
    const privateReplies = comments.reduce((s, c) => s + c.privateReplies, 0)
    const matched = funnels.reduce((s, f) => s + f.matched, 0)
    const awaitingOptin = funnels.reduce((s, f) => s + f.awaitingOptin, 0)
    const awaitingFollow = funnels.reduce((s, f) => s + f.awaitingFollow, 0)
    const delivered = funnels.reduce((s, f) => s + f.delivered, 0)
    const failed = funnels.reduce((s, f) => s + f.failed, 0)
    return {
      received,
      replied,
      open,
      privateReplies,
      matched,
      awaitingOptin,
      awaitingFollow,
      delivered,
      failed,
    }
  }, [comments, funnels])

  const resolveFilterLabel = useCallback(
    (key: string, value: string) => {
      if (key === 'mediaId') {
        const post = posts.find((p) => p.igMediaId === value)
        return post ? truncate(post.caption ?? `Post ${value}`, 32) : undefined
      }
      if (key === 'funnelId') return funnels.find((f) => f.funnelId === value)?.name
      return undefined
    },
    [posts, funnels],
  )

  const handleExport = useCallback(() => {
    const startKey = localDayKey(range.start)
    const lastDay = new Date(range.end)
    lastDay.setDate(lastDay.getDate() - 1)
    const endKey = localDayKey(lastDay)

    const csv = joinSections([
      {
        title: 'Daily DM volume',
        csv: toCsv(volumeFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Incoming', value: (r) => r.incoming },
          { header: 'Outgoing', value: (r) => r.outgoing },
          { header: 'Failed', value: (r) => r.failed },
        ]),
      },
      {
        title: 'Daily comments',
        csv: toCsv(commentsFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Received', value: (r) => r.received },
          { header: 'Replied', value: (r) => r.replied },
          { header: 'Open', value: (r) => r.open },
          { header: 'Hidden', value: (r) => r.hidden },
          { header: 'Private replies', value: (r) => r.privateReplies },
        ]),
      },
      {
        title: 'Comment funnels',
        csv: toCsv(funnels, [
          { header: 'Funnel', value: (r) => r.name },
          { header: 'Active', value: (r) => (r.isActive ? 'yes' : 'no') },
          { header: 'Matched', value: (r) => r.matched },
          { header: 'Awaiting opt-in', value: (r) => r.awaitingOptin },
          { header: 'Awaiting follow', value: (r) => r.awaitingFollow },
          { header: 'Delivered', value: (r) => r.delivered },
          { header: 'Failed', value: (r) => r.failed },
          { header: 'Was following', value: (r) => r.wasFollowing },
        ]),
      },
      {
        title: 'Posts',
        csv: toCsv(posts, [
          { header: 'Media id', value: (r) => r.igMediaId },
          { header: 'Type', value: (r) => r.mediaProductType },
          { header: 'Posted at', value: (r) => r.postedAt },
          { header: 'Caption', value: (r) => truncate(r.caption, 120) },
          { header: 'Likes', value: (r) => r.likeCount },
          { header: 'Comments (lifetime)', value: (r) => r.commentsTotal },
          { header: 'Comments (in range)', value: (r) => r.commentsInRange },
          { header: 'DMs started', value: (r) => r.dmsStarted },
          { header: 'Permalink', value: (r) => r.permalink },
        ]),
      },
    ])

    downloadCsv(csv, exportFilename('instagram', startKey, endKey))
    toast.success('Export downloaded')
  }, [range, volumeFull, commentsFull, funnels, posts])

  return (
    <AnalyticsPageShell
      channel={CHANNEL}
      subtitle="DMs, comment moderation, comment-to-DM funnels and post performance."
      controls={controls}
      alerts={alerts}
      onExport={handleExport}
      resolveFilterLabel={resolveFilterLabel}
    >
      <KpiGrid loading={loading || !kpis}>
        {kpis && (
          <>
            <KpiTile
              label="DMs sent"
              value={count(kpis.msgsOut.current)}
              icon={Send}
              current={kpis.msgsOut.current}
              previous={kpis.msgsOut.previous}
              comparisonLabel={comparison}
              trend={volumeFull.map((p) => p.outgoing)}
              accent={accent}
              onClick={() => setFilters(toggleFilter(filters, 'direction', 'out'))}
              active={filters.direction === 'out'}
            />
            <KpiTile
              label="DMs received"
              value={count(kpis.msgsIn.current)}
              icon={MessageSquare}
              current={kpis.msgsIn.current}
              previous={kpis.msgsIn.previous}
              comparisonLabel={comparison}
              trend={volumeFull.map((p) => p.incoming)}
              accent={accentAlt}
              onClick={() => setFilters(toggleFilter(filters, 'direction', 'in'))}
              active={filters.direction === 'in'}
            />
            <KpiTile
              label="Active conversations"
              value={count(kpis.convsActive.current)}
              icon={MessageSquare}
              current={kpis.convsActive.current}
              previous={kpis.convsActive.previous}
              comparisonLabel={comparison}
              accent={PURPLE}
            />
            <KpiTile
              label="Avg first response"
              value={duration(kpis.avgResponseMinutes.current)}
              icon={Clock}
              current={kpis.avgResponseMinutes.current ?? undefined}
              previous={kpis.avgResponseMinutes.previous ?? undefined}
              comparisonLabel={comparison}
              accent={accentAlt}
              invertDelta
            />
            <KpiTile
              label="Replies by AI"
              value={rate(kpis.aiReplies.current, kpis.msgsOut.current)}
              icon={Bot}
              hint={`${count(kpis.aiReplies.current)} AI · ${count(kpis.humanReplies.current)} human`}
              accent={accent}
              onClick={() => setFilters(toggleFilter(filters, 'agent', 'ai'))}
              active={filters.agent === 'ai'}
            />
            <KpiTile
              label="Comments received"
              value={count(totals.received)}
              icon={MessageCircle}
              hint={`${count(totals.open)} still open`}
              trend={commentsFull.map((c) => c.received)}
              accent={accentAlt}
            />
            <KpiTile
              label="Comment reply rate"
              value={rate(totals.replied, totals.received)}
              icon={Heart}
              hint={`${count(totals.privateReplies)} answered privately`}
              trend={commentsFull.map((c) => c.replied)}
              accent={PURPLE}
            />
            <KpiTile
              label="Funnel deliveries"
              value={count(totals.delivered)}
              icon={Gift}
              hint={`${rate(totals.delivered, totals.matched)} of ${count(totals.matched)} matched`}
              accent={accent}
            />
          </>
        )}
      </KpiGrid>

      {/* ---- DMs ---- */}
      <SectionHeading>Direct messages</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="DM volume"
            subtitle="Daily incoming and outgoing direct messages"
            loading={loading}
            empty={volumeFull.every((p) => p.incoming === 0 && p.outgoing === 0)}
            emptyTitle="No DMs in this period"
            emptyHint="Instagram direct messages appear here once people start writing in."
            actions={
              <ChartLegend
                series={[
                  { key: 'in', label: 'Received', color: accentAlt, values: [] },
                  { key: 'out', label: 'Sent', color: accent, values: [] },
                ]}
              />
            }
          >
            <TrendChart
              labels={volumeFull.map((p) => p.day)}
              formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
              series={[
                {
                  key: 'out',
                  label: 'sent',
                  color: accent,
                  area: true,
                  values: volumeFull.map((p) => p.outgoing),
                },
                {
                  key: 'in',
                  label: 'received',
                  color: accentAlt,
                  area: true,
                  values: volumeFull.map((p) => p.incoming),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Who is answering"
            subtitle="AI agent versus a teammate"
            loading={loading}
            empty={!kpis || kpis.msgsOut.current === 0}
            emptyTitle="No replies sent in this period"
          >
            {kpis && (
              <FunnelBar
                steps={[
                  { key: 'out', label: 'Replies sent', value: kpis.msgsOut.current, color: accent },
                  { key: 'ai', label: 'By the AI agent', value: kpis.aiReplies.current, color: accentAlt },
                  { key: 'human', label: 'By a teammate', value: kpis.humanReplies.current, color: PURPLE },
                  {
                    key: 'handoff',
                    label: 'Handed to a human',
                    value: kpis.handoffs.current,
                    color: 'var(--accent-amber)',
                  },
                ]}
              />
            )}
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Busiest hours"
            subtitle="Incoming DMs by day and hour, in your timezone"
            loading={loading}
            empty={heat.length === 0}
            emptyTitle="No inbound DMs in this period"
          >
            <HourHeatmap cells={heat} accent={accent} />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Most active people"
            subtitle="By total messages exchanged"
            loading={loading}
            empty={contacts.length === 0}
            emptyIcon={Users}
          >
            <BarList
              accent={accent}
              rows={contacts.map((c) => ({
                id: c.contactId,
                label: c.name || (c.handle ? `@${c.handle}` : 'Unknown'),
                sublabel: `${count(c.inbound)} in · ${count(c.outbound)} out · ${relativeTime(c.lastAt)}`,
                value: c.inbound + c.outbound,
              }))}
            />
          </Panel>
        </div>
      </div>

      {/* ---- Comments & funnels ---- */}
      <SectionHeading>Comments &amp; funnels</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Comment activity"
            subtitle={
              mediaFilter
                ? 'Scoped to the selected post'
                : 'Comments received and how many were answered'
            }
            icon={MessageCircle}
            loading={loading}
            empty={commentsFull.every((c) => c.received === 0)}
            emptyTitle="No comments in this period"
            actions={
              <ChartLegend
                series={[
                  { key: 'r', label: 'Received', color: accentAlt, values: [] },
                  { key: 'a', label: 'Replied', color: accent, values: [] },
                  { key: 'p', label: 'Private replies', color: PURPLE, values: [] },
                ]}
              />
            }
          >
            <TrendChart
              labels={commentsFull.map((c) => c.day)}
              formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
              series={[
                {
                  key: 'received',
                  label: 'received',
                  color: accentAlt,
                  area: true,
                  values: commentsFull.map((c) => c.received),
                },
                {
                  key: 'replied',
                  label: 'replied',
                  color: accent,
                  values: commentsFull.map((c) => c.replied),
                },
                {
                  key: 'private',
                  label: 'private replies',
                  color: PURPLE,
                  dashed: true,
                  values: commentsFull.map((c) => c.privateReplies),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Comment → DM funnel"
            subtitle="Across every comment funnel"
            icon={Gift}
            loading={loading}
            empty={totals.matched === 0}
            emptyTitle="No funnel runs in this period"
            emptyHint="A comment funnel DMs people who comment on your posts."
          >
            <FunnelBar
              steps={[
                { key: 'matched', label: 'Comments matched', value: totals.matched, color: accentAlt },
                {
                  key: 'optin',
                  label: 'Awaiting opt-in',
                  value: totals.awaitingOptin,
                  color: 'var(--accent-amber)',
                },
                {
                  key: 'follow',
                  label: 'Awaiting follow',
                  value: totals.awaitingFollow,
                  color: PURPLE,
                },
                { key: 'delivered', label: 'Reward delivered', value: totals.delivered, color: accent },
              ]}
            />
          </Panel>
        </div>
      </div>

      <Panel
        title="Comment funnels"
        subtitle="Click a funnel to filter this page by it"
        icon={Gift}
        loading={loading}
        empty={funnels.length === 0}
        emptyTitle="No comment funnels yet"
        emptyHint="Create one to reply to commenters automatically and DM them a reward."
        actions={
          <Link
            href="/channels/instagram/funnels"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Manage funnels <ExternalLink className="h-3 w-3" />
          </Link>
        }
      >
        <DataTable
          rows={funnels}
          rowKey={(r) => r.funnelId}
          selectedKey={filters.funnelId}
          onSelect={(r) => setFilters(toggleFilter(filters, 'funnelId', r.funnelId))}
          columns={funnelColumns}
        />
      </Panel>

      {/* ---- Posts ---- */}
      <SectionHeading>Post performance</SectionHeading>
      <Panel
        title="Top posts"
        subtitle="Click a post to scope the comment widgets above to it"
        icon={Grid3x3}
        loading={loading}
        empty={posts.length === 0}
        emptyTitle="No posts synced yet"
        emptyHint="Sync your Instagram posts to see which ones drive comments and DMs."
        actions={
          <Link
            href="/channels/instagram/posts"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            All posts <ExternalLink className="h-3 w-3" />
          </Link>
        }
      >
        <DataTable
          rows={posts}
          rowKey={(r) => r.igMediaId}
          selectedKey={filters.mediaId}
          onSelect={(r) => setFilters(toggleFilter(filters, 'mediaId', r.igMediaId))}
          columns={postColumns}
          maxHeight="26rem"
        />
      </Panel>

      {/* ---- Leads ---- */}
      <SectionHeading>Audience &amp; leads</SectionHeading>
      <Panel
        title="Contacts and deals from Instagram"
        subtitle="Deals are attributed through the conversation they came from"
        icon={Users}
        loading={loading}
        empty={leadsFull.every((l) => l.contacts === 0 && l.deals === 0)}
        emptyTitle="No new contacts or deals in this period"
        actions={
          <ChartLegend
            series={[
              { key: 'c', label: 'New contacts', color: accent, values: [] },
              { key: 'd', label: 'Deals created', color: accentAlt, values: [] },
              { key: 'w', label: 'Deals won', color: PURPLE, values: [] },
            ]}
          />
        }
      >
        <TrendChart
          labels={leadsFull.map((l) => l.day)}
          formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
          series={[
            {
              key: 'contacts',
              label: 'new contacts',
              color: accent,
              area: true,
              values: leadsFull.map((l) => l.contacts),
            },
            { key: 'deals', label: 'deals created', color: accentAlt, values: leadsFull.map((l) => l.deals) },
            {
              key: 'won',
              label: 'deals won',
              color: PURPLE,
              dashed: true,
              values: leadsFull.map((l) => l.dealsWon),
            },
          ]}
        />
      </Panel>
    </AnalyticsPageShell>
  )
}

// ------------------------------------------------------------

const funnelColumns: Column<IgFunnelStat>[] = [
  {
    key: 'name',
    header: 'Funnel',
    cell: (r) => <span className="font-medium">{truncate(r.name, 36)}</span>,
  },
  {
    key: 'active',
    header: 'State',
    cell: (r) => <Pill tone={r.isActive ? 'good' : 'neutral'}>{r.isActive ? 'Active' : 'Paused'}</Pill>,
  },
  { key: 'matched', header: 'Matched', align: 'right', cell: (r) => count(r.matched) },
  { key: 'optin', header: 'Awaiting opt-in', align: 'right', cell: (r) => count(r.awaitingOptin) },
  { key: 'follow', header: 'Awaiting follow', align: 'right', cell: (r) => count(r.awaitingFollow) },
  { key: 'delivered', header: 'Delivered', align: 'right', cell: (r) => count(r.delivered) },
  {
    key: 'rate',
    header: 'Completion',
    align: 'right',
    cell: (r) => rate(r.delivered, r.matched, 0),
  },
  {
    key: 'failed',
    header: 'Failed',
    align: 'right',
    cell: (r) => (r.failed > 0 ? <span className="text-accent-red">{count(r.failed)}</span> : '—'),
  },
]

const postColumns: Column<IgPostStat>[] = [
  {
    key: 'post',
    header: 'Post',
    className: 'min-w-[16rem]',
    cell: (r) => (
      <span className="flex items-center gap-2">
        {r.thumbnailUrl ? (
          // Instagram CDN hosts are not in next.config's image domains,
          // so this stays an <img>. `unoptimized` on next/image would
          // work too but adds nothing over a plain tag at 32px.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={r.thumbnailUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded object-cover"
            loading="lazy"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
            <Grid3x3 className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        )}
        <span className="truncate">{truncate(r.caption, 42)}</span>
      </span>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    cell: (r) => (
      <span className="text-xs text-muted-foreground">{r.mediaProductType ?? '—'}</span>
    ),
  },
  {
    key: 'posted',
    header: 'Posted',
    cell: (r) => <span className="text-xs text-muted-foreground">{relativeTime(r.postedAt)}</span>,
  },
  { key: 'likes', header: 'Likes', align: 'right', cell: (r) => count(r.likeCount ?? 0) },
  {
    key: 'inRange',
    header: 'Comments (range)',
    align: 'right',
    cell: (r) => count(r.commentsInRange),
  },
  {
    key: 'total',
    header: 'Comments (all time)',
    align: 'right',
    cell: (r) => count(r.commentsTotal ?? 0),
  },
  { key: 'dms', header: 'DMs started', align: 'right', cell: (r) => count(r.dmsStarted) },
  {
    key: 'link',
    header: '',
    align: 'right',
    cell: (r) =>
      r.permalink ? (
        <a
          href={r.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex text-muted-foreground hover:text-foreground"
          aria-label="Open on Instagram"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null,
  },
]
