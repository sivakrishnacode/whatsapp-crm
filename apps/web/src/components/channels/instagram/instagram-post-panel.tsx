'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  ClipboardCopy,
  ExternalLink,
  EyeOff,
  Heart,
  Link2,
  Loader2,
  Maximize2,
  MessageCircle,
  MessageCircleOff,
  PanelRight,
  Play,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import {
  formatAbsolute,
  formatCount,
  formatCountLabel,
  formatRelative,
  mediaKind,
  mediaPreviewUrl,
} from '@/lib/instagram/format';
import type {
  IgComment,
  IgCommentListResponse,
  IgMedia,
} from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { InstagramCommentCard } from './instagram-comment-card';
import { type PanelLayout, usePanelLayout } from './use-panel-layout';

/** Captions past this many characters get a "Show more". */
const CAPTION_CLAMP_CHARS = 220;

/**
 * One post, with its comment thread attached.
 *
 * The point of the panel is that moderating a post's comments should
 * not cost a page navigation — you open the post that is generating
 * noise, work it, and close it. The full-page Comments queue is still
 * the right tool for working *all* posts at once, so this deliberately
 * does not try to replace it.
 *
 * TWO LAYOUTS, ONE BODY
 *   Side keeps the grid visible behind it, so moving between posts is
 *   one click. Centre trades that away for width: at ≥lg it splits into
 *   post-on-the-left / comments-on-the-right, which is the layout you
 *   want when one post has forty comments to work through. The choice
 *   is the user's and persists — see `usePanelLayout`.
 */
export function InstagramPostPanel({
  media,
  open,
  onOpenChange,
  onChanged,
}: {
  media: IgMedia | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fires when something here changes what the grid displays. Awaited
   * where the panel needs the refreshed `media` back before it can drop
   * an optimistic local state — so returning the reload promise matters.
   */
  onChanged: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [comments, setComments] = useState<IgComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<'hide' | 'resolve' | null>(null);
  // The position the switch was dragged to, held until Meta confirms it.
  // `null` means "not mid-flight — show what Meta last told us".
  const [pendingCommentsEnabled, setPendingCommentsEnabled] = useState<
    boolean | null
  >(null);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [slide, setSlide] = useState(0);
  const { layout, setLayout } = usePanelLayout();

  const mediaId = media?.ig_media_id;

  const load = useCallback(async () => {
    if (!mediaId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ media_id: mediaId, limit: '50' });
      if (onlyOpen) params.set('status', 'open');
      const res = await fetch(`/api/instagram/comments?${params.toString()}`, {
        cache: 'no-store',
      });
      const data: IgCommentListResponse = await res.json();
      setComments(data.comments ?? []);
    } catch {
      toast.error('Could not load this post’s comments.');
    } finally {
      setLoading(false);
    }
  }, [mediaId, onlyOpen]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // A different post means a different carousel and a different caption
  // — otherwise opening a 2-slide post after a 10-slide one lands on a
  // slide that isn't there, with the previous post's caption expanded.
  useEffect(() => {
    setSlide(0);
    setCaptionExpanded(false);
  }, [mediaId]);

  async function post(
    path: string,
    body?: unknown,
    onSuccess?: (data: Record<string, unknown>) => void
  ) {
    const res = await fetch(`/api/instagram/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Request failed');
    onSuccess?.(data);
    return data;
  }

  async function syncComments() {
    if (!mediaId) return;
    setSyncing(true);
    try {
      const data = await post(`media/${mediaId}/comments/sync`);
      toast.success(`Pulled ${data.synced} comment(s).`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Likes and comment totals are a sync-time snapshot — nothing pushes
   * a like count over a webhook — so the panel needs its own way to say
   * "these numbers look old".
   */
  async function refreshPost() {
    if (!mediaId) return;
    setRefreshing(true);
    try {
      await post(`media/${mediaId}/refresh`);
      toast.success('Post refreshed from Instagram.');
      // The grid owns the media object this panel renders, so reloading
      // it is what updates what you are looking at.
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Meta is the source of truth for this switch, and the value comes
   * back through the grid rather than from the response — so the local
   * `pending` position is what the switch shows until `onChanged()`
   * has finished reloading. Clearing it any earlier makes the thumb
   * snap back to the old position for a beat.
   */
  async function toggleComments(enabled: boolean) {
    if (!mediaId) return;
    setPendingCommentsEnabled(enabled);
    try {
      await post(`media/${mediaId}/comment-settings`, { enabled });
      toast.success(enabled ? 'Comments turned on.' : 'Comments turned off.');
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not change the setting'
      );
    } finally {
      setPendingCommentsEnabled(null);
    }
  }

  /** Hide or clear every comment currently listed for this post. */
  async function runBulk(action: 'hide' | 'resolve') {
    const ids = comments.filter((c) => c.status === 'open').map((c) => c.id);
    if (!ids.length) return;
    if (
      action === 'hide' &&
      !window.confirm(
        `Hide ${ids.length} comment(s) on Instagram? They stay visible to their author.`
      )
    ) {
      return;
    }

    setBulkBusy(action);
    try {
      const data = await post('comments/bulk', { ids, action });
      toast.success(
        action === 'hide'
          ? `${data.succeeded} comment(s) hidden.`
          : `${data.succeeded} comment(s) marked as handled.`
      );
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBulkBusy(null);
    }
  }

  async function copy(value: string | null, label: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      // Clipboard access is denied outside a secure context, and a
      // silent no-op looks like a broken button.
      toast.error(`Could not copy the ${label.toLowerCase()}.`);
    }
  }

  if (!media) return null;

  const kind = mediaKind(media);
  const slides = media.children?.length
    ? media.children.map((child) => ({
        url: child.mediaUrl ?? child.thumbnailUrl ?? null,
        isVideo: child.mediaType?.toUpperCase() === 'VIDEO',
      }))
    : [{ url: mediaPreviewUrl(media), isVideo: kind.isVideo }];
  const current = slides[Math.min(slide, slides.length - 1)];

  const togglingComments = pendingCommentsEnabled !== null;
  const caption = media.caption ?? '';
  const captionIsLong = caption.length > CAPTION_CLAMP_CHARS;
  const openCount = comments.filter((c) => c.status === 'open').length;

  const titleContent = (
    <>
      <Badge variant="secondary">{kind.label}</Badge>
      <span
        className="text-muted-foreground text-sm font-normal"
        title={formatAbsolute(media.posted_at)}
      >
        {formatRelative(media.posted_at)}
      </span>
    </>
  );

  /** The post itself: media, caption, engagement, actions, settings. */
  const postSection = (
    <>
      <div className="border-border bg-muted relative overflow-hidden rounded-xl border">
        {current?.url ? (
          // Plain <img>: the Instagram CDN host is not in the
          // next/image allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.url}
            alt={media.caption ?? 'Instagram post'}
            className={cn(
              'w-full object-contain',
              layout === 'center' ? 'max-h-[380px]' : 'max-h-[340px]'
            )}
          />
        ) : (
          <div className="text-muted-foreground flex h-56 items-center justify-center text-sm">
            No preview available
          </div>
        )}

        {current?.isVideo && (
          <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 p-2 text-white">
            <Play className="size-4 fill-current" />
          </span>
        )}

        {slides.length > 1 && (
          <>
            {/* A counter as well as dots: past four or five slides the
                dots stop being countable at a glance. */}
            <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
              {slide + 1} / {slides.length}
            </span>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label="Previous slide"
              className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full"
              onClick={() =>
                setSlide((s) => (s - 1 + slides.length) % slides.length)
              }
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label="Next slide"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full"
              onClick={() => setSlide((s) => (s + 1) % slides.length)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
              {slides.map((_, index) => (
                <span
                  key={index}
                  className={cn(
                    'size-1.5 rounded-full transition-colors',
                    index === slide ? 'bg-white' : 'bg-white/40'
                  )}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {caption ? (
        <div>
          <p
            className={cn(
              'text-foreground text-sm whitespace-pre-wrap',
              !captionExpanded && captionIsLong && 'line-clamp-3'
            )}
          >
            {caption}
          </p>
          {captionIsLong && (
            <button
              type="button"
              onClick={() => setCaptionExpanded((value) => !value)}
              className="text-muted-foreground hover:text-foreground mt-1 text-xs"
            >
              {captionExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm italic">No caption</p>
      )}

      {/* Engagement reads as one line of facts. The permalink used to
          live here with `ml-auto`, which pushed it onto a line of its
          own the moment the row wrapped — it belongs with the actions. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Heart className="size-4" />
          {formatCountLabel(media.like_count, 'like')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MessageCircle className="size-4" />
          {formatCountLabel(media.comments_count, 'comment')}
        </span>
        {media.open_comments > 0 && (
          <Badge>{media.open_comments} waiting</Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {media.permalink && (
          // `nativeButton={false}` because this renders an <a>: Base UI
          // otherwise assumes a real <button> and warns that native
          // button semantics were dropped. It is a link — navigating to
          // Instagram — so an anchor is the correct element.
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={
              <a href={media.permalink} target="_blank" rel="noreferrer" />
            }
          >
            <ExternalLink className="size-3.5" />
            Instagram
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!media.permalink}
          onClick={() => void copy(media.permalink, 'Link')}
        >
          <Link2 className="size-3.5" />
          Copy link
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!caption}
          onClick={() => void copy(caption, 'Caption')}
        >
          <ClipboardCopy className="size-3.5" />
          Copy caption
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={refreshPost}
          disabled={refreshing}
          title="Re-read likes, comment counts and the caption from Instagram"
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      <div className="border-border bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {togglingComments ? (
            <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
          ) : (
            <MessageCircleOff className="text-muted-foreground size-4 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-foreground text-sm">Allow comments</p>
            <p className="text-muted-foreground text-xs">
              {togglingComments
                ? pendingCommentsEnabled
                  ? 'Turning comments on…'
                  : 'Turning comments off…'
                : media.is_comment_enabled === null
                  ? 'Unknown until the next sync'
                  : media.is_comment_enabled
                    ? 'Anyone can comment on this post'
                    : 'Commenting is turned off on Instagram'}
            </p>
          </div>
        </div>
        <Switch
          // Shows the requested position while the call is in flight, so
          // the thumb moves on click instead of sitting still until Meta
          // answers and the grid reloads. Reverts on failure.
          checked={pendingCommentsEnabled ?? media.is_comment_enabled !== false}
          disabled={togglingComments}
          onCheckedChange={(next) => void toggleComments(next === true)}
        />
      </div>

      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() =>
          router.push(
            `/channels/instagram/comments?media_id=${media.ig_media_id}`
          )
        }
      >
        <MessageCircle className="size-3.5" />
        Open in the comments queue
      </Button>
    </>
  );

  const commentsSection = (
    <>
      <div
        className={cn(
          'flex flex-wrap items-center gap-2',
          // The rule only reads as a divider when the two sections are
          // stacked; at the top of its own column it is a stray line.
          layout === 'side' && 'border-border/50 border-t pt-3'
        )}
      >
        <h2 className="text-foreground text-sm font-medium">
          {onlyOpen ? 'Waiting for a reply' : 'All comments'}
        </h2>
        {comments.length > 0 && (
          <Badge variant="secondary">{comments.length}</Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOnlyOpen((value) => !value)}
        >
          {onlyOpen ? 'Show all' : 'Only waiting'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={syncComments}
          disabled={syncing}
          title="Pull in comments made before this post was synced"
        >
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Sync
        </Button>
      </div>

      {openCount > 0 && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
          <span>{openCount} waiting ·</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={bulkBusy !== null}
            onClick={() => runBulk('resolve')}
            title="Clear them out of the queue without touching Instagram — for comments you answered in the app, or that need no answer"
          >
            {bulkBusy === 'resolve' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <CheckCheck className="size-3" />
            )}
            Mark all handled
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={bulkBusy !== null}
            onClick={() => runBulk('hide')}
          >
            {bulkBusy === 'hide' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <EyeOff className="size-3" />
            )}
            Hide all
          </Button>
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading comments…
        </div>
      ) : comments.length === 0 ? (
        <div className="border-border rounded-lg border border-dashed p-6 text-center">
          <MessageCircle className="text-muted-foreground mx-auto size-6" />
          <p className="text-foreground mt-2 text-sm font-medium">
            {onlyOpen ? 'Nothing waiting' : 'No comments yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {onlyOpen
              ? media.comments_count
                ? `Instagram reports ${formatCount(media.comments_count)} on this post — “Show all” to see the handled ones.`
                : 'This post has no comments to work through.'
              : 'Use Sync to pull in comments made before this post was synced.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <InstagramCommentCard
              key={comment.id}
              comment={comment}
              showMedia={false}
              onChange={() => {
                void load();
                onChanged();
              }}
            />
          ))}
        </ul>
      )}
    </>
  );

  const body =
    layout === 'center' ? (
      // Two independently scrolling columns at ≥lg, so a long comment
      // thread never pushes the post itself off screen. Below lg the
      // dialog is too narrow to split, so it stacks like the side panel.
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="border-border/50 shrink-0 space-y-3 p-4 lg:w-[46%] lg:shrink lg:overflow-y-auto lg:border-r">
          {postSection}
        </div>
        <div className="min-w-0 flex-1 space-y-3 p-4 lg:overflow-y-auto">
          {commentsSection}
        </div>
      </div>
    ) : (
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {postSection}
        {commentsSection}
      </div>
    );

  const layoutToggle = (
    <LayoutToggle layout={layout} onChange={setLayout} className="ml-auto" />
  );

  if (layout === 'center') {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="border-border/50 shrink-0 border-b p-4 pr-12">
            <div className="flex items-center gap-2">
              <DialogTitle className="flex items-center gap-2">
                {titleContent}
              </DialogTitle>
              {layoutToggle}
            </div>
            <DialogDescription className="sr-only">
              Post details and comment moderation
            </DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="border-border bg-popover text-popover-foreground w-full p-0 sm:max-w-xl"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/50 shrink-0 border-b p-4 pr-12">
            <div className="flex items-center gap-2">
              <SheetTitle className="flex items-center gap-2">
                {titleContent}
              </SheetTitle>
              {layoutToggle}
            </div>
            <SheetDescription className="sr-only">
              Post details and comment moderation
            </SheetDescription>
          </SheetHeader>
          {body}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Dock right / open centred. Mirrors the grid-list toggle on the Posts
 * page so the two read as the same kind of control.
 */
function LayoutToggle({
  layout,
  onChange,
  className,
}: {
  layout: PanelLayout;
  onChange: (layout: PanelLayout) => void;
  className?: string;
}) {
  return (
    <div
      className={cn('border-border flex rounded-md border p-0.5', className)}
    >
      <Button
        size="icon-xs"
        variant={layout === 'side' ? 'secondary' : 'ghost'}
        aria-label="Open in the side panel"
        aria-pressed={layout === 'side'}
        title="Side panel"
        onClick={() => onChange('side')}
      >
        <PanelRight className="size-3.5" />
      </Button>
      <Button
        size="icon-xs"
        variant={layout === 'center' ? 'secondary' : 'ghost'}
        aria-label="Open in the centre panel"
        aria-pressed={layout === 'center'}
        title="Centre panel"
        onClick={() => onChange('center')}
      >
        <Maximize2 className="size-3.5" />
      </Button>
    </div>
  );
}
