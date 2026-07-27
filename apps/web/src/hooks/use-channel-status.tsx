'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import { CHANNEL_IDS, CHANNELS, type ChannelId } from '@/lib/nav/channels';

/**
 * Per-channel connection status, fetched once for the whole shell.
 *
 * Why a provider rather than a hook each consumer calls:
 * `GET /api/whatsapp/config` is not a cheap read — it decrypts the
 * stored token and performs a **live Meta `verifyPhoneNumber` round
 * trip** (see `whatsapp-connect.controller.ts`). The rail's status dot,
 * the channel panel's status chip and the onboarding checklist all want
 * this value, so fetching per-consumer would mean three Meta API calls
 * per page load. One fetch, shared.
 *
 * Only WhatsApp has a real backend today. Every other channel resolves
 * to `not_connected` from its registry status — there is no channel
 * table to query yet.
 */

export type ConnectionState =
  | 'loading'
  | 'connected'
  | 'not_connected'
  /** Reachable but not implemented — Instagram / Web / Phone today. */
  | 'unavailable';

export interface ChannelStatus {
  state: ConnectionState;
  /** Human-readable reason when not connected (WhatsApp only). */
  message?: string;
}

type StatusMap = Record<ChannelId, ChannelStatus>;

const ChannelStatusContext = createContext<{
  statuses: StatusMap;
  refresh: () => void;
} | null>(null);

/**
 * Static, so it's computed once at module scope: a channel's registry
 * status never changes at runtime. Only ever read or spread, never
 * mutated, so sharing the reference across consumers is safe.
 */
const INITIAL_STATUSES: StatusMap = CHANNEL_IDS.reduce((acc, id) => {
  acc[id] =
    CHANNELS[id].status === 'live' ? { state: 'loading' } : { state: 'unavailable' };
  return acc;
}, {} as StatusMap);

export function ChannelStatusProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuth();
  const [statuses, setStatuses] = useState<StatusMap>(INITIAL_STATUSES);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        setStatuses((prev) => ({
          ...prev,
          whatsapp: data?.connected
            ? { state: 'connected' }
            : { state: 'not_connected', message: data?.message },
        }));
      } catch {
        if (cancelled) return;
        setStatuses((prev) => ({
          ...prev,
          whatsapp: {
            state: 'not_connected',
            message: 'Could not reach the server to check the connection.',
          },
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, nonce]);

  const value = useMemo(
    () => ({ statuses, refresh: () => setNonce((n) => n + 1) }),
    [statuses],
  );

  return (
    <ChannelStatusContext.Provider value={value}>
      {children}
    </ChannelStatusContext.Provider>
  );
}

/**
 * Read channel statuses. Safe to call outside the provider (returns the
 * initial map) so a component can be rendered in isolation in tests.
 */
export function useChannelStatus(): StatusMap {
  return useContext(ChannelStatusContext)?.statuses ?? INITIAL_STATUSES;
}

/** Re-run the WhatsApp check — call after saving the connection form. */
export function useRefreshChannelStatus(): () => void {
  return useContext(ChannelStatusContext)?.refresh ?? (() => {});
}
