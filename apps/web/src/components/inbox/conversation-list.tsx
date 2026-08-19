"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  ConversationChannel,
  ConversationStatus,
  Tag,
} from "@/types";
import { ConversationActionsMenu } from "./conversation-actions-menu";
import { conversationChannel } from "@/lib/inbox/channel";
import { contactDisplayName, contactInitial } from "@/lib/contacts/display";
import {
  InstagramIcon,
  WhatsAppIcon,
} from "@/components/channels/channel-icons";
// Deliberately looser than lucide's own icon type: the brand glyphs are
// hand-rolled SVGs with a narrower signature, so a record holding both
// needs the contract the nav registry already settled on.
import type { NavIcon } from "@/lib/nav/channels";
import { Search, ChevronDown, X, Loader2, Globe, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { tint } from "@/lib/tint";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The row-menu callbacks, bundled so adding an action is one field
 * rather than another prop threaded through two components.
 *
 * Every one of these mutates state the PAGE owns (the list, the open
 * thread), which is why the menu reports outward instead of holding its
 * own copy — two sources of truth for "is this unread" is how a badge
 * ends up disagreeing with the row it sits on.
 */
export interface ConversationRowActions {
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onUnreadChange: (conversationId: string, unreadCount: number) => void;
  onDeleted: (conversationId: string) => void;
  onDeselect: () => void;
}

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /** Row-level actions. See ConversationRowActions. */
  actions: ConversationRowActions;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Conversations a teammate currently has open (self excluded). Marks
   * the row *before* the click, which is the whole point — knowing the
   * thread is busy after you have already opened it and started typing
   * is knowing it too late.
   */
  occupiedConversationIds?: Set<string>;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-warning",
  closed: "bg-muted-foreground",
};

type InboxFilter = ConversationStatus | "all" | "unread";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Open", value: "open" },
  { label: "Pending", value: "pending" },
  { label: "Closed", value: "closed" },
];

/**
 * Channel filter, kept separate from the status filter so the two
 * compose ("unread Instagram") instead of one clobbering the other.
 *
 * Defaults to "all": the point of a unified inbox is that an agent
 * works one queue, so hiding a channel is an opt-in.
 */
type ChannelFilter = "all" | ConversationChannel;

const CHANNEL_OPTIONS: { label: string; value: ChannelFilter }[] = [
  { label: "All channels", value: "all" },
  { label: "WhatsApp", value: "whatsapp" },
  { label: "Instagram", value: "instagram" },
  { label: "Web", value: "web" },
];

// Conversations fetched per page. 30 gives ~2 screens of content at
// typical item height (~64 px) without pulling the whole table.
const PAGE_SIZE = 30;

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  actions,
  resyncToken = 0,
  occupiedConversationIds,
}: ConversationListProps) {
  const { accountId } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Pagination state.
  // `cursor` is the `last_message_at` of the last loaded conversation —
  // used as the "before" cursor for the next page fetch.
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Sentinel div at the bottom of the list; observed by IntersectionObserver
  // to trigger next-page fetches automatically when the user scrolls down.
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Keep the latest callback in a ref so the fetch effect can have a
  // stable identity. Without this, every parent re-render causes a
  // fresh conversations fetch (issue documented in original component).
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  // ── Initial / resync fetch ────────────────────────────────────────
  // Fetches the first page. On resync (tab focus / realtime reconnect)
  // we re-fetch page 1 and reset the cursor, discarding stale local
  // state — simpler and more correct than trying to merge two lists.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    setLoading(true);
    setCursor(null);
    setHasMore(true);

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        // ⚠️ The ACTIVE workspace, not every workspace RLS permits — see
        // lib/workspace/scope.ts. Unscoped, an agency's inbox would interleave
        // every client's threads into one list.
        .eq("account_id", accountId)
        .order("last_message_at", { ascending: false })
        .limit(PAGE_SIZE);

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      const normalized = normalizeConversations(data ?? []);
      onConversationsLoadedRef.current(normalized);

      // If fewer rows than PAGE_SIZE came back, we've reached the end.
      setHasMore((data?.length ?? 0) >= PAGE_SIZE);

      // The cursor is the last_message_at of the oldest item in this batch.
      const lastAt = normalized[normalized.length - 1]?.last_message_at;
      setCursor(lastAt ?? null);

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken, accountId]);

  // ── Load-more handler ─────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursor || !accountId) return;

    const supabase = createClient();
    setLoadingMore(true);

    const { data, error } = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("account_id", accountId)
      .order("last_message_at", { ascending: false })
      // Exclusive cursor: only rows strictly older than the current cursor.
      .lt("last_message_at", cursor)
      .limit(PAGE_SIZE);

    if (error) {
      console.error("Failed to load more conversations:", error.message);
      setLoadingMore(false);
      return;
    }

    const normalized = normalizeConversations(data ?? []);

    // Merge with existing: parent state owns the full list. Append-only
    // so realtime inserts at the top aren't displaced.
    onConversationsLoadedRef.current([...conversations, ...normalized]);

    setHasMore((data?.length ?? 0) >= PAGE_SIZE);
    const lastAt = normalized[normalized.length - 1]?.last_message_at;
    if (lastAt) setCursor(lastAt);

    setLoadingMore(false);
  }, [loadingMore, hasMore, cursor, conversations, accountId]);

  // ── IntersectionObserver — auto load-more on scroll ───────────────
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // ── Tag list ──────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      if (!accountId) return;
      const { data } = await supabase
        .from("tags")
        .select("*")
        .eq("account_id", accountId)
        .order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // ── Derived state ─────────────────────────────────────────────────

  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (channelFilter !== "all") {
      // Rows written before the column existed, and realtime payloads
      // that omit it, are WhatsApp — matching the DB default.
      result = result.filter(
        (c) => (c.channel ?? "whatsapp") === channelFilter,
      );
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        // Without this an Instagram contact is unsearchable: they have
        // no phone, and their name is often just the handle.
        const handle = c.contact?.ig_username?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return (
          name.includes(q) ||
          phone.includes(q) ||
          handle.includes(q) ||
          lastMsg.includes(q)
        );
      });
    }

    return result;
  }, [conversations, filter, channelFilter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);
  const activeChannel = CHANNEL_OPTIONS.find((o) => o.value === channelFilter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? "All"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
              {activeChannel?.label ?? "All channels"}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {CHANNEL_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setChannelFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    channelFilter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground",
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="tint-mark h-2 w-2 shrink-0 rounded-full"
                        style={tint(t.color)}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Company"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All companies
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="tint-mark h-1.5 w-1.5 shrink-0 rounded-full"
                    style={tint(tag?.color)}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Tag"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this div grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229).
          Replaced ScrollArea with a native overflow-y-auto div so
          the IntersectionObserver can read the scroll position. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No conversations found</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                actions={actions}
                occupied={occupiedConversationIds?.has(conv.id) ?? false}
              />
            ))}

            {/* Pagination sentinel — observed by IntersectionObserver.
                Shown below the last item; when it enters the viewport
                the observer fires and loadMore() fetches the next page. */}
            <div ref={sentinelRef} className="h-4 shrink-0" aria-hidden />

            {loadingMore && (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {!hasMore && conversations.length > PAGE_SIZE && (
              <p className="py-3 text-center text-[11px] text-muted-foreground">
                All conversations loaded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  actions: ConversationRowActions;
  /** A teammate has this thread open right now. */
  occupied?: boolean;
}

/**
 * Small channel glyph on the avatar's corner.
 *
 * Rendered for every channel including WhatsApp — an inbox where only
 * *some* rows carry a badge reads as "these are special" rather than
 * "here is which platform each one is on".
 */
/**
 * Per-channel glyph and label, as a lookup rather than a ternary chain.
 *
 * With three channels a `=== "instagram" ? … : …` shape silently labels
 * every web thread "WhatsApp" — the same failure `conversationChannel`
 * was widened to avoid. A record makes the fourth channel a data change.
 */
const CHANNEL_GLYPH: Record<
  ConversationChannel,
  { icon: NavIcon; label: string; className?: string }
> = {
  whatsapp: { icon: WhatsAppIcon, label: "WhatsApp" },
  instagram: { icon: InstagramIcon, label: "Instagram" },
  web: { icon: Globe, label: "Web chat", className: "text-[#2D7FF9]" },
};

function ChannelBadge({ channel }: { channel: ConversationChannel }) {
  const { icon: Icon, label, className } = CHANNEL_GLYPH[channel];
  return (
    <span
      title={label}
      className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-card ring-2 ring-card"
    >
      <Icon className={cn("h-3.5 w-3.5", className)} aria-hidden="true" />
      {/* Which platform the reply goes out on is decision-relevant
          before the click, and an icon with a `title` does not carry
          it to a screen reader. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  actions,
  occupied = false,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contactDisplayName(contact);
  const initials = contactInitial(contact);
  const channel = conversationChannel(conversation);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  // The row is a <div> wrapper holding two siblings — the selection
  // button and the actions menu — rather than one button containing the
  // other. A <button> inside a <button> is invalid HTML that browsers
  // recover from unpredictably, and the menu trigger has to be a real
  // button to stay keyboard-reachable.
  return (
    <div
      className={cn(
        "group/conv relative transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      <button
        onClick={handleClick}
        // `aria-current` is the only thing that tells a screen-reader
        // user which thread is open — the selected row is otherwise
        // distinguished purely by a left border and a background wash.
        aria-current={isActive ? "true" : undefined}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
      {/* Avatar, with a channel glyph pinned to its corner. A badge on
          the avatar rather than a row of its own: an agent scanning the
          list needs to know which platform they are about to reply on
          before they click, and vertical space here is scarce. */}
      <div className="relative shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>
        <ChannelBadge channel={channel} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          {/* Yields to the actions menu on hover rather than sitting
              under it — an overlaid button on top of live text reads as
              a rendering glitch, and the timestamp is the one thing on
              the row nobody needs while reaching for an action. */}
          <span className="shrink-0 text-[10px] text-muted-foreground transition-opacity group-hover/conv:opacity-0">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Someone else is in here. Deliberately quiet — a glyph,
                not a coloured pill: it must be findable when scanning
                for it and ignorable when not, because on a busy team
                a noisy version would be on half the rows all day. */}
            {occupied && (
              <span title="A teammate has this conversation open">
                <Users
                  className="h-3 w-3 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">
                  A teammate has this conversation open
                </span>
              </span>
            )}
            {conversation.unread_count > 0 && (
              // The bare number reads as "3" on its own. Announce the
              // unit and suppress the digit, so the row says
              // "3 unread messages" rather than leaving the listener
              // to guess what the 3 counts.
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                <span aria-hidden="true">{conversation.unread_count}</span>
                <span className="sr-only">
                  {conversation.unread_count} unread{" "}
                  {conversation.unread_count === 1 ? "message" : "messages"}
                </span>
              </span>
            )}
            {/* Status is otherwise hue-only (WCAG 1.4.1) and `title` on
                a span is not reliably announced — carry the word. */}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            >
              <span className="sr-only">Status: {conversation.status}</span>
            </span>
          </div>
        </div>
      </div>
      </button>

      {/* Sits over the timestamp, which is the least informative thing
          on the row and is the corner every list-with-a-menu uses. */}
      <div className="absolute right-2 top-2">
        <ConversationActionsMenu
          conversation={conversation}
          isActive={isActive}
          onStatusChange={actions.onStatusChange}
          onUnreadChange={actions.onUnreadChange}
          onDeleted={actions.onDeleted}
          onDeselect={actions.onDeselect}
        />
      </div>
    </div>
  );
}
