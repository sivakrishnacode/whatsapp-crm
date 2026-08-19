"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation } from "@/types";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);
  const { accountId } = useAuth();

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!accountId) {
      // Reset rather than leaving the previous workspace's total on screen.
      countsRef.current = new Map();
      setTotal(0);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    // ⚠️ Explicitly scoped to the ACTIVE workspace. RLS alone would scope this
    // to every workspace the user is a member of (see lib/workspace/scope.ts),
    // so an agency's Inbox dot would count unread threads across all their
    // clients and lead them to an inbox where those threads are not visible.
    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, unread_count")
        .eq("account_id", accountId);
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    const channel = supabase
      // Channel name carries the workspace: two workspaces open in two tabs
      // must not share one channel, or each would apply the other's events.
      .channel(`total-unread-realtime:${accountId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          // Same reason as the initial load. A DELETE payload only carries the
          // replica identity, so an unfiltered subscription cannot even tell
          // which workspace a removed row belonged to.
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, row.unread_count ?? 0);
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [accountId]);

  return total;
}
