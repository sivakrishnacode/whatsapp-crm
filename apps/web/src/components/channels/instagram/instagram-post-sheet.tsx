'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Heart,
  Loader2,
  MessageCircle,
  MessageCircleOff,
  Play,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

/**
 * One post, with its comment thread attached.
 *
 * The point of the sheet is that moderating a post's comments should
 * not cost a page navigation — you open the post that is generating
 * noise, work it, and close it. The full-page Comments queue is still
 * the right tool for working *all* posts at once, so this deliberately
 * does not try to replace it.
 */
export function InstagramPostSheet({
  media,
  open,
  onOpenChange,
  onChanged,
}: {
  media: IgMedia | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires when something here changes counts the grid displays. */
  onChanged: () => void;
}) {
  const [comments, setComments] = useState<IgComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [togglingComments, setTogglingComments] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [slide, setSlide] = useState(0);

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

  // A different post means a different carousel — otherwise opening a
  // 2-slide post after a 10-slide one lands on a slide that isn't there.
  useEffect(() => {
    setSlide(0);
  }, [mediaId]);

  async function syncComments() {
    if (!mediaId) return;
    setSyncing(true);
    try {
      const res = await fetch(`/api/instagram/media/${mediaId}/comments/sync`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast.success(`Pulled ${data.synced} comment(s).`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function toggleComments(enabled: boolean) {
    if (!mediaId) return;
    setTogglingComments(true);
    try {
      const res = await fetch(
        `/api/instagram/media/${mediaId}/comment-settings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error ?? 'Could not change the setting');
      toast.success(enabled ? 'Comments turned on.' : 'Comments turned off.');
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not change the setting'
      );
    } finally {
      setTogglingComments(false);
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="border-border bg-popover text-popover-foreground w-full p-0 sm:max-w-xl"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/50 border-b p-4 pr-12">
            <SheetTitle className="flex items-center gap-2">
              <Badge variant="secondary">{kind.label}</Badge>
              <span
                className="text-muted-foreground text-sm font-normal"
                title={formatAbsolute(media.posted_at)}
              >
                {formatRelative(media.posted_at)}
              </span>
            </SheetTitle>
            <SheetDescription className="sr-only">
              Post details and comment moderation
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="border-border bg-muted relative overflow-hidden rounded-xl border">
              {current?.url ? (
                // Plain <img>: the Instagram CDN host is not in the
                // next/image allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.url}
                  alt={media.caption ?? 'Instagram post'}
                  className="max-h-[380px] w-full object-contain"
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

            {media.caption && (
              <p className="text-foreground text-sm whitespace-pre-wrap">
                {media.caption}
              </p>
            )}

            <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Heart className="size-4" />
                {formatCount(media.like_count)} likes
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MessageCircle className="size-4" />
                {formatCount(media.comments_count)} comments
              </span>
              {media.open_comments > 0 && (
                <Badge>{media.open_comments} waiting</Badge>
              )}
              {media.permalink && (
                <a
                  href={media.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground ml-auto inline-flex items-center gap-1"
                >
                  Open on Instagram <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>

            <div className="border-border bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="flex items-center gap-2">
                <MessageCircleOff className="text-muted-foreground size-4" />
                <div>
                  <p className="text-foreground text-sm">Allow comments</p>
                  <p className="text-muted-foreground text-xs">
                    {media.is_comment_enabled === null
                      ? 'Unknown until the next sync'
                      : media.is_comment_enabled
                        ? 'Anyone can comment on this post'
                        : 'Commenting is turned off on Instagram'}
                  </p>
                </div>
              </div>
              <Switch
                checked={media.is_comment_enabled !== false}
                disabled={togglingComments}
                onCheckedChange={(next) => void toggleComments(next === true)}
              />
            </div>

            <div className="border-border/50 flex flex-wrap items-center gap-2 border-t pt-3">
              <h2 className="text-foreground text-sm font-medium">
                {onlyOpen ? 'Waiting for a reply' : 'All comments'}
              </h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOnlyOpen((current) => !current)}
              >
                {onlyOpen ? 'Show all' : 'Show only waiting'}
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

            {loading ? (
              <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Loading comments…
              </div>
            ) : comments.length === 0 ? (
              <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                {onlyOpen
                  ? 'Nothing waiting on this post.'
                  : 'No comments synced for this post yet.'}
              </p>
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
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
