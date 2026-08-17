"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// How many messages to show initially and load per "older" batch.
// 50 keeps the initial paint fast while covering the vast majority of
// active thread contexts without needing to scroll up.
const MESSAGE_PAGE_SIZE = 50;
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { conversationChannel } from "@/lib/inbox/channel";
import {
  buildReactionRequest,
  channelSupportsReactions,
  quickEmojisFor,
} from "@/lib/inbox/reactions";
import { collisionLabel, type InboxPresence } from "@/lib/inbox/collision";
import {
  contactDisplayName as displayNameFor,
  contactHandle,
  contactInitial,
} from "@/lib/contacts/display";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  Bot,
  BotOff,
  PanelRightOpen,
  PanelRightClose,
  Users,
} from "lucide-react";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker, type TemplateSendValues } from "./template-picker";
import { buildReplyPreview } from "./reply-quote";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

/** Just enough of an agent to offer it as an owner. */
interface OwnerAgent {
  id: string;
  name: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /** Reflect an AI-pause toggle back into the page's conversation state. */
  onAiAutoReplyChange: (conversationId: string, disabled: boolean) => void;
  /**
   * Reflect an owner change to an AI agent back into the page's state.
   * Optional so existing callers keep compiling; without it the header
   * still writes the latch, it just won't re-render the new owner until
   * the next fetch.
   */
  onAiAgentChange?: (conversationId: string, aiAgentId: string | null) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  /**
   * Teammates who also have this thread open, self already excluded
   * (see lib/inbox/collision.ts). Empty when nobody else is here.
   */
  viewers?: InboxPresence[];
  /** Bubbles the composer's draft state up for the collision warning. */
  onComposingChange?: (composing: boolean) => void;
}

function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMMM d, yyyy");
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: { label: string; value: ConversationStatus; color: string }[] = [
  { label: "Open", value: "open", color: "text-primary" },
  { label: "Pending", value: "pending", color: "text-warning" },
  { label: "Closed", value: "closed", color: "text-muted-foreground" },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onAiAutoReplyChange,
  onAiAgentChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  viewers,
  onComposingChange,
}: MessageThreadProps) {
  const { user } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the NEXT scroll-to-bottom should be suppressed.
  // Set to true before loading older messages so the viewport doesn't
  // jump down to the bottom after prepending earlier messages.
  const suppressNextScrollRef = useRef(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Timestamp of the oldest currently-loaded message, used as cursor
  // for the "load older" fetch.
  const oldestMessageAtRef = useRef<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  /**
   * The workspace's AI agents, so the Owner dropdown can hand a thread to
   * one. Only ACTIVE agents are offered: assigning a paused agent would
   * set a latch the resolver then refuses (it filters on `is_active`),
   * leaving a thread owned by something that will never answer.
   */
  const [aiAgents, setAiAgents] = useState<OwnerAgent[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Agents come from the API, not from PostgREST: `ai_agents` carries the
  // workspace's AI configuration and the list endpoint is already the one
  // place that decides what a client may see of it.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai/agents", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = Array.isArray(body?.agents) ? body.agents : [];
        setAiAgents(
          rows
            .filter((a: OwnerAgent & { is_active?: boolean }) => a.is_active)
            .map((a: OwnerAgent) => ({ id: a.id, name: a.name })),
        );
      })
      .catch(() => {
        // Non-fatal: the dropdown falls back to teammates only. Owning a
        // thread by hand must not depend on the AI list loading.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Which platform this thread replies on. Drives the send endpoint,
  // the composer's affordances, and how delivery status is rendered.
  const channel = conversation
    ? conversationChannel(conversation)
    : "whatsapp";
  const SEND_PATHS: Record<typeof channel, string> = {
    whatsapp: "/api/whatsapp/send",
    instagram: "/api/instagram/send",
    web: "/api/web/send",
  };
  const sendPath = SEND_PATHS[channel];
  // Empty on a channel with no reaction transport, which hides the
  // button rather than offering one that always fails.
  const quickEmojis = quickEmojisFor(channel);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    // Web has NO messaging window — we own the transport, so there is no
    // third party imposing a re-engagement rule
    // (CHANNEL_CAPABILITIES.web.replyWindowHours is null). Returning
    // "never expired" here is what keeps the composer enabled and the
    // countdown chip hidden; without it a web thread would lock an agent
    // out 24 hours after the visitor's last message for no reason.
    if (channel === "web") return { expired: false, remaining: "" };

    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) return { expired: true, remaining: "No customer messages" };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: "Expired" };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? `${Math.floor(hoursLeft)}h remaining`
        : `${Math.floor(hoursLeft * 60)}m remaining`;

    return { expired, remaining };
  }, [messages, channel]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Capped at
  // MESSAGE_PAGE_SIZE most-recent rows — the query fetches DESC then the
  // result is reversed so the thread renders oldest-first.
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);
      setHasMoreMessages(false);
      oldestMessageAtRef.current = null;

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        // Fetch newest-first so LIMIT trims old history, then reverse below.
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
      } else {
        // Reverse so messages render oldest → newest (natural chat order).
        const ordered = (data ?? []).slice().reverse();
        onMessagesLoadedRef.current(ordered);

        // If we got exactly PAGE_SIZE rows there may be older ones.
        setHasMoreMessages((data?.length ?? 0) >= MESSAGE_PAGE_SIZE);

        // Record the oldest visible message as the cursor for load-older.
        const oldest = ordered[0]?.created_at ?? null;
        oldestMessageAtRef.current = oldest;
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to reset unread_count:", error);
      });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages, UNLESS we just prepended
  // older history (suppressNextScrollRef) — in that case keep the
  // viewport stable so the user can read what they loaded.
  useEffect(() => {
    if (suppressNextScrollRef.current) {
      suppressNextScrollRef.current = false;
      return;
    }
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // ── Load older messages ─────────────────────────────────────────
  const handleLoadOlderMessages = useCallback(async () => {
    if (!conversationId || loadingOlderMessages || !hasMoreMessages) return;
    const cursor = oldestMessageAtRef.current;
    if (!cursor) return;

    setLoadingOlderMessages(true);

    const supabase = createClient();
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      // Strictly older than the cursor (exclusive)
      .lt("created_at", cursor)
      .limit(MESSAGE_PAGE_SIZE);

    if (error) {
      console.error("Failed to load older messages:", error);
      setLoadingOlderMessages(false);
      return;
    }

    const older = (data ?? []).slice().reverse();

    if (older.length > 0) {
      // Suppress the scroll-to-bottom that fires when messages changes.
      suppressNextScrollRef.current = true;

      // Capture scroll position BEFORE prepending so we can restore it.
      const el = scrollRef.current;
      const prevScrollHeight = el?.scrollHeight ?? 0;

      onMessagesLoadedRef.current([...older, ...messages]);

      // Restore scroll position after React paints the new rows.
      requestAnimationFrame(() => {
        if (el) {
          const newScrollHeight = el.scrollHeight;
          el.scrollTop = newScrollHeight - prevScrollHeight;
        }
      });

      const newOldest = older[0]?.created_at ?? null;
      oldestMessageAtRef.current = newOldest;
    }

    setHasMoreMessages((data?.length ?? 0) >= MESSAGE_PAGE_SIZE);
    setLoadingOlderMessages(false);
  }, [
    conversationId,
    loadingOlderMessages,
    hasMoreMessages,
    messages,
  ]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch(sendPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(`Failed to send: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Document"
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch(sendPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleSendProduct = useCallback(
    async (params: {
      productRetailerId: string;
      bodyText?: string;
      footerText?: string;
    }) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: JSON.stringify({
          type: "product",
          retailer_id: params.productRetailerId,
          name: params.bodyText || "Product Message",
          price: params.footerText || "",
        }),
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch(sendPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "product",
            interactive_product_params: {
              productRetailerId: params.productRetailerId,
              bodyText: params.bodyText,
              footerText: params.footerText,
            },
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send product message:", reason);
          toast.error(`Failed to send product: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send product message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send product: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleSendProductList = useCallback(
    async (params: {
      headerText: string;
      bodyText: string;
      footerText?: string;
      sections: Array<{
        title: string;
        productRetailerIds: string[];
      }>;
    }) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: JSON.stringify({
          type: "product_list",
          title: params.headerText,
          sections: params.sections,
        }),
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch(sendPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "product_list",
            interactive_product_params: {
              headerText: params.headerText,
              bodyText: params.bodyText,
              footerText: params.footerText,
              sections: params.sections,
            },
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send product list message:", reason);
          toast.error(`Failed to send product list: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send product list message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send product list: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (template: MessageTemplate, values: TemplateSendValues) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(
        template.body_text,
        values.body ?? [],
      );
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch(sendPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the send-builder path (header
            // text/media/location and per-button substitution). Passed
            // through whole rather than field-by-field: a template can
            // require any subset, and enumerating them here is how a
            // LOCATION header came to be silently dropped and then
            // rejected by Meta. Body values are mirrored under both
            // shapes so the route can fall back if the template row
            // isn't found locally.
            template_message_params: values,
            template_params: values.body ?? [],
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(`Failed to send template: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send template: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  // "Customer" rather than "Unknown" here: this labels who *said* a
  // message, where a generic noun reads better than a placeholder.
  const contactDisplayName = contact
    ? displayNameFor(contact)
    : "Customer";

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "You" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg),
      });
    },
    [authorLabelFor],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  //
  // ⚠️ The endpoint is per CHANNEL. This used to post everything to
  // /api/whatsapp/react, which resolves the recipient by `contacts.phone`
  // — a column an Instagram contact has no value in — so every Instagram
  // react failed with "Contact phone number not found".
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error("Wait for the message to finish sending");
        return;
      }

      const convId = conversation.id;
      const userId = user.id;

      // Built before the optimistic update so an unsupported emoji never
      // paints a pill it would have to roll back.
      const request = buildReactionRequest({
        channel,
        conversationId: convId,
        messageId,
        emoji,
      });
      if (!request) {
        toast.error(
          channelSupportsReactions(channel)
            ? "Instagram doesn't support that reaction"
            : "Reactions aren't available on this channel",
        );
        return;
      }

      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch(request.path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.body),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Reaction failed: ${reason}`);
        setReactions(snapshot);
      }
    },
    [channel, conversation, user?.id],
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ assigned_agent_id: agentId })
        .eq("id", conversation.id);

      if (error) {
        console.error("Failed to update assignment:", error);
        toast.error("Failed to update assignment");
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange],
  );

  /**
   * Hand the thread to one of the workspace's AI agents.
   *
   * ⚠️ THREE COLUMNS, ONE MEANING. Ownership is spread across
   * `assigned_agent_id` (a human, which silences the bot at
   * AiReplyService's gate), `ai_agent_id` (the sticky routing latch the
   * resolver reads FIRST) and `ai_autoreply_disabled` (a per-thread
   * pause, set by a handoff). Writing only the latch would produce a
   * thread that says an agent owns it and stays mute — which is exactly
   * the class of confusion this control exists to remove. So picking an
   * agent asserts all three.
   *
   * `ai_agent_id` is left ALONE when a human takes over, deliberately:
   * the human gate silences the bot anyway, and keeping the latch means
   * unassigning later resumes the same agent rather than re-routing to
   * whoever happens to be first by priority — a customer should not get a
   * new name and a new tone because a thread changed hands twice.
   *
   * Known residual: this is a PostgREST write, so RLS (row-level) permits
   * any uuid in `ai_agent_id` for a row the caller owns — a crafted
   * request could name another tenant's agent. It buys nothing: the
   * resolver looks the latch up with `{id, account_id, is_active}`, so a
   * foreign id simply misses and routing proceeds normally, and this
   * dropdown resolves names from the account's own list so it renders as
   * unowned. Closing it properly means a CHECK/trigger or moving the
   * write behind the API.
   */
  const handleAssignAiAgent = useCallback(
    async (aiAgentId: string) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({
          ai_agent_id: aiAgentId,
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
        })
        .eq("id", conversation.id);

      if (error) {
        console.error("Failed to assign AI agent:", error);
        toast.error("Could not hand this conversation to the agent");
        return;
      }

      onAssignChange(conversation.id, null);
      onAiAgentChange?.(conversation.id, aiAgentId);
      onAiAutoReplyChange(conversation.id, false);
    },
    [conversation, onAssignChange, onAiAgentChange, onAiAutoReplyChange],
  );

  /**
   * Turn the AI bot back on (or off) for this thread.
   *
   * The pause is applied automatically by the API the moment a human
   * replies, so without a visible control the bot would appear to have
   * broken itself with no way back. This is that way back.
   */
  const handleAiAutoReplyToggle = useCallback(async () => {
    if (!conversation) return;
    const next = !(conversation.ai_autoreply_disabled ?? false);

    // Optimistic, then rolled back on failure — the same shape the row
    // menu uses. An RLS-blocked UPDATE affects zero rows without
    // raising, so the button would otherwise lie.
    onAiAutoReplyChange(conversation.id, next);
    const { data, error } = await createClient()
      .from("conversations")
      .update({ ai_autoreply_disabled: next })
      .eq("id", conversation.id)
      .select("id");

    if (error || !data || data.length === 0) {
      onAiAutoReplyChange(conversation.id, !next);
      toast.error(
        error ? "Could not change the AI setting" : "You do not have permission",
      );
      return;
    }
    toast.success(next ? "AI replies paused" : "AI replies resumed");
  }, [conversation, onAiAutoReplyChange]);

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          Select a conversation
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose a conversation from the left to start messaging
        </p>
      </div>
    );
  }

  // Instagram contacts have no phone — see lib/contacts/display.
  const displayName = displayNameFor(contact);
  const contactSubtitle = contactHandle(contact);
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const collisionWarning = collisionLabel(viewers ?? []);
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);

  /**
   * WHO OWNS THIS THREAD — one answer, derived in the order the runtime
   * resolves it.
   *
   * A human assignment wins because that is what AiReplyService checks
   * first: with `assigned_agent_id` set the bot is silent no matter what
   * the AI columns say. Then a paused bot, then the agent on the latch,
   * then nobody-in-particular (an active agent may still pick it up by
   * routing, which "AI" without a name honestly describes).
   *
   * This replaced a separate `AI on` badge that read
   * `ai_autoreply_disabled` alone — so a thread assigned to a teammate
   * displayed "AI on" while the assignment was the very thing keeping the
   * bot quiet. Two controls, two different fields, one contradiction.
   */
  const ownerAgent = conversation.ai_agent_id
    ? aiAgents.find((a) => a.id === conversation.ai_agent_id)
    : undefined;
  const aiPaused = conversation.ai_autoreply_disabled === true;

  const owner: { label: string; kind: 'human' | 'ai' | 'paused' | 'none' } =
    assignedAgentId
      ? { label: currentAssignee?.full_name ?? 'Assigned', kind: 'human' }
      : aiPaused
        ? { label: 'AI paused', kind: 'paused' }
        : ownerAgent
          ? { label: ownerAgent.name, kind: 'ai' }
          : { label: 'Unassigned', kind: 'none' };

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn("flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to conversations"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
            {contactInitial(contact)}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">{contactSubtitle}</p>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              "ml-1 hidden gap-1 border-border text-[10px] sm:inline-flex sm:ml-2",
              sessionInfo.expired ? "text-destructive" : "text-primary"
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? "Hide contact panel" : "Show contact panel"
              }
              aria-pressed={contactPanelOpen}
              title={contactPanelOpen ? "Hide contact" : "Show contact"}
              className={cn(
                "hidden h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                contactPanelOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label="Refresh conversation"
              title="Refresh"
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </button>
          )}

          {/* Pause / resume the bot on this thread.
              Kept as its own switch even though the Owner control below
              can hand the thread to an agent: "stop replying for a
              minute" and "this belongs to Nila" are different intents,
              and folding the pause into the owner list would mean
              silencing the bot required choosing a new owner. Always
              rendered, not only when paused — "why is the bot quiet" and
              "why did the bot just answer" are the same question, and a
              control that appears in one state answers neither. */}
          <button
            type="button"
            onClick={handleAiAutoReplyToggle}
            aria-pressed={!aiPaused}
            title={
              aiPaused
                ? "AI replies are paused on this conversation — click to resume"
                : assignedAgentId
                  ? "A teammate owns this conversation, so the AI is standing down. Clear the owner to let it reply."
                  : "AI replies are on for this conversation — click to pause"
            }
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-muted",
              // Dimmed while a human owns the thread: the bot is not
              // going to answer, whatever this flag says on its own.
              aiPaused || assignedAgentId
                ? "text-muted-foreground"
                : "text-primary",
            )}
          >
            {aiPaused ? (
              <BotOff className="h-3.5 w-3.5" />
            ) : (
              <Bot className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
              {aiPaused ? "AI paused" : assignedAgentId ? "AI standing by" : "AI on"}
            </span>
          </button>

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  currentStatus?.color ?? "text-muted-foreground"
                )}>
                {currentStatus?.label ?? "Status"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Owner — one control for "who has this thread": an AI agent or
              a teammate. See the `owner` derivation above for why these
              cannot be two separate indicators. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={`Owner: ${owner.label}`}
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                owner.kind === 'none' || owner.kind === 'paused'
                  ? "text-muted-foreground"
                  : "text-primary"
              )}
            >
              {owner.kind === 'ai' ? (
                <Bot className="h-3 w-3" />
              ) : (
                <UserPlus className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">{owner.label}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {aiAgents.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
                    AI agents
                  </div>
                  {aiAgents.map((agent) => {
                    const isSelected =
                      owner.kind === 'ai' && agent.id === conversation.ai_agent_id;
                    return (
                      <DropdownMenuItem
                        key={agent.id}
                        onClick={() => handleAssignAiAgent(agent.id)}
                        className={cn(
                          "text-sm",
                          isSelected ? "text-primary" : "text-popover-foreground"
                        )}
                      >
                        <Bot className="mr-2 h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">{agent.name}</span>
                        {isSelected && <Check className="ml-2 h-3 w-3" />}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator className="bg-border" />
                  <div className="px-2 py-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
                    Teammates
                  </div>
                </>
              )}
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  No teammates available
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        "text-sm",
                        isSelected ? "text-primary" : "text-popover-foreground"
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? " (me)" : ""}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-muted-foreground"
                  >
                    {/* Clears the HUMAN only. `ai_agent_id` stays, so an
                        agent that had the thread earlier picks it back up
                        rather than the customer meeting a new persona. */}
                    Unassign
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Collision warning. Sits directly above the history and below
          the header — in the path between deciding to reply and
          replying, which is the only place it can change what the
          agent does. A toast would be gone by the time they finish
          reading the thread, and the composer is too late.

          `role="status"` (polite) rather than an alert: it is a nudge
          to coordinate, not an error, and it can change every few
          seconds as people move around the queue. */}
      {collisionWarning && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-warning/20 bg-warning-surface px-4 py-1.5"
        >
          <Users className="h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="text-xs text-warning">{collisionWarning}</p>
        </div>
      )}

      {/* Messages Area.
          `role="log"` + `aria-live="polite"` is what makes an inbound
          message audible: without it a screen-reader user sits in a
          silent thread and only discovers the reply by manually
          re-reading. Polite rather than assertive so a burst of
          messages queues behind whatever the agent is typing instead
          of interrupting it.

          `tabIndex={0}` because this is a scrollable region with no
          focusable child of its own once the history is long — a
          keyboard-only agent otherwise cannot scroll back through it
          at all (WCAG 2.1.1). It gets a visible ring like any other
          focus target. */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Message history"
        tabIndex={0}
        className="flex-1 overflow-y-auto px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">No messages yet</p>
            <p className="text-xs text-muted-foreground">
              Send a template to start the conversation
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Load older messages button — shown at the top of the thread
                when the initial fetch was capped at MESSAGE_PAGE_SIZE. */}
            {hasMoreMessages && (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={handleLoadOlderMessages}
                  disabled={loadingOlderMessages}
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
                >
                  {loadingOlderMessages ? (
                    <>
                      <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                      Loading…
                    </>
                  ) : (
                    "↑ Load older messages"
                  )}
                </button>
              </div>
            )}
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel: authorLabelFor(parent),
                          preview: buildReplyPreview(parent),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={msg.id}
                        message={msg}
                        quickEmojis={quickEmojis}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer.

          `key` is load-bearing, not decoration. Everything the composer
          holds — typed text, an AI draft, a staged attachment, a live
          recording — belongs to ONE conversation, but the element itself
          persists across a switch, so without this React keeps that state
          and it surfaces under the next contact's name. Keying on the id
          remounts it, which resets all of it at once and runs the unmount
          cleanup (mic released, unsent attachment GC'd from the bucket).

          Deliberately structural rather than an effect that nulls each
          piece of state: the next thing added to the composer is covered
          for free, where a reset list is one someone has to remember to
          extend. Same principle as the `replyTo` reset above — that one
          stays here because it is this component's state, not the
          composer's. */}
      <MessageComposer
        key={conversation.id}
        conversationId={conversation.id}
        channel={channel}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onSendProduct={handleSendProduct}
        onSendProductList={handleSendProductList}
        onTypingChange={onComposingChange}
      />

      {/* Templates are a WhatsApp mechanism. Instagram has none, and web
          needs none — we render the bubble, so there is nothing to
          pre-approve. See CHANNEL_CAPABILITIES. */}
      {channel === "whatsapp" && (
        <TemplatePicker
          open={templateModalOpen}
          onOpenChange={setTemplateModalOpen}
          onSelect={handleSendTemplate}
        />
      )}
    </div>
  );
}
