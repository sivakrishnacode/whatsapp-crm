'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Bot,
  Clock,
  ExternalLink,
  Globe,
  MessageSquare,
  MousePointerClick,
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
  loadKpis,
  loadLeads,
  loadTopContacts,
  loadVolume,
  loadWebSessions,
  loadWebSources,
} from '@/lib/analytics/queries'
import type {
  ChannelAlert,
  ChannelKpis,
  HeatCell,
  LeadPoint,
  TopContact,
  VolumePoint,
  WebSessionPoint,
  WebSourceRow,
} from '@/lib/analytics/types'

import { AnalyticsPageShell, KpiGrid } from '@/components/analytics/analytics-page-shell'
import { KpiTile } from '@/components/analytics/kpi-tile'
import { Panel, SectionHeading } from '@/components/analytics/panel'
import { ChartLegend, TrendChart } from '@/components/analytics/trend-chart'
import { HourHeatmap } from '@/components/analytics/hour-heatmap'
import { FunnelBar } from '@/components/analytics/funnel-bar'
import { BarList } from '@/components/analytics/bar-list'

const CHANNEL = 'web' as const
const { accent, accentAlt } = CHANNEL_ANALYTICS[CHANNEL]
const TEAL = '#0891b2'

export default function WebAnalyticsPage() {
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
  const [sessions, setSessions] = useState<WebSessionPoint[]>([])
  const [sources, setSources] = useState<WebSourceRow[]>([])
  const [alerts, setAlerts] = useState<ChannelAlert[]>([])

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
      loadWebSessions(db, accountId, range),
      loadWebSources(db, accountId, range),
      loadAlerts(db, accountId, CHANNEL),
    ])
      .then(([k, v, h, l, c, s, src, a]) => {
        if (cancelled) return
        setKpis(k)
        setVolume(v)
        setHeat(h)
        setLeads(l)
        setContacts(c)
        setSessions(s)
        setSources(src)
        setAlerts(a)
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load web analytics')
      })
      .finally(() => {
        if (cancelled) return
        setLoadedKey(dataKey)
        markUpdated()
      })

    return () => {
      cancelled = true
    }
  }, [accountId, range, filters, dataKey, markUpdated])

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
  const sessionsFull = useMemo(
    () =>
      fillDays(range, sessions, (day) => ({
        day,
        sessions: 0,
        visitors: 0,
        withConversation: 0,
        identified: 0,
        pagesViewed: 0,
      })),
    [range, sessions],
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
    const sessionCount = sessions.reduce((s, r) => s + r.sessions, 0)
    const withConversation = sessions.reduce((s, r) => s + r.withConversation, 0)
    const identified = sessions.reduce((s, r) => s + r.identified, 0)
    const pages = sessions.reduce((s, r) => s + r.pagesViewed, 0)
    // ⚠️ There is deliberately no "unique visitors" total here.
    // `visitors` is DISTINCT PER DAY, so summing it counts a returning
    // visitor once per day they came back — a number that looks like
    // reach and is not. The per-day figure is still exported, where the
    // column header can say what it means; a distinct-over-range count
    // would need its own query.
    return { sessionCount, withConversation, identified, pages }
  }, [sessions])

  const byDimension = useCallback(
    (dimension: WebSourceRow['dimension']) => sources.filter((s) => s.dimension === dimension),
    [sources],
  )

  const handleExport = useCallback(() => {
    const startKey = localDayKey(range.start)
    const lastDay = new Date(range.end)
    lastDay.setDate(lastDay.getDate() - 1)
    const endKey = localDayKey(lastDay)

    const csv = joinSections([
      {
        title: 'Daily sessions',
        csv: toCsv(sessionsFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Sessions', value: (r) => r.sessions },
          { header: 'Unique visitors (that day)', value: (r) => r.visitors },
          { header: 'Started a chat', value: (r) => r.withConversation },
          { header: 'Identified', value: (r) => r.identified },
          { header: 'Pages viewed', value: (r) => r.pagesViewed },
        ]),
      },
      {
        title: 'Daily chat volume',
        csv: toCsv(volumeFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Incoming', value: (r) => r.incoming },
          { header: 'Outgoing', value: (r) => r.outgoing },
        ]),
      },
      {
        title: 'Top pages / referrers / countries',
        csv: toCsv(sources, [
          { header: 'Dimension', value: (r) => r.dimension },
          { header: 'Label', value: (r) => r.label },
          { header: 'Sessions', value: (r) => r.sessions },
          { header: 'Conversations', value: (r) => r.conversations },
        ]),
      },
    ])

    downloadCsv(csv, exportFilename('web', startKey, endKey))
    toast.success('Export downloaded')
  }, [range, sessionsFull, volumeFull, sources])

  return (
    <AnalyticsPageShell
      channel={CHANNEL}
      subtitle="Widget sessions, chat volume, where visitors come from and the leads they become."
      controls={controls}
      alerts={alerts}
      onExport={handleExport}
    >
      <KpiGrid loading={loading || !kpis}>
        {kpis && (
          <>
            <KpiTile
              label="Widget sessions"
              value={count(totals.sessionCount)}
              icon={MousePointerClick}
              hint={`${count(totals.pages)} page views`}
              trend={sessionsFull.map((s) => s.sessions)}
              accent={accent}
            />
            <KpiTile
              label="Started a chat"
              value={count(totals.withConversation)}
              icon={MessageSquare}
              hint={`${rate(totals.withConversation, totals.sessionCount)} of sessions`}
              trend={sessionsFull.map((s) => s.withConversation)}
              accent={accentAlt}
            />
            <KpiTile
              label="Messages received"
              value={count(kpis.msgsIn.current)}
              icon={MessageSquare}
              current={kpis.msgsIn.current}
              previous={kpis.msgsIn.previous}
              comparisonLabel={comparison}
              trend={volumeFull.map((p) => p.incoming)}
              accent={TEAL}
              onClick={() => setFilters(toggleFilter(filters, 'direction', 'in'))}
              active={filters.direction === 'in'}
            />
            <KpiTile
              label="Messages sent"
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
              label="New conversations"
              value={count(kpis.convsNew.current)}
              icon={MessageSquare}
              current={kpis.convsNew.current}
              previous={kpis.convsNew.previous}
              comparisonLabel={comparison}
              accent={accentAlt}
            />
            <KpiTile
              label="Avg first response"
              value={duration(kpis.avgResponseMinutes.current)}
              icon={Clock}
              current={kpis.avgResponseMinutes.current ?? undefined}
              previous={kpis.avgResponseMinutes.previous ?? undefined}
              comparisonLabel={comparison}
              accent={TEAL}
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
              label="Identified visitors"
              value={count(totals.identified)}
              icon={Users}
              hint={`${rate(totals.identified, totals.sessionCount)} of sessions gave contact details`}
              trend={sessionsFull.map((s) => s.identified)}
              accent={accentAlt}
            />
          </>
        )}
      </KpiGrid>

      {/* ---- Sessions ---- */}
      <SectionHeading>Visitor sessions</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Sessions and chats"
            subtitle="Daily widget sessions and how many became conversations"
            icon={Globe}
            loading={loading}
            empty={sessionsFull.every((s) => s.sessions === 0)}
            emptyTitle="No widget sessions in this period"
            emptyHint="Sessions are recorded the first time the widget loads on your site."
            actions={
              <ChartLegend
                series={[
                  { key: 's', label: 'Sessions', color: accent, values: [] },
                  { key: 'c', label: 'Started a chat', color: accentAlt, values: [] },
                  { key: 'i', label: 'Identified', color: TEAL, values: [] },
                ]}
              />
            }
          >
            <TrendChart
              labels={sessionsFull.map((s) => s.day)}
              formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
              series={[
                {
                  key: 'sessions',
                  label: 'sessions',
                  color: accent,
                  area: true,
                  values: sessionsFull.map((s) => s.sessions),
                },
                {
                  key: 'chats',
                  label: 'started a chat',
                  color: accentAlt,
                  values: sessionsFull.map((s) => s.withConversation),
                },
                {
                  key: 'identified',
                  label: 'identified',
                  color: TEAL,
                  dashed: true,
                  values: sessionsFull.map((s) => s.identified),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Visitor funnel"
            subtitle="From a widget load to a known contact"
            loading={loading}
            empty={totals.sessionCount === 0}
            emptyTitle="No sessions in this period"
          >
            <FunnelBar
              steps={[
                { key: 'sessions', label: 'Widget sessions', value: totals.sessionCount, color: accent },
                {
                  key: 'chats',
                  label: 'Started a chat',
                  value: totals.withConversation,
                  color: accentAlt,
                },
                { key: 'identified', label: 'Left contact details', value: totals.identified, color: TEAL },
              ]}
            />
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Chat volume"
            subtitle="Daily incoming and outgoing widget messages"
            loading={loading}
            empty={volumeFull.every((p) => p.incoming === 0 && p.outgoing === 0)}
            emptyTitle="No widget messages in this period"
            actions={
              <ChartLegend
                series={[
                  { key: 'in', label: 'From visitors', color: accentAlt, values: [] },
                  { key: 'out', label: 'Replies', color: accent, values: [] },
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
                  label: 'replies',
                  color: accent,
                  area: true,
                  values: volumeFull.map((p) => p.outgoing),
                },
                {
                  key: 'in',
                  label: 'from visitors',
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
            title="Busiest hours"
            subtitle="Visitor messages by day and hour"
            loading={loading}
            empty={heat.length === 0}
            emptyTitle="No visitor messages in this period"
          >
            <HourHeatmap cells={heat} accent={accent} />
          </Panel>
        </div>
      </div>

      {/* ---- Sources ---- */}
      <SectionHeading>Where visitors come from</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel
          title="Top pages"
          subtitle="Where the widget was opened"
          loading={loading}
          empty={byDimension('page').length === 0}
          emptyTitle="No page data yet"
        >
          <BarList
            accent={accent}
            rows={byDimension('page').map((s) => ({
              id: `page-${s.label}`,
              label: truncate(s.label, 44),
              sublabel: `${count(s.conversations)} chat${s.conversations === 1 ? '' : 's'}`,
              value: s.sessions,
            }))}
          />
        </Panel>
        <Panel
          title="Top referrers"
          subtitle="What sent them to the page"
          loading={loading}
          empty={byDimension('referrer').length === 0}
          emptyTitle="No referrer data yet"
        >
          <BarList
            accent={accentAlt}
            rows={byDimension('referrer').map((s) => ({
              id: `ref-${s.label}`,
              label: truncate(s.label, 44),
              sublabel: `${count(s.conversations)} chat${s.conversations === 1 ? '' : 's'}`,
              value: s.sessions,
            }))}
          />
        </Panel>
        <Panel
          title="Top countries"
          subtitle="Coarse location, from a salted IP hash"
          loading={loading}
          empty={byDimension('country').length === 0}
          emptyTitle="No country data yet"
        >
          <BarList
            accent={TEAL}
            rows={byDimension('country').map((s) => ({
              id: `country-${s.label}`,
              label: s.label,
              sublabel: `${count(s.conversations)} chat${s.conversations === 1 ? '' : 's'}`,
              value: s.sessions,
            }))}
          />
        </Panel>
      </div>

      {/* ---- Leads ---- */}
      <SectionHeading>Leads &amp; pipeline</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Contacts and deals from the web widget"
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
                  { key: 'w', label: 'Deals won', color: TEAL, values: [] },
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
                {
                  key: 'deals',
                  label: 'deals created',
                  color: accentAlt,
                  values: leadsFull.map((l) => l.deals),
                },
                {
                  key: 'won',
                  label: 'deals won',
                  color: TEAL,
                  dashed: true,
                  values: leadsFull.map((l) => l.dealsWon),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Most active visitors"
            subtitle="By total messages exchanged"
            loading={loading}
            empty={contacts.length === 0}
            emptyIcon={Users}
            actions={
              <Link
                href="/channels/web/sessions"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Sessions <ExternalLink className="h-3 w-3" />
              </Link>
            }
          >
            <BarList
              accent={accent}
              rows={contacts.map((c) => ({
                id: c.contactId,
                label: c.name || c.handle || 'Anonymous visitor',
                sublabel: `${count(c.inbound)} in · ${count(c.outbound)} out · ${relativeTime(c.lastAt)}`,
                value: c.inbound + c.outbound,
              }))}
            />
          </Panel>
        </div>
      </div>
    </AnalyticsPageShell>
  )
}
