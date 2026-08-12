"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { InboxPresence } from "@/lib/inbox/collision";

/**
 * Live "who is in which thread" for one workspace's inbox.
 *
 * ONE CHANNEL PER ACCOUNT, not per conversation. Switching threads is
 * then a `track()` on a channel that is already open, rather than an
 * unsubscribe/resubscribe pair on every click — which at inbox pace
 * would mean a socket teardown every couple of seconds, and would also
 * make it impossible to mark occupied rows in the LIST, since a
 * per-conversation channel only knows about the thread you are already
 * in. The interesting case is exactly the one you have not clicked yet.
 *
 * The channel is PRIVATE (migration 079). The topic ends in the account
 * id, so on a public channel any authenticated user could join another
 * workspace's and watch their agents work. `private: true` puts the
 * join under RLS on `realtime.messages`, where the policy re-states
 * `is_account_member`.
 *
 * Everything here degrades to silence. If the channel fails to
 * authorise, or Realtime is unreachable, `others` stays empty and the
 * inbox behaves exactly as it did before this feature existed — a
 * collision warning that cannot appear is a smaller problem than an
 * inbox that will not load.
 */
export function useInboxPresence({
  accountId,
  userId,
  name,
  conversationId,
  typing,
  enabled = true,
}: {
  accountId: string | null;
  userId: string | null;
  name: string;
  conversationId: string | null;
  typing: boolean;
  enabled?: boolean;
}) {
  const [others, setOthers] = useState<InboxPresence[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const readyRef = useRef(false);

  // Latest values, read by the tracking effect without making it a
  // dependency of the subscribe effect — same reasoning as
  // use-realtime.ts: re-subscribing on every keystroke would be
  // catastrophic here.
  const stateRef = useRef({ userId, name, conversationId, typing });
  useEffect(() => {
    stateRef.current = { userId, name, conversationId, typing };
  });

  const publish = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !readyRef.current) return;
    const s = stateRef.current;
    if (!s.userId) return;
    void channel.track({
      userId: s.userId,
      name: s.name,
      conversationId: s.conversationId,
      typing: s.typing,
      at: Date.now(),
    } satisfies InboxPresence);
  }, []);

  // Subscribe once per account.
  useEffect(() => {
    if (!enabled || !accountId || !userId) return;

    const supabase = createClient();
    const channel = supabase.channel(`inbox-presence:${accountId}`, {
      config: { private: true, presence: { key: `${userId}:${Date.now()}` } },
    });

    const sync = () => {
      // presenceState() is keyed by connection; the values are arrays
      // of everything that connection has tracked. Flatten, then let
      // the pure helpers in lib/inbox/collision.ts dedupe and filter —
      // this hook deliberately holds no policy of its own.
      const state = channel.presenceState<InboxPresence>();
      const flat: InboxPresence[] = [];
      for (const entries of Object.values(state)) {
        for (const e of entries) {
          if (e && typeof e.userId === "string") flat.push(e);
        }
      }
      setOthers(flat);
    };

    channel
      .on("presence", { event: "sync" }, sync)
      .on("presence", { event: "join" }, sync)
      .on("presence", { event: "leave" }, sync)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          readyRef.current = true;
          publish();
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          // Most likely the RLS policy said no (migration 079 not
          // applied yet, or the profile row is missing). Stay quiet
          // rather than surfacing an error the agent cannot act on.
          readyRef.current = false;
          setOthers([]);
        }
      });

    channelRef.current = channel;

    return () => {
      readyRef.current = false;
      channelRef.current = null;
      setOthers([]);
      void supabase.removeChannel(channel);
    };
  }, [accountId, userId, enabled, publish]);

  // Re-announce whenever what we'd say changes.
  useEffect(() => {
    publish();
  }, [conversationId, typing, name, publish]);

  return { others };
}
