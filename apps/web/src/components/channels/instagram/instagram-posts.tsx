'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  Grid3x3,
  Heart,
  Images,
  LayoutGrid,
  Loader2,
  MessageCircle,
  MessageCircleOff,
  Play,
  RefreshCw,
  Rows3,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatAbsolute,
  formatCount,
  formatRelative,
  mediaKind,
} from '@/lib/instagram/format';
import type { IgMedia, IgMediaListResponse } from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { InstagramPostSheet } from './instagram-post-sheet';

const PAGE_SIZE = 24;
/** The server's own cap on `?limit=`. */
const MAX_PAGE = 100;
const SEARCH_DEBOUNCE_MS = 300;

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'FEED', label: 'Feed posts' },
  { value: 'REELS', label: 'Reels' },
  { value: 'STORY', label: 'Stories' },
  { value: 'AD', label: 'Ads' },
] as const;

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'likes', label: 'Most liked' },
  { value: 'comments', label: 'Most commented' },
] as const;

type ViewMode = 'grid' | 'list';

/**
 * Base UI's `SelectValue` shows the raw value when the root has no
 * `items` map, so every trigger has to resolve its own label.
 */
function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * The account's published posts, as a launchpad for comment moderation.
 *
 * Read-only with respect to *publishing*: creating posts is out of
 * scope for this phase (the API surface exists — media containers +
 * media_publish — but a half-built composer that can post to a real
 * audience is worse than none). Everything else about a post that can
 * be acted on from here, is: opening its comment thread, backfilling
 * comments, and turning commenting off when a post goes sideways.
 *
 * What this page is *for* is answering "which post is generating
 * comments I haven't handled".
 */
export function InstagramPosts() {
  const router = useRouter();
  const [media, setMedia] = useState<IgMedia[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<IgMediaListResponse['stats'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingComments, setSyncingComments] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<string>('all');
  const [sort, setSort] = useState<string>('newest');
  const [view, setView] = useState<ViewMode>('grid');

  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [searchInput]);

  const buildQuery = useCallback(
    (offset: number, limit = PAGE_SIZE) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (search) params.set('q', search);
      if (type !== 'all') params.set('type', type);
      if (sort !== 'newest') params.set('sort', sort);
      if (offset) params.set('offset', String(offset));
      return params.toString();
    },
    [search, type, sort]
  );

  // Tracked outside state so a silent refresh can re-request the window
  // that is already on screen, instead of collapsing it back to page one
  // (which is what a refresh after moderating from the sheet would do).
  const loadedCountRef = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const limit = silent
        ? Math.min(Math.max(loadedCountRef.current, PAGE_SIZE), MAX_PAGE)
        : PAGE_SIZE;
      try {
        const res = await fetch(
          `/api/instagram/media?${buildQuery(0, limit)}`,
          {
            cache: 'no-store',
          }
        );
        const data: IgMediaListResponse = await res.json();
        setMedia(data.media ?? []);
        loadedCountRef.current = data.media?.length ?? 0;
        setTotal(data.total ?? 0);
        setStats(data.stats ?? null);
      } catch {
        if (!silent) toast.error('Could not load posts.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [buildQuery]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/instagram/media?${buildQuery(media.length)}`,
        {
          cache: 'no-store',
        }
      );
      const data: IgMediaListResponse = await res.json();
      setMedia((current) => {
        const seen = new Set(current.map((m) => m.id));
        const next = [
          ...current,
          ...(data.media ?? []).filter((m) => !seen.has(m.id)),
        ];
        loadedCountRef.current = next.length;
        return next;
      });
      setTotal(data.total ?? 0);
    } catch {
      toast.error('Could not load more posts.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/instagram/media/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast.success(`Synced ${data.synced} post(s).`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  /** Pull in comments made before each post was first synced. */
  async function syncAllComments() {
    setSyncingComments(true);
    try {
      const res = await fetch('/api/instagram/media/comments/sync-all', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast.success(
        `Pulled ${data.synced} comment(s) across ${data.posts} post(s).` +
          (data.failed ? ` ${data.failed} failed.` : '')
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncingComments(false);
    }
  }

  const active = media.find((m) => m.id === activeId) ?? null;
  const filtered = search !== '' || type !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-lg font-semibold">Posts</h1>
          <p className="text-muted-foreground text-sm">
            Your published posts, and how many comments are waiting on each.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={syncAllComments}
            disabled={syncingComments || media.length === 0}
            title="Pull in comments made before each post was synced"
          >
            {syncingComments ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageCircle className="size-4" />
            )}
            Sync comments
          </Button>
          <Button variant="outline" size="sm" onClick={sync} disabled={syncing}>
            {syncing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Sync posts
          </Button>
        </div>
      </div>

      {stats && stats.posts > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Posts"
            value={formatCount(stats.posts)}
            icon={Grid3x3}
          />
          <StatTile
            label="Waiting"
            value={formatCount(stats.open_comments)}
            icon={MessageCircle}
            emphasis={stats.open_comments > 0}
            onClick={() => router.push('/channels/instagram/comments')}
          />
          <StatTile
            label="Likes"
            value={formatCount(stats.likes)}
            icon={Heart}
          />
          <StatTile
            label="Comments"
            value={formatCount(stats.comments)}
            icon={MessageCircle}
          />
        </div>
      )}

      {stats && stats.posts > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search captions…"
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

          <Select
            value={type}
            onValueChange={(value) => setType(value || 'all')}
          >
            <SelectTrigger className="w-[140px]">
              {/* The trigger renders the raw value unless it is told how
                  to find the label — "REELS" instead of "Reels". */}
              <SelectValue>{() => optionLabel(TYPE_OPTIONS, type)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={sort}
            onValueChange={(value) => setSort(value || 'newest')}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue>{() => optionLabel(SORT_OPTIONS, sort)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="border-border flex rounded-md border p-0.5">
            <Button
              size="icon-sm"
              variant={view === 'grid' ? 'secondary' : 'ghost'}
              aria-label="Grid view"
              onClick={() => setView('grid')}
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant={view === 'list' ? 'secondary' : 'ghost'}
              aria-label="List view"
              onClick={() => setView('list')}
            >
              <Rows3 className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading posts…
        </div>
      ) : media.length === 0 ? (
        <EmptyState filtered={filtered} syncing={syncing} onSync={sync} />
      ) : (
        <>
          <ul
            className={cn(
              view === 'grid'
                ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                : 'space-y-2'
            )}
          >
            {media.map((item) =>
              view === 'grid' ? (
                <PostCard
                  key={item.id}
                  media={item}
                  onOpen={() => setActiveId(item.id)}
                />
              ) : (
                <PostRow
                  key={item.id}
                  media={item}
                  onOpen={() => setActiveId(item.id)}
                />
              )
            )}
          </ul>

          {media.length < total && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="size-4 animate-spin" />}
                Load more ({total - media.length} left)
              </Button>
            </div>
          )}
        </>
      )}

      <InstagramPostSheet
        media={active}
        open={activeId !== null}
        onOpenChange={(next) => !next && setActiveId(null)}
        onChanged={() => void load(true)}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  emphasis,
  onClick,
}: {
  label: string;
  value: string;
  icon: typeof Heart;
  emphasis?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p
        className={cn(
          'mt-1 text-xl font-semibold',
          emphasis ? 'text-primary' : 'text-foreground'
        )}
      >
        {value}
      </p>
    </>
  );

  const className = cn(
    'rounded-xl border border-border bg-card p-3 text-left',
    onClick && 'transition-colors hover:border-primary/40'
  );

  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function EmptyState({
  filtered,
  syncing,
  onSync,
}: {
  filtered: boolean;
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <div className="border-border rounded-xl border border-dashed p-10 text-center">
      <Grid3x3 className="text-muted-foreground mx-auto size-8" />
      <p className="text-foreground mt-3 text-sm font-medium">
        {filtered ? 'No posts match those filters' : 'No posts synced yet'}
      </p>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
        {filtered
          ? 'Try a different type, or clear the search.'
          : 'Posts are not pulled in automatically — Instagram only pushes events for new activity. Sync to fetch your existing ones.'}
      </p>
      {!filtered && (
        <Button className="mt-4" size="sm" onClick={onSync} disabled={syncing}>
          {syncing && <Loader2 className="size-4 animate-spin" />}
          Sync posts
        </Button>
      )}
    </div>
  );
}

/** Shared by both layouts: the type / carousel / muted-comments flags. */
function PostFlags({ media }: { media: IgMedia }) {
  const kind = mediaKind(media);
  return (
    <>
      <Badge variant="secondary">{kind.label}</Badge>
      {media.is_comment_enabled === false && (
        <Badge variant="outline" className="text-muted-foreground gap-1">
          <MessageCircleOff />
          off
        </Badge>
      )}
    </>
  );
}

function PostCard({ media, onOpen }: { media: IgMedia; onOpen: () => void }) {
  const router = useRouter();
  const kind = mediaKind(media);

  return (
    <li className="group border-border bg-card hover:border-primary/40 overflow-hidden rounded-xl border transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="bg-muted relative block aspect-square w-full"
        aria-label="Open post"
      >
        {media.thumbnail_url ? (
          // Plain <img>: the Instagram CDN host is not in the
          // next/image allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.thumbnail_url}
            alt={media.caption ?? 'Instagram post'}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Grid3x3 className="text-muted-foreground size-8" />
          </div>
        )}

        <span className="absolute top-2 left-2 flex flex-wrap gap-1">
          {kind.isCarousel && (
            <span className="rounded-full bg-black/60 p-1 text-white">
              <Images className="size-3.5" />
            </span>
          )}
          {kind.isVideo && (
            <span className="rounded-full bg-black/60 p-1 text-white">
              <Play className="size-3.5 fill-current" />
            </span>
          )}
          {media.is_comment_enabled === false && (
            <span
              className="rounded-full bg-black/60 p-1 text-white"
              title="Commenting is turned off on this post"
            >
              <MessageCircleOff className="size-3.5" />
            </span>
          )}
        </span>

        {media.open_comments > 0 && (
          <span className="bg-primary text-primary-foreground absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
            <MessageCircle className="size-3" />
            {media.open_comments}
          </span>
        )}

        {/* Engagement on hover rather than always-on: the grid is for
            spotting the post you want, and four numbers per tile turns
            it into a spreadsheet. */}
        <span className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-linear-to-t from-black/70 to-transparent px-3 py-2 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
          <span className="inline-flex items-center gap-1">
            <Heart className="size-3.5" />
            {formatCount(media.like_count)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="size-3.5" />
            {formatCount(media.comments_count)}
          </span>
        </span>
      </button>

      <div className="space-y-2 p-3">
        {media.caption ? (
          <p className="text-muted-foreground line-clamp-2 text-xs">
            {media.caption}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs italic">No caption</p>
        )}

        <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          <span title={formatAbsolute(media.posted_at)}>
            {formatRelative(media.posted_at)}
          </span>
          {media.permalink && (
            <a
              href={media.permalink}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hover:text-foreground inline-flex items-center gap-1"
            >
              View <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={onOpen}
          >
            <MessageCircle className="size-3.5" />
            {media.open_comments > 0
              ? `${media.open_comments} waiting`
              : 'Comments'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Open this post in the full comments queue"
            aria-label="Open in the comments queue"
            onClick={() =>
              router.push(
                `/channels/instagram/comments?media_id=${media.ig_media_id}`
              )
            }
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function PostRow({ media, onOpen }: { media: IgMedia; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="border-border bg-card hover:border-primary/40 flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors"
      >
        <div className="bg-muted relative size-14 shrink-0 overflow-hidden rounded-md">
          {media.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media.thumbnail_url}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center">
              <Grid3x3 className="text-muted-foreground size-5" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <PostFlags media={media} />
            <span
              className="text-muted-foreground text-xs"
              title={formatAbsolute(media.posted_at)}
            >
              {formatRelative(media.posted_at)}
            </span>
          </div>
          <p className="text-foreground mt-0.5 truncate text-sm">
            {media.caption || <span className="italic">No caption</span>}
          </p>
        </div>

        <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1">
            <Heart className="size-3.5" />
            {formatCount(media.like_count)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="size-3.5" />
            {formatCount(media.comments_count)}
          </span>
          {media.open_comments > 0 && <Badge>{media.open_comments}</Badge>}
        </div>
      </button>
    </li>
  );
}
