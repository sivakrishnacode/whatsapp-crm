"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface TierStatusDto {
  /** Raw Meta value, or null if never synced. */
  tier: string | null;
  /** Resolved display label. Always populated. */
  tierLabel: string;
  /** null = unlimited, unknown tier, or unsynced. Check isUnlimited to tell them apart. */
  dailyLimit: number | null;
  isUnlimited: boolean;
  /** Distinct contacts messaged in the last 24h — broadcasts only. */
  used: number;
  /** True in v1: `used` omits automation / flow / inbox sends, so it's a floor. */
  usageIsPartial: boolean;
  remaining: number | null;
  /** GREEN | YELLOW | RED | NA. */
  qualityRating: string | null;
  lastSyncedAt: string | null;
  isStale: boolean;
  tokenExpired: boolean;
}

export interface UseTierStatusReturn {
  status: TierStatusDto | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  /** True when a refresh finished without lastSyncedAt advancing. */
  refreshTimedOut: boolean;
  refresh: () => Promise<void>;
}

/** Background re-fetch while the card is mounted. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Post-refresh polling: how often to re-check, and when to give up. */
const REFRESH_POLL_MS = 1500;
const REFRESH_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WhatsApp messaging tier, quality rating, and approximate 24h usage.
 *
 * Plain fetch + useState — neither SWR nor React Query is a dependency
 * of this app. `/api/whatsapp/*` is a next.config rewrite onto the
 * NestJS backend, so there's no route handler behind this.
 *
 * refresh() polls until lastSyncedAt actually advances rather than
 * waiting a fixed interval: the server makes a live Graph API call of
 * unpredictable duration, so a fixed wait either reports stale data as
 * fresh or gives up while the sync is still in flight.
 */
export function useTierStatus(): UseTierStatusReturn {
  const [status, setStatus] = useState<TierStatusDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTimedOut, setRefreshTimedOut] = useState(false);

  // Guards every setState after an await — the card unmounts on route
  // changes and mid-refresh polling would otherwise write to a dead tree.
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async (): Promise<TierStatusDto | null> => {
    const res = await fetch("/api/whatsapp/tier-status");
    if (!res.ok) {
      throw new Error(`Failed to load messaging limits (${res.status})`);
    }
    return (await res.json()) as TierStatusDto;
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await fetchStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load messaging limits");
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [fetchStatus]);

  useEffect(() => {
    mountedRef.current = true;
    void load();

    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setRefreshTimedOut(false);
    setError(null);

    const before = status?.lastSyncedAt ?? null;

    try {
      const res = await fetch("/api/whatsapp/tier-status/refresh", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Refresh failed (${res.status})`);
      }

      const deadline = Date.now() + REFRESH_TIMEOUT_MS;
      let advanced = false;

      while (Date.now() < deadline) {
        await sleep(REFRESH_POLL_MS);
        if (!mountedRef.current) return;

        let next: TierStatusDto | null = null;
        try {
          next = await fetchStatus();
        } catch {
          continue; // transient — the sync job is still running server-side
        }
        if (!mountedRef.current) return;
        if (!next) continue;

        setStatus(next);
        if (next.lastSyncedAt && next.lastSyncedAt !== before) {
          advanced = true;
          break;
        }
      }

      // Timing out isn't an error — the job may still land. Surface it as
      // a soft "still syncing" note rather than a failure.
      if (!advanced && mountedRef.current) setRefreshTimedOut(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, [fetchStatus, status?.lastSyncedAt]);

  return { status, isLoading, isRefreshing, error, refreshTimedOut, refresh };
}
