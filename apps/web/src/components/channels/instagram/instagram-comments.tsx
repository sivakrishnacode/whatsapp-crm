'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowDownUp,
  Check,
  EyeOff,
  Eye,
  Keyboard,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { postLabel } from '@/lib/instagram/format';
import type {
  IgComment,
  IgCommentListResponse,
  IgCommentStatus,
  IgMedia,
  IgMediaListResponse,
} from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { InstagramPostPicker } from './instagram-post-picker';
import { InstagramCommentCard } from './instagram-comment-card';
import type { CommentCardHandle } from './instagram-comment-card';

const PAGE_SIZE = 25;

/** The server's own cap on `?limit=`. */
const MAX_PAGE = 100;

/** How long typing settles before a search request goes out. */
const SEARCH_DEBOUNCE_MS = 300;

/** Poll interval when live updates are on. */
const REFRESH_MS = 20_000;

const STATUS_TABS = [
  { id: 'open', label: 'Needs reply', countKey: 'open' },
  { id: 'replied', label: 'Replied', countKey: 'replied' },
  { id: 'hidden', label: 'Hidden', countKey: 'hidden' },
  { id: '', label: 'All', countKey: 'all' },
] as const;

/**
 * `resolve` is the odd one out — local bookkeeping that clears a
 * handled comment out of "Needs reply" without touching Instagram.
 */
type BulkAction = 'hide' | 'unhide' | 'delete' | 'resolve';

const SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'j / ↓', description: 'Next comment' },
  { keys: 'k / ↑', description: 'Previous comment' },
  { keys: 'r', description: 'Reply publicly' },
  { keys: 'd', description: 'Send a DM' },
  { keys: 'h', description: 'Hide or unhide' },
  { keys: 'x', description: 'Select for a bulk action' },
  { keys: '⌘↵', description: 'Send (while writing)' },
  { keys: 'Esc', description: 'Close the composer, then the cursor' },
  { keys: '?', description: 'This list' },
];

export function InstagramComments() {
  const [comments, setComments] = useState<IgComment[]>([]);
  const [counts, setCounts] = useState<
    Partial<Record<IgCommentStatus | 'all', number>>
  >({});
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>('open');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [posts, setPosts] = useState<IgMedia[]>([]);

  // Set when arriving from a post card on the Posts page. Narrows the
  // queue to that post so "12 comments waiting" leads somewhere exact
  // rather than dumping the agent into the full list. Held in state as
  // well so the in-page picker can change it without a navigation.
  const mediaIdParam = useSearchParams().get('media_id');
  const [mediaId, setMediaId] = useState<string | null>(mediaIdParam);
  useEffect(() => setMediaId(mediaIdParam), [mediaIdParam]);

  // Cards register themselves so a keystroke can drive the focused one.
  const handlesRef = useRef(new Map<string, CommentCardHandle>());

  useEffect(() => {
    const timer = setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [searchInput]);

  const buildQuery = useCallback(
    (offset: number, limit = PAGE_SIZE) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (mediaId) params.set('media_id', mediaId);
      if (search) params.set('q', search);
      if (sort !== 'newest') params.set('sort', sort);
      params.set('limit', String(limit));
      if (offset) params.set('offset', String(offset));
      return params.toString();
    },
    [status, mediaId, search, sort]
  );

  // How many rows are on screen, tracked outside state so a refresh can
  // re-request the same window without `load` depending on `comments`
  // (which would make the load effect re-run on its own result).
  const loadedCountRef = useRef(0);

  /**
   * `silent` skips the loading state so the background poll does not
   * blank the list out from under someone mid-reply — and re-requests
   * however many rows are already on screen, so a refresh does not
   * quietly undo "Load more".
   */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const limit = silent
        ? Math.min(Math.max(loadedCountRef.current, PAGE_SIZE), MAX_PAGE)
        : PAGE_SIZE;
      try {
        const res = await fetch(
          `/api/instagram/comments?${buildQuery(0, limit)}`,
          { cache: 'no-store' }
        );
        const data: IgCommentListResponse = await res.json();
        setComments(data.comments ?? []);
        loadedCountRef.current = data.comments?.length ?? 0;
        setCounts(data.counts ?? {});
        setTotal(data.total ?? 0);
        // Drop selections for rows that are no longer on screen —
        // acting on an invisible selection is how you delete the wrong
        // comment.
        setSelected((current) => {
          if (!current.size) return current;
          const visible = new Set((data.comments ?? []).map((c) => c.id));
          return new Set([...current].filter((id) => visible.has(id)));
        });
      } catch {
        if (!silent) toast.error('Could not load comments.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [buildQuery]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Posts for the in-page filter. One request, cached for the session:
  // the picker only needs enough to name a post and show its backlog,
  // and re-fetching on every filter change would be a request per
  // keystroke for a list that barely changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/instagram/media?limit=100', {
          cache: 'no-store',
        });
        const data: IgMediaListResponse = await res.json();
        if (!cancelled) setPosts(data.media ?? []);
      } catch {
        // Non-fatal: the picker degrades to "All posts" and the queue
        // still works. Not worth a toast on a page load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The cursor is an index, so it has to come back in range whenever the
  // list gets shorter — otherwise `r` fires on nothing after a filter
  // change or a delete.
  useEffect(() => {
    setFocusedIndex((current) =>
      current >= comments.length ? comments.length - 1 : current
    );
  }, [comments.length]);

  /**
   * Queue shortcuts.
   *
   * Bound to the window rather than a container, because the cursor has
   * to survive clicking a button — an agent who hides a comment with the
   * mouse and then presses `j` means "next", not "nothing happened".
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Never steal a key from something being typed into. The composer
      // owns ⌘↵ and Esc itself.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      // A card with an open composer keeps its keys, even if focus has
      // wandered off the textarea.
      const focused = comments[focusedIndex];
      const handle = focused
        ? handlesRef.current.get(focused.id)
        : undefined;
      if (handle?.isComposing()) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, comments.length - 1));
          return;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          // -1 parks the cursor above the list rather than wrapping,
          // which is how you get out without reaching for the mouse.
          setFocusedIndex((i) => Math.max(i - 1, comments.length ? 0 : -1));
          return;
        case 'Escape':
          setFocusedIndex(-1);
          return;
        case '?':
          event.preventDefault();
          setShowShortcuts((open) => !open);
          return;
      }

      if (!focused || !handle) return;

      switch (event.key) {
        case 'r':
          event.preventDefault();
          handle.openPublicReply();
          break;
        case 'd':
          event.preventDefault();
          handle.openPrivateReply();
          break;
        case 'h':
          event.preventDefault();
          handle.toggleHide();
          break;
        case 'x':
          event.preventDefault();
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(focused.id)) next.delete(focused.id);
            else next.add(focused.id);
            return next;
          });
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [comments, focusedIndex]);

  // `load` is re-created on every filter change, so keep the poll on a
  // ref instead of restarting the interval each time.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void loadRef.current(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/instagram/comments?${buildQuery(comments.length)}`,
        { cache: 'no-store' }
      );
      const data: IgCommentListResponse = await res.json();
      setComments((current) => {
        // Guard against a comment arriving on two pages after a webhook
        // reorders the underlying list mid-scroll.
        const seen = new Set(current.map((c) => c.id));
        const next = [
          ...current,
          ...(data.comments ?? []).filter((c) => !seen.has(c.id)),
        ];
        loadedCountRef.current = next.length;
        return next;
      });
      setTotal(data.total ?? 0);
    } catch {
      toast.error('Could not load more comments.');
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Webhooks only cover comments made after connecting, so a freshly
   * connected account sees an empty queue on posts full of comments.
   * This pulls the backlog in.
   */
  async function syncBacklog() {
    setSyncing(true);
    try {
      const mediaRes = await fetch('/api/instagram/media/sync', {
        method: 'POST',
      });
      const mediaData = await mediaRes.json();
      if (!mediaRes.ok) throw new Error(mediaData.error ?? 'Sync failed');

      const commentsRes = await fetch(
        '/api/instagram/media/comments/sync-all',
        {
          method: 'POST',
        }
      );
      const commentsData = await commentsRes.json();
      if (!commentsRes.ok) throw new Error(commentsData.error ?? 'Sync failed');

      toast.success(
        `Synced ${mediaData.synced} post(s) and ${commentsData.synced} comment(s).` +
          (commentsData.failed ? ` ${commentsData.failed} post(s) failed.` : '')
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function runBulk(action: BulkAction) {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      action === 'delete' &&
      !window.confirm(
        `Delete ${ids.length} comment(s) on Instagram? This cannot be undone.`
      )
    ) {
      return;
    }

    setBulkBusy(action);
    try {
      const res = await fetch('/api/instagram/comments/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Bulk action failed');

      if (data.failed) {
        toast.warning(
          `${data.succeeded} done, ${data.failed} failed.` +
            (data.errors?.length ? ` ${data.errors[0]}` : '')
        );
      } else {
        toast.success(`${data.succeeded} comment(s) updated.`);
      }
      setSelected(new Set());
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk action failed');
    } finally {
      setBulkBusy(null);
    }
  }

  const allSelected = comments.length > 0 && selected.size === comments.length;
  const someSelected = selected.size > 0 && !allSelected;

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (mediaId) {
      const post = posts.find((p) => p.ig_media_id === mediaId);
      parts.push(post ? postLabel(post) : 'one post');
    }
    if (search) parts.push(`“${search}”`);
    return parts.join(' · ');
  }, [mediaId, search, posts]);

  function clearFilters() {
    setSearchInput('');
    setMediaId(null);
    setFocusedIndex(-1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-lg font-semibold">Comments</h1>
          <p className="text-muted-foreground text-sm">
            Reply publicly, or send a private DM to move the conversation to the
            inbox.
          </p>
          {filterSummary && (
            <p className="text-muted-foreground mt-1 text-xs">
              Filtered to {filterSummary} ·{' '}
              <Link
                href="/channels/instagram/comments"
                className="text-primary hover:underline"
                onClick={clearFilters}
              >
                clear
              </Link>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={live ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setLive((current) => !current)}
            title={
              live
                ? `Checking for new comments every ${REFRESH_MS / 1000}s`
                : 'Automatically check for new comments'
            }
          >
            <span
              className={cn(
                'size-2 rounded-full',
                live ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40'
              )}
            />
            Live
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="size-4" />
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={syncBacklog}
            disabled={syncing}
            title="Pull in posts and any comments made before you connected"
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Sync backlog
          </Button>
        </div>
      </div>

      <div className="border-border flex gap-1 overflow-x-auto border-b">
        {STATUS_TABS.map((tab) => {
          const count = counts[tab.countKey];
          return (
            <button
              key={tab.id || 'all'}
              type="button"
              onClick={() => {
                setStatus(tab.id);
                setSelected(new Set());
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
                status === tab.id
                  ? 'border-foreground text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              )}
            >
              {tab.label}
              {count !== undefined && count > 0 && (
                <Badge
                  variant={
                    tab.id === 'open' && status !== tab.id
                      ? 'default'
                      : 'secondary'
                  }
                >
                  {count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search comments or @handles…"
            className="pl-8"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <InstagramPostPicker
          posts={posts}
          value={mediaId}
          onChange={(next) => {
            setMediaId(next);
            setSelected(new Set());
            setFocusedIndex(-1);
          }}
          className="w-[190px]"
        />

        <Select
          value={sort}
          onValueChange={(value) =>
            setSort(value === 'oldest' ? 'oldest' : 'newest')
          }
        >
          <SelectTrigger className="w-[150px]">
            <ArrowDownUp className="text-muted-foreground size-4" />
            {/* Base UI renders the raw value when the root has no
                `items` map, so resolve the label here. */}
            <SelectValue>
              {() => (sort === 'oldest' ? 'Oldest first' : 'Newest first')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {comments.length > 0 && (
        <div className="border-border bg-muted/30 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            onCheckedChange={(next) =>
              setSelected(
                next === true ? new Set(comments.map((c) => c.id)) : new Set()
              )
            }
            aria-label="Select all loaded comments"
          />

          <span className="text-muted-foreground text-xs">
            {selected.size > 0
              ? `${selected.size} selected`
              : `Showing ${comments.length} of ${total}`}
          </span>

          {selected.size > 0 && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy !== null}
                onClick={() => runBulk('resolve')}
                title="Clear these out of Needs reply. Local only — nothing is sent to Instagram."
              >
                {bulkBusy === 'resolve' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Mark replied
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy !== null}
                onClick={() => runBulk('hide')}
              >
                {bulkBusy === 'hide' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <EyeOff className="size-4" />
                )}
                Hide
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy !== null}
                onClick={() => runBulk('unhide')}
              >
                {bulkBusy === 'unhide' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Eye className="size-4" />
                )}
                Unhide
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={bulkBusy !== null}
                onClick={() => runBulk('delete')}
              >
                {bulkBusy === 'delete' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Delete
              </Button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading comments…
        </div>
      ) : comments.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed p-10 text-center">
          <MessageCircle className="text-muted-foreground mx-auto size-8" />
          <p className="text-foreground mt-3 text-sm font-medium">
            {search ? 'Nothing matches that search' : 'No comments here'}
          </p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
            {search
              ? 'Try a shorter phrase, or clear the search to see the whole queue.'
              : 'New comments appear automatically. Use “Sync backlog” to pull in ones from before you connected.'}
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {comments.map((comment, index) => (
              <InstagramCommentCard
                key={comment.id}
                comment={comment}
                onChange={() => void load(true)}
                focused={index === focusedIndex}
                registerHandle={(handle) => {
                  if (handle) handlesRef.current.set(comment.id, handle);
                  else handlesRef.current.delete(comment.id);
                }}
                selected={selected.has(comment.id)}
                onSelectedChange={(next) =>
                  setSelected((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(comment.id);
                    else updated.delete(comment.id);
                    return updated;
                  })
                }
              />
            ))}
          </ul>

          {comments.length < total && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="size-4 animate-spin" />}
                Load more ({total - comments.length} left)
              </Button>
            </div>
          )}

          <p className="text-muted-foreground text-center text-xs">
            Press <Kbd>j</Kbd> / <Kbd>k</Kbd> to move through the queue,{' '}
            <Kbd>?</Kbd> for the rest.
          </p>
        </>
      )}

      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Keyboard shortcuts
            </DialogTitle>
          </DialogHeader>
          <ul className="space-y-2">
            {SHORTCUTS.map((shortcut) => (
              <li
                key={shortcut.keys}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="text-muted-foreground">
                  {shortcut.description}
                </span>
                <Kbd>{shortcut.keys}</Kbd>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-mono text-xs">
      {children}
    </kbd>
  );
}

