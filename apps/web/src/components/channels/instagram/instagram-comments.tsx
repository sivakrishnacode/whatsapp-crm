'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  EyeOff,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface IgMedia {
  ig_media_id: string;
  permalink: string | null;
  thumbnail_url: string | null;
  caption: string | null;
}

interface IgComment {
  id: string;
  ig_comment_id: string;
  ig_media_id: string;
  from_username: string | null;
  from_igsid: string | null;
  contact_id: string | null;
  text: string | null;
  status: 'open' | 'replied' | 'hidden' | 'deleted';
  commented_at: string | null;
  private_replied_at: string | null;
  private_reply_conversation_id: string | null;
  media: IgMedia | null;
}

/** Meta allows one private reply per comment, within 7 days of it. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const STATUS_TABS = [
  { id: 'open', label: 'Needs reply' },
  { id: 'replied', label: 'Replied' },
  { id: 'hidden', label: 'Hidden' },
  { id: '', label: 'All' },
] as const;

export function InstagramComments() {
  const [comments, setComments] = useState<IgComment[]>([]);
  const [status, setStatus] = useState<string>('open');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Set when arriving from a post card on the Posts page. Narrows the
  // queue to that post so "12 comments waiting" leads somewhere exact
  // rather than dumping the agent into the full list.
  const mediaId = useSearchParams().get('media_id');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (mediaId) params.set('media_id', mediaId);
      const query = params.toString();
      const res = await fetch(
        `/api/instagram/comments${query ? `?${query}` : ''}`,
        { cache: 'no-store' },
      );
      const data = await res.json();
      setComments(data.comments ?? []);
    } catch {
      toast.error('Could not load comments.');
    } finally {
      setLoading(false);
    }
  }, [status, mediaId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Webhooks only cover comments made after connecting, so a freshly
   * connected account sees an empty queue on posts full of comments.
   * This pulls the backlog in.
   */
  async function syncPosts() {
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Comments</h1>
          <p className="text-sm text-muted-foreground">
            Reply publicly, or send a private DM to move the conversation to
            the inbox.
          </p>
          {mediaId && (
            <p className="mt-1 text-xs text-muted-foreground">
              Filtered to one post ·{' '}
              <Link
                href="/channels/instagram/comments"
                className="text-primary hover:underline"
              >
                show all
              </Link>
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={syncPosts}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Sync posts
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id || 'all'}
            type="button"
            onClick={() => setStatus(tab.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm transition-colors',
              status === tab.id
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading comments…
        </div>
      ) : comments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <MessageCircle className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No comments here
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            New comments appear automatically. Use “Sync posts” to pull in
            ones from before you connected.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <CommentCard key={comment.id} comment={comment} onChange={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentCard({
  comment,
  onChange,
}: {
  comment: IgComment;
  onChange: () => void;
}) {
  const [mode, setMode] = useState<'public' | 'private' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const commentedAt = comment.commented_at
    ? new Date(comment.commented_at)
    : null;

  // Both of Meta's private-reply limits, checked here so the affordance
  // is absent rather than present-and-failing.
  const alreadyPrivatelyReplied = Boolean(comment.private_replied_at);
  const pastPrivateWindow = commentedAt
    ? Date.now() - commentedAt.getTime() > PRIVATE_REPLY_WINDOW_MS
    : false;
  const canPrivateReply = !alreadyPrivatelyReplied && !pastPrivateWindow;

  async function act(path: string, body?: unknown, successMessage?: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/instagram/comments/${comment.id}${path}`, {
        method: path ? 'POST' : 'DELETE',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      toast.success(successMessage ?? 'Done');
      setMode(null);
      setText('');
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex gap-3">
        {comment.media?.thumbnail_url && (
          // Plain <img>: the Instagram CDN host is not in the
          // next/image allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={comment.media.thumbnail_url}
            alt=""
            className="size-12 shrink-0 rounded-md object-cover"
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">
              @{comment.from_username ?? 'unknown'}
            </span>
            {commentedAt && (
              <span className="text-xs text-muted-foreground">
                {commentedAt.toLocaleString()}
              </span>
            )}
            {comment.status !== 'open' && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {comment.status}
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-foreground">{comment.text}</p>

          {comment.private_reply_conversation_id && (
            <Link
              href={`/inbox?c=${comment.private_reply_conversation_id}`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <MessageCircle className="size-3" />
              Open the DM thread
            </Link>
          )}

          {mode ? (
            <div className="mt-3 space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                autoFocus
                placeholder={
                  mode === 'public'
                    ? 'Reply publicly under the post…'
                    : 'Send a private DM to this person…'
                }
                className="w-full rounded-md border border-border bg-background p-2 text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    act(
                      mode === 'public' ? '/reply' : '/private-reply',
                      { message: text },
                      mode === 'public'
                        ? 'Replied publicly.'
                        : 'Private reply sent — the thread is in your inbox.',
                    )
                  }
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Send
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMode(null)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMode('public')}
              >
                Reply publicly
              </Button>

              <Button
                size="sm"
                onClick={() => setMode('private')}
                disabled={!canPrivateReply}
                title={
                  alreadyPrivatelyReplied
                    ? 'Instagram allows only one private reply per comment'
                    : pastPrivateWindow
                      ? 'Private replies are only allowed within 7 days of the comment'
                      : undefined
                }
              >
                Send DM
              </Button>

              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  act(
                    '/hide',
                    { hidden: comment.status !== 'hidden' },
                    comment.status === 'hidden' ? 'Unhidden.' : 'Hidden.',
                  )
                }
              >
                <EyeOff className="size-4" />
                {comment.status === 'hidden' ? 'Unhide' : 'Hide'}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (!window.confirm('Delete this comment on Instagram?')) return;
                  void act('', undefined, 'Comment deleted.');
                }}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>

              {comment.media?.permalink && (
                <a
                  href={comment.media.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                >
                  View post
                </a>
              )}
            </div>
          )}

          {!canPrivateReply && !mode && (
            <p className="mt-2 text-xs text-muted-foreground">
              {alreadyPrivatelyReplied
                ? 'A private reply was already sent — Instagram allows only one per comment.'
                : 'Too old for a private reply (Instagram allows 7 days).'}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
