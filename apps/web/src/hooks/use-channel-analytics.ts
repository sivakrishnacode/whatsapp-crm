'use client'

/**
 * Controls shared by all three channel analytics pages: the account,
 * the connection check, the date range, the cross-filters (which live
 * in the URL) and the manual refresh.
 *
 * It deliberately does NOT fetch any widget data. Each page runs its
 * own effect keyed on `dataKey` and loads exactly the datasets it
 * renders — a hook that also owned the data would need every channel's
 * shape in one place, and the WhatsApp page would pay to define
 * Instagram's state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { parseFilters, serialiseFilters } from '@/lib/analytics/filters'
import { customRange, presetRange, type DateRange, type RangePreset } from '@/lib/analytics/range'
import { loadIsConnected } from '@/lib/analytics/queries'
import type { AnalyticsChannel, AnalyticsFilters } from '@/lib/analytics/types'

const DEFAULT_PRESET: RangePreset = 30

export interface ChannelAnalyticsControls {
  accountId: string | null
  /** Null while the check is still in flight — render skeletons, not a CTA. */
  connected: boolean | null
  ready: boolean
  range: DateRange
  setPreset: (preset: RangePreset) => void
  /** Both keys are YYYY-MM-DD and INCLUSIVE. Returns false if unparseable. */
  setCustomRange: (startKey: string, endKey: string) => boolean
  filters: AnalyticsFilters
  setFilters: (next: AnalyticsFilters) => void
  /**
   * Changes whenever anything a query depends on changes, including a
   * manual refresh. Put this in your effect's dependency array — it is
   * one stable primitive instead of an object that is a new reference
   * every render.
   */
  dataKey: string
  lastUpdated: Date | null
  markUpdated: () => void
  refresh: () => void
  refreshing: boolean
}

export function useChannelAnalytics(channel: AnalyticsChannel): ChannelAnalyticsControls {
  const { accountId: activeAccountId } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [accountId, setAccountId] = useState<string | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [ready, setReady] = useState(false)
  const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET))
  const [nonce, setNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Filters are derived from the URL, never mirrored into state. Two
  // copies of the same fact drift the moment someone hits Back.
  const filtersParam = searchParams.toString()
  const filters = useMemo(
    () => parseFilters(new URLSearchParams(filtersParam)),
    [filtersParam],
  )

  useEffect(() => {
    let cancelled = false
    const db = createClient()
    void (async () => {
      // The ACTIVE workspace, from the one resolver — not re-derived here.
      // Every analytics RPC takes p_account_id and guards it with
      // analytics_guard, so passing the wrong one returns an error rather
      // than another workspace's numbers; passing a merged one was never
      // expressible. The risk this removes is subtler: two resolvers
      // disagreeing meant the chart header and the chart body could describe
      // different workspaces.
      const id = activeAccountId
      if (cancelled) return
      setAccountId(id)
      if (!id) {
        setConnected(false)
        setReady(true)
        return
      }
      const isConnected = await loadIsConnected(db, id, channel)
      if (cancelled) return
      setConnected(isConnected)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [channel, activeAccountId])

  const setPreset = useCallback((preset: RangePreset) => {
    setRange(presetRange(preset))
  }, [])

  const setCustomRange = useCallback((startKey: string, endKey: string) => {
    const next = customRange(startKey, endKey)
    if (!next) return false
    setRange(next)
    return true
  }, [])

  const setFilters = useCallback(
    (next: AnalyticsFilters) => {
      const params = serialiseFilters(next)
      const qs = params.toString()
      // `scroll: false` — a filter change re-renders the same page and
      // jumping to the top loses the widget the user just clicked.
      router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false })
    },
    [router],
  )

  const refresh = useCallback(() => {
    setRefreshing(true)
    setNonce((n) => n + 1)
  }, [])

  const markUpdated = useCallback(() => {
    setLastUpdated(new Date())
    setRefreshing(false)
  }, [])

  const dataKey = useMemo(
    () =>
      [
        accountId ?? '',
        range.start.getTime(),
        range.end.getTime(),
        filtersParam,
        nonce,
      ].join('|'),
    [accountId, range, filtersParam, nonce],
  )

  return {
    accountId,
    connected,
    ready,
    range,
    setPreset,
    setCustomRange,
    filters,
    setFilters,
    dataKey,
    lastUpdated,
    markUpdated,
    refresh,
    refreshing,
  }
}
