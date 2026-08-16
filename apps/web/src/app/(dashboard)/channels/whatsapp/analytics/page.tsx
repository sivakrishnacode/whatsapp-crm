'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Bot,
  Clock,
  ExternalLink,
  Megaphone,
  MessageSquare,
  Radio,
  Send,
  ShoppingCart,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useChannelAnalytics } from '@/hooks/use-channel-analytics'
import { formatCurrency } from '@/lib/currency'
import { CHANNEL_ANALYTICS } from '@/lib/analytics/config'
import { toggleFilter } from '@/lib/analytics/filters'
import { fillDays, previousRangeLabel } from '@/lib/analytics/range'
import { count, dayLabel, duration, rate, relativeTime, truncate } from '@/lib/analytics/format'
import { downloadCsv, exportFilename, joinSections, toCsv } from '@/lib/analytics/export'
import { localDayKey } from '@/lib/dashboard/date-utils'
import {
  loadAlerts,
  loadBroadcastStats,
  loadCommerce,
  loadCtwa,
  loadHeatmap,
  loadKpis,
  loadLeads,
  loadTemplateStats,
  loadTopContacts,
  loadTopProducts,
  loadVolume,
} from '@/lib/analytics/queries'
import type {
  BroadcastStat,
  ChannelAlert,
  ChannelKpis,
  CommercePoint,
  CtwaStat,
  HeatCell,
  LeadPoint,
  TemplateStat,
  TopContact,
  TopProduct,
  VolumePoint,
} from '@/lib/analytics/types'

import { MessagingTierCard } from '@/components/dashboard/messaging-tier-card'
import { AnalyticsPageShell, KpiGrid } from '@/components/analytics/analytics-page-shell'
import { KpiTile } from '@/components/analytics/kpi-tile'
import { Panel, SectionHeading } from '@/components/analytics/panel'
import { ChartLegend, TrendChart } from '@/components/analytics/trend-chart'
import { HourHeatmap } from '@/components/analytics/hour-heatmap'
import { FunnelBar } from '@/components/analytics/funnel-bar'
import { BarList } from '@/components/analytics/bar-list'
import { Column, DataTable, Pill, statusTone } from '@/components/analytics/data-table'

const CHANNEL = 'whatsapp' as const
const { accent, accentAlt } = CHANNEL_ANALYTICS[CHANNEL]

export default function WhatsAppAnalyticsPage() {
  const controls = useChannelAnalytics(CHANNEL)
  const { defaultCurrency } = useAuth()
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
  const [broadcasts, setBroadcasts] = useState<BroadcastStat[]>([])
  const [templates, setTemplates] = useState<TemplateStat[]>([])
  const [commerce, setCommerce] = useState<CommercePoint[]>([])
  const [products, setProducts] = useState<TopProduct[]>([])
  const [ctwa, setCtwa] = useState<CtwaStat[]>([])
  const [alerts, setAlerts] = useState<ChannelAlert[]>([])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    const db = createClient()
    // One Promise.all rather than per-widget effects: they all share
    // the same range and filters, so a partial refresh would put two
    // different windows on screen at once.
    void Promise.all([
      loadKpis(db, accountId, CHANNEL, range, filters),
      loadVolume(db, accountId, CHANNEL, range, filters),
      loadHeatmap(db, accountId, CHANNEL, range),
      loadLeads(db, accountId, CHANNEL, range),
      loadTopContacts(db, accountId, CHANNEL, range),
      loadBroadcastStats(db, accountId, range),
      loadTemplateStats(db, accountId, range),
      loadCommerce(db, accountId, range),
      loadTopProducts(db, accountId, range),
      loadCtwa(db, accountId, range),
      loadAlerts(db, accountId, CHANNEL),
    ])
      .then(([k, v, h, l, c, b, t, cm, p, ct, a]) => {
        if (cancelled) return
        setKpis(k)
        setVolume(v)
        setHeat(h)
        setLeads(l)
        setContacts(c)
        setBroadcasts(b)
        setTemplates(t)
        setCommerce(cm)
        setProducts(p)
        setCtwa(ct)
        setAlerts(a)
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load WhatsApp analytics')
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

  // Server series omit days with no data; pad them so the x-axis is
  // the range the user asked for, not the days that happened to be busy.
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
  const commerceFull = useMemo(
    () =>
      fillDays(range, commerce, (day) => ({
        day,
        orders: 0,
        revenue: 0,
        pending: 0,
        currency: null,
      })),
    [range, commerce],
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

  const labels = volumeFull.map((p) => p.day)
  const comparison = previousRangeLabel(range)
  const currency = commerce.find((c) => c.currency)?.currency ?? defaultCurrency

  const totals = useMemo(() => {
    const orders = commerce.reduce((s, c) => s + c.orders, 0)
    const revenue = commerce.reduce((s, c) => s + c.revenue, 0)
    const clicks = ctwa.reduce((s, c) => s + c.clicks, 0)
    const ctwaConvs = ctwa.reduce((s, c) => s + c.conversations, 0)
    const ctwaConverted = ctwa.reduce((s, c) => s + c.converted, 0)
    const replied = broadcasts.reduce((s, b) => s + b.replied, 0)
    const bSent = broadcasts.reduce((s, b) => s + b.sent, 0)
    const bDelivered = broadcasts.reduce((s, b) => s + b.delivered, 0)
    const bRead = broadcasts.reduce((s, b) => s + b.read, 0)
    return { orders, revenue, clicks, ctwaConvs, ctwaConverted, replied, bSent, bDelivered, bRead }
  }, [commerce, ctwa, broadcasts])

  const resolveFilterLabel = useCallback(
    (key: string, value: string) => {
      if (key === 'broadcastId') return broadcasts.find((b) => b.broadcastId === value)?.name
      return undefined
    },
    [broadcasts],
  )

  const handleExport = useCallback(() => {
    const startKey = localDayKey(range.start)
    const lastDay = new Date(range.end)
    lastDay.setDate(lastDay.getDate() - 1)
    const endKey = localDayKey(lastDay)

    const csv = joinSections([
      {
        title: 'Daily volume',
        csv: toCsv(volumeFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Incoming', value: (r) => r.incoming },
          { header: 'Outgoing', value: (r) => r.outgoing },
          { header: 'Delivered', value: (r) => r.delivered },
          { header: 'Read', value: (r) => r.read },
          { header: 'Failed', value: (r) => r.failed },
        ]),
      },
      {
        title: 'Broadcasts',
        csv: toCsv(broadcasts, [
          { header: 'Name', value: (r) => r.name },
          { header: 'Template', value: (r) => r.templateName },
          { header: 'Status', value: (r) => r.status },
          { header: 'Recipients', value: (r) => r.recipients },
          { header: 'Sent', value: (r) => r.sent },
          { header: 'Delivered', value: (r) => r.delivered },
          { header: 'Read', value: (r) => r.read },
          { header: 'Replied', value: (r) => r.replied },
          { header: 'Failed', value: (r) => r.failed },
        ]),
      },
      {
        title: 'Templates',
        csv: toCsv(templates, [
          { header: 'Template', value: (r) => r.templateName },
          { header: 'Category', value: (r) => r.category },
          { header: 'Meta status', value: (r) => r.status },
          { header: 'Quality', value: (r) => r.qualityScore },
          { header: 'Sends', value: (r) => r.sends },
          { header: 'Delivered', value: (r) => r.delivered },
          { header: 'Read', value: (r) => r.read },
          { header: 'Failed', value: (r) => r.failed },
        ]),
      },
      {
        title: 'Orders',
        csv: toCsv(commerceFull, [
          { header: 'Day', value: (r) => r.day },
          { header: 'Orders', value: (r) => r.orders },
          { header: 'Revenue', value: (r) => r.revenue },
          { header: 'Pending', value: (r) => r.pending },
        ]),
      },
      {
        title: 'Click-to-WhatsApp',
        csv: toCsv(ctwa, [
          { header: 'Campaign', value: (r) => r.name },
          { header: 'Status', value: (r) => r.status },
          { header: 'Clicks', value: (r) => r.clicks },
          { header: 'Conversations', value: (r) => r.conversations },
          { header: 'Converted', value: (r) => r.converted },
        ]),
      },
    ])

    downloadCsv(csv, exportFilename('whatsapp', startKey, endKey))
    toast.success('Export downloaded')
  }, [range, volumeFull, broadcasts, templates, commerceFull, ctwa])

  return (
    <AnalyticsPageShell
      channel={CHANNEL}
      subtitle="Messaging, broadcasts, catalogue and Click-to-WhatsApp performance."
      controls={controls}
      alerts={alerts}
      onExport={handleExport}
      resolveFilterLabel={resolveFilterLabel}
    >
      <KpiGrid loading={loading || !kpis}>
        {kpis && (
          <>
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
              label="Messages received"
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
              label="Delivery rate"
              value={rate(kpis.delivered.current, kpis.msgsOut.current)}
              icon={TrendingUp}
              hint={`${count(kpis.delivered.current)} of ${count(kpis.msgsOut.current)} delivered`}
              trend={volumeFull.map((p) => p.delivered)}
              accent={accent}
            />
            <KpiTile
              label="Read rate"
              value={rate(kpis.read.current, kpis.delivered.current)}
              icon={TrendingUp}
              hint={`${count(kpis.read.current)} of ${count(kpis.delivered.current)} delivered read`}
              trend={volumeFull.map((p) => p.read)}
              accent={accentAlt}
              onClick={() => setFilters(toggleFilter(filters, 'status', 'read'))}
              active={filters.status === 'read'}
            />
            <KpiTile
              label="Failed sends"
              value={count(kpis.failed.current)}
              icon={XCircle}
              current={kpis.failed.current}
              previous={kpis.failed.previous}
              comparisonLabel={comparison}
              trend={volumeFull.map((p) => p.failed)}
              accent="var(--accent-red)"
              invertDelta
              onClick={() => setFilters(toggleFilter(filters, 'status', 'failed'))}
              active={filters.status === 'failed'}
            />
            <KpiTile
              label="New conversations"
              value={count(kpis.convsNew.current)}
              icon={MessageSquare}
              current={kpis.convsNew.current}
              previous={kpis.convsNew.previous}
              comparisonLabel={comparison}
              accent={accent}
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
          </>
        )}
      </KpiGrid>

      {/* ---- Sending capacity ----
          Meta's messaging tier, quality rating and 24-hour usage. It
          used to sit on the main dashboard, which made a cross-channel
          page look like a WhatsApp one; this is the only channel the
          number describes, so this is where it belongs.

          Deliberately NOT range-scoped like everything below it: the
          tier is a live fact about the number right now, not a total
          over the selected window. */}
      <SectionHeading>Sending capacity</SectionHeading>
      <MessagingTierCard />

      {/* ---- Volume & delivery ---- */}
      <SectionHeading>Volume &amp; delivery</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Message volume"
            subtitle="Daily incoming and outgoing messages"
            loading={loading}
            empty={volumeFull.every((p) => p.incoming === 0 && p.outgoing === 0)}
            emptyTitle="No messages in this period"
            emptyHint="Send or receive a WhatsApp message to start populating this chart."
            actions={
              <ChartLegend
                series={[
                  { key: 'in', label: 'Incoming', color: accentAlt, values: [] },
                  { key: 'out', label: 'Outgoing', color: accent, values: [] },
                ]}
              />
            }
          >
            <TrendChart
              labels={labels}
              formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
              series={[
                {
                  key: 'out',
                  label: 'outgoing',
                  color: accent,
                  area: true,
                  values: volumeFull.map((p) => p.outgoing),
                },
                {
                  key: 'in',
                  label: 'incoming',
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
            title="Delivery funnel"
            subtitle="Every outgoing message in this period"
            loading={loading}
            empty={!kpis || kpis.msgsOut.current === 0}
            emptyTitle="Nothing sent in this period"
          >
            {kpis && (
              <FunnelBar
                steps={[
                  { key: 'sent', label: 'Sent', value: kpis.msgsOut.current, color: accent },
                  { key: 'delivered', label: 'Delivered', value: kpis.delivered.current, color: accentAlt },
                  { key: 'read', label: 'Read', value: kpis.read.current, color: '#8134AF' },
                  { key: 'failed', label: 'Failed', value: kpis.failed.current, color: 'var(--accent-red)' },
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
            subtitle="Incoming messages by day and hour, in your timezone"
            loading={loading}
            empty={heat.length === 0}
            emptyTitle="No inbound messages in this period"
          >
            <HourHeatmap cells={heat} accent={accent} />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Most active contacts"
            subtitle="By total messages exchanged"
            loading={loading}
            empty={contacts.length === 0}
            emptyIcon={Users}
          >
            <BarList
              accent={accent}
              rows={contacts.map((c) => ({
                id: c.contactId,
                label: c.name || c.handle || 'Unknown contact',
                sublabel: `${count(c.inbound)} in · ${count(c.outbound)} out · ${relativeTime(c.lastAt)}`,
                value: c.inbound + c.outbound,
              }))}
            />
          </Panel>
        </div>
      </div>

      {/* ---- Broadcasts & templates ---- */}
      <SectionHeading>Broadcasts &amp; templates</SectionHeading>
      <Panel
        title="Broadcast performance"
        subtitle="Click a broadcast to filter this whole page by it"
        icon={Radio}
        loading={loading}
        empty={broadcasts.length === 0}
        emptyTitle="No broadcasts created in this period"
        emptyHint="Broadcasts you send will appear here with delivery and reply rates."
        actions={
          <Link
            href="/channels/whatsapp/broadcasts"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            All broadcasts <ExternalLink className="h-3 w-3" />
          </Link>
        }
      >
        <DataTable
          rows={broadcasts}
          rowKey={(r) => r.broadcastId}
          selectedKey={filters.broadcastId}
          onSelect={(r) => setFilters(toggleFilter(filters, 'broadcastId', r.broadcastId))}
          columns={broadcastColumns}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Template usage"
            subtitle="Counted from messages actually sent, not the library"
            loading={loading}
            empty={templates.length === 0}
            emptyTitle="No template messages in this period"
          >
            <DataTable
              rows={templates}
              rowKey={(r) => r.templateName}
              selectedKey={filters.template}
              onSelect={(r) => setFilters(toggleFilter(filters, 'template', r.templateName))}
              columns={templateColumns}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Broadcast funnel"
            subtitle="Across every broadcast in this period"
            loading={loading}
            empty={totals.bSent === 0}
            emptyTitle="No broadcast sends in this period"
          >
            <FunnelBar
              steps={[
                { key: 'sent', label: 'Sent', value: totals.bSent, color: accent },
                { key: 'delivered', label: 'Delivered', value: totals.bDelivered, color: accentAlt },
                { key: 'read', label: 'Read', value: totals.bRead, color: '#8134AF' },
                { key: 'replied', label: 'Replied', value: totals.replied, color: 'var(--accent-amber)' },
              ]}
            />
          </Panel>
        </div>
      </div>

      {/* ---- Commerce & Click-to-WhatsApp ---- */}
      <SectionHeading>Commerce &amp; Click-to-WhatsApp</SectionHeading>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Orders and revenue"
            subtitle={`${count(totals.orders)} orders · ${formatCurrency(totals.revenue, currency)} in this period`}
            icon={ShoppingCart}
            loading={loading}
            empty={commerceFull.every((c) => c.orders === 0)}
            emptyTitle="No catalogue orders in this period"
            emptyHint="Orders placed from your WhatsApp catalogue appear here."
            actions={
              <Link
                href="/channels/whatsapp/commerce?tab=orders"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                All orders <ExternalLink className="h-3 w-3" />
              </Link>
            }
          >
            <TrendChart
              labels={commerceFull.map((c) => c.day)}
              formatLabel={(l) => (l.length === 10 ? dayLabel(l) : l)}
              series={[
                {
                  key: 'revenue',
                  label: currency,
                  color: accent,
                  area: true,
                  values: commerceFull.map((c) => c.revenue),
                },
                {
                  key: 'orders',
                  label: 'orders',
                  color: accentAlt,
                  values: commerceFull.map((c) => c.orders),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Top products"
            subtitle="By revenue in this period"
            loading={loading}
            empty={products.length === 0}
            emptyTitle="No products ordered in this period"
          >
            <BarList
              accent={accent}
              rows={products.map((p) => ({
                id: p.retailerId,
                label: p.title || p.retailerId,
                sublabel: `${count(p.units)} unit${p.units === 1 ? '' : 's'}`,
                value: p.revenue,
                display: formatCurrency(p.revenue, currency),
              }))}
            />
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel
            title="Click-to-WhatsApp campaigns"
            subtitle="Ad clicks that became conversations"
            icon={Megaphone}
            loading={loading}
            empty={ctwa.length === 0}
            emptyTitle="No Click-to-WhatsApp campaigns yet"
            emptyHint="Publish a Click-to-WhatsApp ad to see click-through attribution here."
          >
            <DataTable rows={ctwa} rowKey={(r) => r.campaignId} columns={ctwaColumns} />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel
            title="Click-to-conversation"
            subtitle="Across every campaign"
            loading={loading}
            empty={totals.clicks === 0}
            emptyTitle="No ad clicks in this period"
          >
            <FunnelBar
              steps={[
                { key: 'clicks', label: 'Ad clicks', value: totals.clicks, color: accent },
                { key: 'convs', label: 'Conversations started', value: totals.ctwaConvs, color: accentAlt },
                { key: 'converted', label: 'Converted', value: totals.ctwaConverted, color: '#8134AF' },
              ]}
            />
          </Panel>
        </div>
      </div>

      {/* ---- Leads ---- */}
      <SectionHeading>Leads &amp; pipeline</SectionHeading>
      <Panel
        title="Contacts and deals from WhatsApp"
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
              { key: 'w', label: 'Deals won', color: '#8134AF', values: [] },
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
              color: '#8134AF',
              dashed: true,
              values: leadsFull.map((l) => l.dealsWon),
            },
          ]}
          formatValue={(v) => v.toLocaleString()}
        />
      </Panel>
    </AnalyticsPageShell>
  )
}

// ------------------------------------------------------------
// Column definitions. Outside the component so they are not rebuilt
// on every render.
// ------------------------------------------------------------

const broadcastColumns: Column<BroadcastStat>[] = [
  {
    key: 'name',
    header: 'Broadcast',
    cell: (r) => <span className="font-medium">{truncate(r.name, 40)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
  },
  {
    key: 'template',
    header: 'Template',
    cell: (r) => <span className="text-muted-foreground">{truncate(r.templateName, 28)}</span>,
  },
  { key: 'recipients', header: 'Recipients', align: 'right', cell: (r) => count(r.recipients) },
  { key: 'sent', header: 'Sent', align: 'right', cell: (r) => count(r.sent) },
  {
    key: 'delivered',
    header: 'Delivered',
    align: 'right',
    cell: (r) => rate(r.delivered, r.sent, 0),
  },
  { key: 'read', header: 'Read', align: 'right', cell: (r) => rate(r.read, r.delivered, 0) },
  { key: 'replied', header: 'Replied', align: 'right', cell: (r) => count(r.replied) },
  {
    key: 'failed',
    header: 'Failed',
    align: 'right',
    cell: (r) =>
      r.failed > 0 ? <span className="text-accent-red">{count(r.failed)}</span> : '—',
  },
]

const templateColumns: Column<TemplateStat>[] = [
  {
    key: 'name',
    header: 'Template',
    cell: (r) => <span className="font-medium">{truncate(r.templateName, 32)}</span>,
  },
  {
    key: 'status',
    header: 'Meta status',
    cell: (r) =>
      r.status ? (
        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
      ) : (
        <span className="text-xs text-muted-foreground">not in library</span>
      ),
  },
  { key: 'sends', header: 'Sends', align: 'right', cell: (r) => count(r.sends) },
  {
    key: 'delivered',
    header: 'Delivered',
    align: 'right',
    cell: (r) => rate(r.delivered, r.sends, 0),
  },
  { key: 'read', header: 'Read', align: 'right', cell: (r) => rate(r.read, r.delivered, 0) },
  {
    key: 'failed',
    header: 'Failed',
    align: 'right',
    cell: (r) =>
      r.failed > 0 ? <span className="text-accent-red">{count(r.failed)}</span> : '—',
  },
]

const ctwaColumns: Column<CtwaStat>[] = [
  {
    key: 'name',
    header: 'Campaign',
    cell: (r) => <span className="font-medium">{truncate(r.name, 40)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
  },
  { key: 'clicks', header: 'Clicks', align: 'right', cell: (r) => count(r.clicks) },
  {
    key: 'convs',
    header: 'Conversations',
    align: 'right',
    cell: (r) => count(r.conversations),
  },
  {
    key: 'rate',
    header: 'Click → chat',
    align: 'right',
    cell: (r) => rate(r.conversations, r.clicks, 0),
  },
  { key: 'converted', header: 'Converted', align: 'right', cell: (r) => count(r.converted) },
]
