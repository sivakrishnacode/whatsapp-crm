'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  Grid3x3,
  Loader2,
  MessageCircle,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

interface IgMedia {
  id: string;
  ig_media_id: string;
  media_type: string | null;
  media_product_type: string | null;
  permalink: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  posted_at: string | null;
  synced_at: string;
}

/**
 * The account's published posts, as a launchpad for comment moderation.
 *
 * Read-only by design. Publishing to Instagram is out of scope for this
 * phase — the API surface exists (media containers + media_publish) but
 * a half-built composer that can post to a real audience is worse than
 * none. What this page is *for* is answering "which post is generating
 * comments I haven't handled", so every card routes into the Comments
 * queue filtered to that post.
 */
export function InstagramPosts() {
  const [media, setMedia] = useState<IgMedia[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mediaRes, commentsRes] = await Promise.all([
        fetch('/api/instagram/media', { cache: 'no-store' }),
        // Open comments only — the number an agent can act on, not a
        // vanity total that never goes down.
        fetch('/api/instagram/comments?status=open&limit=100', {
          cache: 'no-store',
        }),
      ]);

      const mediaData = await mediaRes.json();
      setMedia(mediaData.media ?? []);

      const commentsData = await commentsRes.json();
      const tally: Record<string, number> = {};
      for (const c of commentsData.comments ?? []) {
        tally[c.ig_media_id] = (tally[c.ig_media_id] ?? 0) + 1;
      }
      setCounts(tally);
    } catch {
      toast.error('Could not load posts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  /** Pull in comments made before this post was first synced. */
  async function syncComments(mediaId: string) {
    try {
      const res = await fetch(
        `/api/instagram/media/${mediaId}/comments/sync`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast.success(`Pulled ${data.synced} comment(s).`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Posts</h1>
          <p className="text-sm text-muted-foreground">
            Your published posts, and how many comments are waiting on each.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={sync} disabled={syncing}>
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Sync posts
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading posts…
        </div>
      ) : media.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Grid3x3 className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No posts synced yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Posts are not pulled in automatically — Instagram only pushes
            events for new activity. Sync to fetch your existing ones.
          </p>
          <Button className="mt-4" size="sm" onClick={sync} disabled={syncing}>
            {syncing && <Loader2 className="size-4 animate-spin" />}
            Sync posts
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {media.map((item) => (
            <PostCard
              key={item.id}
              media={item}
              openComments={counts[item.ig_media_id] ?? 0}
              onSyncComments={() => syncComments(item.ig_media_id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PostCard({
  media,
  openComments,
  onSyncComments,
}: {
  media: IgMedia;
  openComments: number;
  onSyncComments: () => void;
}) {
  const router = useRouter();

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-square bg-muted">
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
            <Grid3x3 className="size-8 text-muted-foreground" />
          </div>
        )}

        {openComments > 0 && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
            <MessageCircle className="size-3" />
            {openComments}
          </span>
        )}
      </div>

      <div className="space-y-2 p-3">
        {media.caption && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {media.caption}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {media.posted_at
              ? new Date(media.posted_at).toLocaleDateString()
              : media.media_product_type?.toLowerCase()}
          </span>
          {media.permalink && (
            <a
              href={media.permalink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
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
            onClick={() =>
              router.push(
                `/channels/instagram/comments?media_id=${media.ig_media_id}`,
              )
            }
          >
            <MessageCircle className="size-3.5" />
            {openComments > 0 ? `${openComments} waiting` : 'Comments'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onSyncComments}
            title="Pull in comments made before this post was synced"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}
