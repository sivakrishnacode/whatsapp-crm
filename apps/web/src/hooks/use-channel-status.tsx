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
 * WhatsApp, Instagram and Web all have real backends and are fetched
 * here. Phone is still a frame and resolves to `unavailable` from its
 * registry status — there is no config table to query for it.
 */

export type ConnectionState =
  | 'loading'
  | 'connected'
  | 'not_connected'
  /** Reachable but not implemented — Phone today. */
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

    const UNREACHABLE = {
      state: 'not_connected' as const,
      message: 'Could not reach the server to check the connection.',
    };

    // Every live channel is fetched together, and independently: one
    // channel's endpoint being slow or broken must not leave the others
    // stuck on 'loading' forever in the rail.
    (async () => {
      const [whatsapp, instagram, web] = await Promise.allSettled([
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/instagram/config', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/web/config', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;

      setStatuses((prev) => ({
        ...prev,
        whatsapp:
          whatsapp.status === 'fulfilled'
            ? whatsapp.value?.connected
              ? { state: 'connected' }
              : { state: 'not_connected', message: whatsapp.value?.message }
            : UNREACHABLE,
        instagram:
          instagram.status === 'fulfilled'
            ? instagram.value?.connected
              ? { state: 'connected' }
              : {
                  state: 'not_connected',
                  // `last_error` carries the actionable detail — an
                  // expired token, or a webhook subscription that
                  // failed at connect time and left the account
                  // silently receiving nothing.
                  message:
                    instagram.value?.last_error ??
                    (instagram.value?.status === 'token_expired'
                      ? 'Instagram access expired. Reconnect the account.'
                      : undefined),
                }
            : UNREACHABLE,
        web:
          web.status === 'fulfilled'
            ? web.value?.connected
              ? { state: 'connected' }
              : {
                  state: 'not_connected',
                  // Web has no OAuth to fail, so "not connected" has
                  // exactly two causes worth distinguishing: an admin
                  // turned it off, or the snippet has never been seen
                  // loading. The second is the common one on a new
                  // account and needs a next action, not a diagnosis.
                  message:
                    web.value?.last_error ??
                    (web.value?.status === 'disabled'
                      ? 'The web widget is turned off.'
                      : web.value?.allowed_origins?.length === 0
                        ? 'Add your website’s domain to finish setup.'
                        : 'Install the widget snippet on your website.'),
                }
            : UNREACHABLE,
      }));
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

/** Re-run the channel checks — call after saving a connection form. */
export function useRefreshChannelStatus(): () => void {
  return useContext(ChannelStatusContext)?.refresh ?? (() => {});
}
