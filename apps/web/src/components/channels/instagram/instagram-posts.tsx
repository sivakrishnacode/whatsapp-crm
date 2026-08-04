'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ExternalLink,
  Globe,
  Grid3x3,
  Heart,
  Images,
  LayoutGrid,
  Loader2,
  MessageCircle,
  MessageCircleOff,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  POST_TYPE_TABS,
  type PostAutomation,
  automationActionLabel,
  automationStateHint,
  automationStateLabel,
  blankAutomation,
  draftFromFunnel,
  globalFunnel,
  postAutomation,
  postFunnel,
  triggerSummary,
} from '@/lib/instagram/automation';
import {
  formatAbsolute,
  formatCount,
  formatRelative,
  mediaKind,
} from '@/lib/instagram/format';
import type {
  IgFunnel,
  IgFunnelDraft,
  IgFunnelEnabledResponse,
  IgFunnelListResponse,
  IgMedia,
  IgMediaListResponse,
} from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { InstagramPostAutomation } from './instagram-post-automation';
import { InstagramPostPanel } from './instagram-post-panel';

const PAGE_SIZE = 24;
/** The server's own cap on `?limit=`. */
const MAX_PAGE = 100;
const SEARCH_DEBOUNCE_MS = 300;

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
 * The account's published posts, as a launchpad for comment automation
 * and moderation.
 *
 * Read-only with respect to *publishing*: creating posts is out of
 * scope for this phase (the API surface exists — media containers +
 * media_publish — but a half-built composer that can post to a real
 * audience is worse than none). Everything else about a post that can
 * be acted on from here, is: automating its comments, opening its
 * comment thread, backfilling comments, and turning commenting off when
 * a post goes sideways.
 *
 * WHY AUTOMATION STATUS IS DERIVED HERE AND NOT SERVED
 *   An account has a handful of funnels and a screenful of posts, so
 *   the grid fetches all the funnels once and resolves coverage locally
 *   (`postAutomation`). The alternative — joining funnels into
 *   `GET /instagram/media` — pays a per-page query for data that does
 *   not change between pages, and would still need the client-side rule
 *   for "covered by the all-posts funnel, not its own".
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

  const [funnels, setFunnels] = useState<IgFunnel[]>([]);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [connected, setConnected] = useState(true);
  const [username, setUsername] = useState<string | null>(null);
  const [globalOpen, setGlobalOpen] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<string>('all');
  const [sort, setSort] = useState<string>('newest');
  const [view, setView] = useState<ViewMode>('grid');

  const [activeId, setActiveId] = useState<string | null>(null);
  /** The automation being edited, and the post it belongs to. */
  const [editing, setEditing] = useState<{
    draft: IgFunnelDraft;
    media: IgMedia | null;
  } | null>(null);

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

  /**
   * Automations, loaded once for the whole grid.
   *
   * Independent of the media request so a filter change does not re-read
   * funnels that cannot have changed — and so a funnels outage leaves the
   * grid working, just without badges.
   */
  const loadAutomations = useCallback(async () => {
    try {
      const [listRes, flagRes] = await Promise.all([
        fetch('/api/instagram/funnels', { cache: 'no-store' }),
        fetch('/api/instagram/funnels/enabled', { cache: 'no-store' }),
      ]);
      const list: IgFunnelListResponse = await listRes.json();
      const flag: IgFunnelEnabledResponse = await flagRes.json();
      setFunnels(list.funnels ?? []);
      setMasterEnabled(flag.enabled ?? false);
      setConnected(flag.connected ?? false);
      setUsername(flag.username ?? null);
    } catch {
      // Silent: the grid's job is posts. A missing badge is a smaller
      // failure than a toast on every page load.
      setFunnels([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

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

  /**
   * The account master switch.
   *
   * Optimistic, then reconciled — it is the one control a merchant may
   * reach for in a hurry, and a switch that waits for a round trip
   * before moving reads as broken at exactly the wrong moment.
   */
  async function toggleMaster(next: boolean) {
    setMasterEnabled(next);
    try {
      const res = await fetch('/api/instagram/funnels/enabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      toast.success(
        next ? 'Comment automations are live.' : 'Comment automations paused.'
      );
    } catch (err) {
      setMasterEnabled(!next);
      toast.error(
        err instanceof Error ? err.message : 'Could not change the setting.'
      );
    }
  }

  /** Flip one automation without opening the editor. */
  async function toggleAutomation(funnel: IgFunnel, next: boolean) {
    setFunnels((prev) =>
      prev.map((f) => (f.id === funnel.id ? { ...f, is_active: next } : f))
    );
    try {
      const res = await fetch(`/api/instagram/funnels/${funnel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
    } catch (err) {
      void loadAutomations();
      toast.error(
        err instanceof Error
          ? err.message
          : 'Could not change the automation.'
      );
    }
  }

  async function deleteAutomation(id: string) {
    if (!confirm('Delete this automation? Its history goes too.')) return;
    try {
      const res = await fetch(`/api/instagram/funnels/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      setFunnels((prev) => prev.filter((f) => f.id !== id));
      setEditing(null);
      toast.success('Automation deleted.');
    } catch {
      toast.error('Could not delete the automation.');
    }
  }

  /**
   * Open the editor for one post.
   *
   * A post covered only by the all-posts automation still gets a NEW
   * post-scoped draft rather than the global one: editing the global
   * funnel from inside one post's editor would silently rewrite every
   * other post's behaviour, which is not what "automate this post"
   * means to anybody.
   */
  function editPost(item: IgMedia) {
    const own = postFunnel(funnels, item);
    setEditing({
      draft: own ? draftFromFunnel(own) : blankAutomation(item),
      media: item,
    });
  }

  function editGlobal() {
    const existing = globalFunnel(funnels);
    setEditing({
      draft: existing ? draftFromFunnel(existing) : blankAutomation(),
      media: null,
    });
  }

  const active = media.find((m) => m.id === activeId) ?? null;
  const filtered = search !== '' || type !== 'all';
  const global = globalFunnel(funnels);
  const automatedCount = media.filter(
    (item) => postAutomation(funnels, item, masterEnabled).state === 'live'
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-lg font-semibold">Posts</h1>
          <p className="text-muted-foreground text-sm">
            Automate the comments on a post, and see what is waiting on each.
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

      <MasterSwitch
        enabled={masterEnabled}
        connected={connected}
        armedCount={funnels.filter((f) => f.is_active).length}
        onToggle={toggleMaster}
      />

      <GlobalAutomationCard
        open={globalOpen}
        onOpenChange={setGlobalOpen}
        funnel={global}
        masterEnabled={masterEnabled}
        onEdit={editGlobal}
        onToggle={toggleAutomation}
      />

      {stats && stats.posts > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Posts"
            value={formatCount(stats.posts)}
            icon={Grid3x3}
          />
          <StatTile
            label="Automated"
            value={`${automatedCount}/${media.length}`}
            icon={Zap}
            emphasis={automatedCount > 0}
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
        </div>
      )}

      {stats && stats.posts > 0 && (
        <>
          {/* Type as tabs rather than a dropdown: it is the filter people
              reach for constantly, and a closed Select hides both what is
              selected and what else there is. */}
          <div className="border-border/60 flex flex-wrap items-center gap-1 border-b pb-1">
            {POST_TYPE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                aria-pressed={type === tab.value}
                onClick={() => setType(tab.value)}
                className={cn(
                  '-mb-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  type === tab.value
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

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
              value={sort}
              onValueChange={(value) => setSort(value || 'newest')}
            >
              <SelectTrigger className="w-[160px]">
                {/* The trigger renders the raw value unless it is told how
                    to find the label. */}
                <SelectValue>
                  {() => optionLabel(SORT_OPTIONS, sort)}
                </SelectValue>
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
        </>
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
            {media.map((item) => {
              const automation = postAutomation(funnels, item, masterEnabled);
              return view === 'grid' ? (
                <PostCard
                  key={item.id}
                  media={item}
                  automation={automation}
                  onOpen={() => setActiveId(item.id)}
                  onAutomate={() => editPost(item)}
                />
              ) : (
                <PostRow
                  key={item.id}
                  media={item}
                  automation={automation}
                  onOpen={() => setActiveId(item.id)}
                  onAutomate={() => editPost(item)}
                />
              );
            })}
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

      <InstagramPostPanel
        media={active}
        open={activeId !== null}
        onOpenChange={(next) => !next && setActiveId(null)}
        automation={
          active ? postAutomation(funnels, active, masterEnabled) : null
        }
        onAutomate={() => {
          if (!active) return;
          setActiveId(null);
          editPost(active);
        }}
        // Returned, not voided: the panel awaits this so an optimistic
        // toggle can hold its position until the refreshed post is back.
        onChanged={() => load(true)}
      />

      <InstagramPostAutomation
        open={editing !== null}
        draft={editing?.draft ?? null}
        media={editing?.media ?? null}
        username={username}
        masterEnabled={masterEnabled}
        onOpenChange={(next) => !next && setEditing(null)}
        onSaved={loadAutomations}
        onDelete={deleteAutomation}
      />
    </div>
  );
}

// ============================================================
// Automation headers
// ============================================================

/**
 * The account master switch, above everything it governs.
 *
 * On the Posts page rather than buried in settings because this is where
 * a merchant is when they decide comment automation should stop — and a
 * kill switch nobody can find is not a kill switch.
 */
function MasterSwitch({
  enabled,
  connected,
  armedCount,
  onToggle,
}: {
  enabled: boolean;
  connected: boolean;
  armedCount: number;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4',
        enabled ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Sparkles
          className={cn(
            'mt-0.5 size-4 shrink-0',
            enabled ? 'text-primary' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0">
          <Label htmlFor="ig-automations-enabled" className="text-sm">
            Comment automations
          </Label>
          <p className="text-muted-foreground mt-1 text-xs">
            {!connected
              ? 'Connect Instagram before turning this on.'
              : enabled
                ? armedCount > 0
                  ? `Live. ${armedCount} automation${armedCount === 1 ? '' : 's'} can answer comments.`
                  : 'Live, but nothing is switched on yet — automate a post below.'
                : 'The master switch. Off means no automation runs, whatever its own setting says.'}
          </p>
        </div>
      </div>
      <Switch
        id="ig-automations-enabled"
        checked={enabled}
        disabled={!connected}
        onCheckedChange={(next) => onToggle(next === true)}
      />
    </div>
  );
}

/**
 * "Automate all posts in one go" — the account-wide automation.
 *
 * Collapsed by default. It is the highest-leverage and highest-blast-
 * radius control on the page, and an expanded card at the top of the
 * grid invites a merchant to arm it before they have read what it does.
 */
function GlobalAutomationCard({
  open,
  onOpenChange,
  funnel,
  masterEnabled,
  onEdit,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  funnel: IgFunnel | null;
  masterEnabled: boolean;
  onEdit: () => void;
  onToggle: (funnel: IgFunnel, next: boolean) => void;
}) {
  const live = funnel?.is_active === true && masterEnabled;

  return (
    <section className="border-border bg-card overflow-hidden rounded-xl border">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="hover:bg-muted/40 flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors"
      >
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open ? 'rotate-0' : '-rotate-90'
          )}
        />
        <Globe className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-medium">
            All posts — automate every post in one go
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            {funnel
              ? `${triggerSummary(funnel.keywords)} · ${funnel.delivered_count} delivered`
              : 'One automation that covers posts you haven’t published yet'}
          </span>
        </span>
        {funnel ? (
          <Badge variant={live ? 'default' : 'outline'} className="shrink-0">
            {live ? 'Live' : 'Off'}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0">
            Not set up
          </Badge>
        )}
      </button>

      {open && (
        <div className="border-border/60 space-y-3 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">
            Runs on every post, present and future. A post with its own
            automation uses that one instead, so a catch-all is safe to leave
            on — it is the fallback, not an override.
          </p>

          {funnel ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="ig-global-automation"
                  checked={funnel.is_active}
                  onCheckedChange={(next) => onToggle(funnel, next === true)}
                />
                <Label htmlFor="ig-global-automation" className="text-xs">
                  Run it
                </Label>
              </div>
              <Button size="sm" variant="outline" onClick={onEdit}>
                Edit
              </Button>
              <span className="text-muted-foreground text-xs">
                {funnel.matched_count} started · {funnel.delivered_count}{' '}
                delivered
              </span>
            </div>
          ) : (
            <Button size="sm" onClick={onEdit}>
              <Plus className="size-4" />
              Set up the all-posts automation
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** The automation badge, shared by both layouts and the detail panel. */
export function AutomationBadge({
  automation,
  className,
}: {
  automation: PostAutomation;
  className?: string;
}) {
  const label = automationStateLabel(automation.state);
  const hint = automationStateHint(automation);

  return (
    <Badge
      variant={
        // Live via its own automation is the strongest signal; live only
        // because the catch-all covers it is deliberately quieter, so a
        // grid of "Automated" badges still shows which posts were tuned.
        automation.state === 'live' && !automation.viaGlobal
          ? 'default'
          : automation.state === 'none'
            ? 'outline'
            : 'secondary'
      }
      className={cn('gap-1', className)}
      title={hint}
    >
      {automation.state === 'live' ? (
        <Zap className="fill-current" />
      ) : (
        <Zap />
      )}
      {label}
    </Badge>
  );
}

// ============================================================
// Grid pieces
// ============================================================

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

function PostCard({
  media,
  automation,
  onOpen,
  onAutomate,
}: {
  media: IgMedia;
  automation: PostAutomation;
  onOpen: () => void;
  onAutomate: () => void;
}) {
  const router = useRouter();
  const kind = mediaKind(media);

  return (
    <li
      className={cn(
        'group bg-card overflow-hidden rounded-xl border transition-colors',
        automation.state === 'live'
          ? 'border-primary/40'
          : 'border-border hover:border-primary/40'
      )}
    >
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

        {/* The automation state, top-left, where the eye lands first —
            "which of these posts is working for me" is the question this
            grid exists to answer. */}
        <span className="absolute top-2 left-2">
          <AutomationBadge automation={automation} />
        </span>

        <span className="absolute bottom-2 left-2 flex flex-wrap gap-1">
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
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-3 bg-linear-to-t from-black/70 to-transparent px-3 py-2 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
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
            variant={automation.state === 'none' ? 'default' : 'outline'}
            className="flex-1"
            onClick={onAutomate}
          >
            <Zap className="size-3.5" />
            {automationActionLabel(automation)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onOpen}
            title="Open this post’s comments"
          >
            <MessageCircle className="size-3.5" />
            {media.open_comments > 0 ? media.open_comments : ''}
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

function PostRow({
  media,
  automation,
  onOpen,
  onAutomate,
}: {
  media: IgMedia;
  automation: PostAutomation;
  onOpen: () => void;
  onAutomate: () => void;
}) {
  return (
    <li className="border-border bg-card hover:border-primary/40 flex items-center gap-3 rounded-xl border p-2.5 transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
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
            <AutomationBadge automation={automation} />
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

        <div className="text-muted-foreground hidden shrink-0 items-center gap-3 text-xs sm:flex">
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

      <Button
        size="sm"
        variant={automation.state === 'none' ? 'default' : 'outline'}
        className="shrink-0"
        onClick={onAutomate}
      >
        <Zap className="size-3.5" />
        <span className="hidden sm:inline">
          {automationActionLabel(automation)}
        </span>
      </Button>
    </li>
  );
}
