'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WidgetBootstrap, WidgetMessage } from './widget-types';

const TOKEN_KEY_PREFIX = 'c360.session.';

/**
 * The widget's whole client-side lifecycle: bootstrap, session, history,
 * live stream, send.
 *
 * WHY THE SESSION TOKEN LIVES IN localStorage AND NOT A COOKIE
 *   The frame is third-party to the page it is embedded in, so a cookie we
 *   set is a third-party cookie — blocked outright by Safari's ITP and by
 *   Firefox's total cookie protection, and on its way out in Chrome. A
 *   widget that loses its session on every reload in Safari is a widget
 *   that loses conversations. localStorage inside the iframe is partitioned
 *   per top-level site in exactly the same way, but it is not *blocked*.
 *
 *   Keyed per widget key so two accounts' widgets on the same page (an
 *   agency testing, a multi-brand site) cannot read each other's session.
 *
 * WHY IT RE-FETCHES HISTORY ON EVERY RECONNECT
 *   SSE is at-most-once and Redis pub/sub drops events for a channel with
 *   no live subscriber. Anything sent while the visitor was disconnected
 *   simply never arrives on the stream. Re-fetching on reconnect is what
 *   makes the stream an accelerator rather than the source of truth — the
 *   alternative is a visitor who missed a reply and never learns of it.
 */
export function useWidgetSession(widgetKey: string) {
  const [bootstrap, setBootstrap] = useState<WidgetBootstrap | null>(null);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const tokenKey = `${TOKEN_KEY_PREFIX}${widgetKey}`;
  const sourceRef = useRef<EventSource | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  // Kept in a ref as well as state so the stream's callbacks read the
  // current token without being re-created (which would tear down and
  // rebuild the EventSource on every message).
  const tokenRef = useRef<string | null>(null);

  const readStoredToken = useCallback((): string | null => {
    try {
      return window.localStorage.getItem(tokenKey);
    } catch {
      // Private mode / storage disabled. The chat still works for this
      // page view; it just cannot be resumed later.
      return null;
    }
  }, [tokenKey]);

  const storeToken = useCallback(
    (token: string) => {
      tokenRef.current = token;
      setSessionToken(token);
      try {
        window.localStorage.setItem(tokenKey, token);
      } catch {
        /* see readStoredToken */
      }
    },
    [tokenKey],
  );

  const clearToken = useCallback(() => {
    tokenRef.current = null;
    setSessionToken(null);
    setError(null);
    try {
      window.localStorage.removeItem(tokenKey);
    } catch {
      /* ignore */
    }
  }, [tokenKey]);

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      headers.set('X-Widget-Key', widgetKey);
      if (tokenRef.current) {
        headers.set('Authorization', `Bearer ${tokenRef.current}`);
      }
      return fetch(`/api/public/web${path}`, {
        ...init,
        headers,
        cache: 'no-store',
      });
    },
    [widgetKey],
  );

  // 1. Bootstrap — appearance and open/closed. Runs once, before the
  //    visitor has interacted, so it must not create a contact.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api('/bootstrap');
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(body?.message ?? 'Chat is unavailable.');
        }
        if (!cancelled) setBootstrap((await res.json()) as WidgetBootstrap);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Chat is unavailable.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const refreshHistory = useCallback(async () => {
    const res = await api('/messages');
    if (!res.ok) return;
    const body = (await res.json()) as { messages: WidgetMessage[] };
    // Replaces wholesale rather than merging: the server's view is
    // authoritative, and any optimistic bubble still pending has by
    // definition been either persisted (so it is in this list) or lost.
    setMessages(body.messages);
  }, [api]);

  const connectStream = useCallback(() => {
    if (!tokenRef.current) return;
    sourceRef.current?.close();

    // EventSource cannot set headers, so both credentials go in the query
    // string — see the API's stream controller for why that is acceptable
    // here.
    const url = `/api/public/web/stream?widget_key=${encodeURIComponent(
      widgetKey,
    )}&session=${encodeURIComponent(tokenRef.current)}`;

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    source.onmessage = (event: MessageEvent<string>) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (payload.type === 'message') {
        const incoming = payload.message as WidgetMessage;
        setMessages((prev) => {
          // The server echoes our own sends back. Replace the optimistic
          // bubble instead of appending, or the visitor sees their message
          // twice.
          const withoutPending = prev.filter(
            (m) =>
              !(
                m.pending &&
                m.sender_type === 'customer' &&
                m.content_text === incoming.content_text
              ),
          );
          if (withoutPending.some((m) => m.id === incoming.id)) {
            return withoutPending;
          }
          return [...withoutPending, incoming];
        });
        // An agent reply means they are no longer typing.
        if (incoming.sender_type !== 'customer') setAgentTyping(false);
      } else if (payload.type === 'typing') {
        setAgentTyping(true);
        if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
        // Self-expiring: a "stopped typing" event that never arrives
        // (agent closed the tab) would otherwise leave the dots up forever.
        typingTimerRef.current = window.setTimeout(
          () => setAgentTyping(false),
          8000,
        );
      } else if (payload.type === 'read') {
        setMessages((prev) =>
          prev.map((m) =>
            m.sender_type === 'customer' ? { ...m, status: 'read' } : m,
          ),
        );
      }
    };

    source.onerror = () => {
      setConnected(false);
      // EventSource reconnects on its own using the server's `retry:`
      // hint, so no manual backoff here. What it does NOT do is replay
      // what was missed — hence the history refresh on reopen.
      void refreshHistory();
    };
  }, [widgetKey, refreshHistory]);

  /**
   * Open the chat. Called on first interaction, never on page load:
   * creating a contact and a conversation for every pageview would fill
   * the CRM with rows for people who never engaged.
   */
  const start = useCallback(
    async (profile?: { name?: string; email?: string; phone?: string }) => {
      if (starting) return;
      setStarting(true);
      try {
        const stored = readStoredToken();
        const res = await api('/session', {
          method: 'POST',
          body: JSON.stringify({
            session_token: stored ?? undefined,
            page_url: window.location.href,
            referrer: document.referrer || undefined,
            profile,
          }),
        });
        if (!res.ok) throw new Error('Could not start the chat.');

        const body = (await res.json()) as {
          session_token: string;
          messages: WidgetMessage[];
          agent_typing: boolean;
        };
        storeToken(body.session_token);
        setMessages(body.messages);
        setAgentTyping(body.agent_typing);
        connectStream();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start the chat.');
      } finally {
        setStarting(false);
      }
    },
    [api, connectStream, readStoredToken, starting, storeToken],
  );

  const send = useCallback(
    async (input: {
      text?: string;
      mediaUrl?: string;
      contentType?: WidgetMessage['content_type'];
      replyId?: string;
    }) => {
      // Optimistic bubble, so the message appears on the keystroke rather
      // than after a round trip. Reconciled by id when the echo lands.
      const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          sender_type: 'customer',
          content_type: input.contentType ?? 'text',
          content_text: input.text ?? null,
          media_url: input.mediaUrl ?? null,
          interactive_reply_id: input.replyId ?? null,
          metadata: null,
          created_at: new Date().toISOString(),
          pending: true,
        },
      ]);

      try {
        const res = await api('/messages', {
          method: 'POST',
          body: JSON.stringify({
            text: input.text,
            media_url: input.mediaUrl,
            content_type: input.contentType ?? 'text',
            reply_id: input.replyId,
            page_url: window.location.href,
          }),
        });

        if (res.status === 401) {
          // The session expired or its rows are gone. Drop the token and
          // start fresh rather than leaving the visitor in a dead chat.
          clearToken();
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
          await start();
          return;
        }
        if (!res.ok) throw new Error('send failed');

        const body = (await res.json()) as { id: string; created_at: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId
              ? { ...m, id: body.id, created_at: body.created_at, pending: false }
              : m,
          ),
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId ? { ...m, pending: false, failed: true } : m,
          ),
        );
      }
    },
    [api, clearToken, start],
  );

  /** Debounced by the caller; this just pings. Failure is ignorable. */
  const notifyTyping = useCallback(() => {
    void api('/typing', { method: 'POST' }).catch(() => undefined);
  }, [api]);

  const markRead = useCallback(() => {
    void api('/read', { method: 'POST' }).catch(() => undefined);
  }, [api]);

  const upload = useCallback(
    async (file: File): Promise<{ url: string; kind: string } | null> => {
      const buffer = await file.arrayBuffer();
      // Chunked rather than `String.fromCharCode(...bytes)`: spreading a
      // multi-megabyte array into an argument list blows the call stack.
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }

      const res = await api('/upload', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          data_base64: window.btoa(binary),
        }),
      });
      if (!res.ok) return null;
      return (await res.json()) as { url: string; kind: string };
    },
    [api],
  );

  // Resume automatically when a previous visit left a token — this is what
  // makes a returning visitor see their history instead of a blank chat.
  useEffect(() => {
    const stored = readStoredToken();
    if (!stored || tokenRef.current) return;
    tokenRef.current = stored;
    setSessionToken(stored);
    void (async () => {
      const res = await api('/messages');
      if (res.ok) {
        const body = (await res.json()) as { messages: WidgetMessage[] };
        setMessages(body.messages);
        connectStream();
      } else {
        // Token no longer usable. Clear it so `start()` creates a new
        // session rather than replaying a dead one forever.
        clearToken();
      }
    })();
  }, [api, clearToken, connectStream, readStoredToken]);

  useEffect(
    () => () => {
      sourceRef.current?.close();
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    },
    [],
  );

  return {
    bootstrap,
    messages,
    connected,
    agentTyping,
    error,
    hasSession: sessionToken !== null,
    /**
     * Exposed so in-widget forms can post to the session-authenticated
     * endpoint. Safe to hand to a child in this frame: it is already in this
     * browser's localStorage, and the frame is same-origin to itself.
     */
    sessionToken,
    starting,
    start,
    send,
    notifyTyping,
    markRead,
    upload,
    refreshHistory,
  };
}
