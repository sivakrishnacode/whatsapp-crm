'use client'

import type { ReactNode } from 'react'

import { CHANNELS, channelConnectHref } from '@/lib/nav/channels'
import { CHANNEL_ANALYTICS } from '@/lib/analytics/config'
import type { AnalyticsChannel, AnalyticsFilters, ChannelAlert } from '@/lib/analytics/types'
import type { ChannelAnalyticsControls } from '@/hooks/use-channel-analytics'
import { AnalyticsHeader } from './analytics-header'
import { AlertsStrip } from './alerts-strip'
import { ConnectCta } from './connect-cta'
import { KpiTileSkeleton } from './kpi-tile'

/**
 * Frame shared by the three channel analytics pages: header, fix-it
 * strip, and the connect-vs-zeros decision. The widgets themselves are
 * `children`, because that is the only part that genuinely differs per
 * channel.
 */
export function AnalyticsPageShell({
  channel,
  subtitle,
  controls,
  alerts,
  onExport,
  resolveFilterLabel,
  children,
}: {
  channel: AnalyticsChannel
  subtitle: string
  controls: ChannelAnalyticsControls
  alerts: ChannelAlert[]
  onExport: () => void
  resolveFilterLabel?: (key: keyof AnalyticsFilters, value: string) => string | undefined
  children: ReactNode
}) {
  const meta = CHANNELS[channel]
  const config = CHANNEL_ANALYTICS[channel]

  // `connected === null` means the check is still running. Rendering
  // the connect CTA here would flash "connect your channel" at every
  // customer on every page load.
  if (controls.ready && controls.connected === false) {
    return (
      <div className="space-y-5">
        <ConnectCta
          channelLabel={meta.label}
          description={meta.tagline}
          href={channelConnectHref(channel)}
          icon={meta.icon}
          accent={config.accent}
          gradient={config.gradient}
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <AnalyticsHeader
        title={`${meta.label} analytics`}
        subtitle={subtitle}
        accent={config.accent}
        gradient={config.gradient}
        icon={meta.icon}
        range={controls.range}
        onPreset={controls.setPreset}
        onCustomRange={controls.setCustomRange}
        filters={controls.filters}
        onFiltersChange={controls.setFilters}
        resolveFilterLabel={resolveFilterLabel}
        quickActions={config.quickActions}
        onRefresh={controls.refresh}
        refreshing={controls.refreshing}
        lastUpdated={controls.lastUpdated}
        onExport={onExport}
      />

      <AlertsStrip alerts={alerts} hrefs={config.alertHref} />

      {children}
    </div>
  )
}

/** The KPI grid every page opens with. */
export function KpiGrid({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {loading
        ? Array.from({ length: 8 }).map((_, i) => <KpiTileSkeleton key={i} />)
        : children}
    </div>
  )
}
