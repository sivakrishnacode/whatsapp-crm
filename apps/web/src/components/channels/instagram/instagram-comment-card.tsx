'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CornerDownRight,
  EyeOff,
  Eye,
  Gift,
  Loader2,
  MessageCircle,
  Send,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  formatAbsolute,
  formatRelative,
  funnelStateLabel,
  handleTint,
  privateReplyBlock,
  privateReplyBlockReason,
} from '@/lib/instagram/format';
import type { IgComment } from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { useSavedReplies } from './use-saved-replies';

/** Instagram rejects comment replies longer than this. */
const MAX_REPLY_CHARS = 2200;

type Mode = 'public' | 'private' | null;

/**
 * What the list can drive from the keyboard.
 *
 * Imperative rather than lifted state: the composer's draft, its saved
 * replies and its busy flag are private to a card, and hoisting them
 * into the list so a keystroke could reach them would make the list own
 * the editing state of 25 cards at once.
 */
export interface CommentCardHandle {
  openPublicReply: () => void;
  openPrivateReply: () => void;
  toggleHide: () => void;
  /** True while the composer is open, so the list stops claiming keys. */
  isComposing: () => boolean;
}

export interface InstagramCommentCardProps {
  comment: IgComment;
  onChange: () => void;
  /** Omit both to render without selection (e.g. inside a post sheet). */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** The post thumbnail. Redundant when the list is already one post. */
  showMedia?: boolean;
  /** Keyboard cursor is on this card. */
  focused?: boolean;
  /** Called on mount/unmount so the list can drive this card by key. */
  registerHandle?: (handle: CommentCardHandle | null) => void;
}

export function InstagramCommentCard({
  comment,
  onChange,
  selected,
  onSelectedChange,
  showMedia = true,
  focused = false,
  registerHandle,
}: InstagramCommentCardProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const savedReplies = useSavedReplies();
  const rootRef = useRef<HTMLLIElement>(null);

  const block = privateReplyBlock(comment);
  const isHidden = comment.status === 'hidden';
  const isDeleted = comment.status === 'deleted';
  const handle = comment.from_username ?? 'unknown';
  const selectable = onSelectedChange !== undefined;

  // Bring the cursor into view on j/k. `nearest` rather than `center`
  // so paging through a queue does not jerk the viewport on every step.
  useEffect(() => {
    if (focused) rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

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

  function send() {
    if (!text.trim() || busy) return;
    void act(
      mode === 'public' ? '/reply' : '/private-reply',
      { message: text },
      mode === 'public'
        ? 'Replied publicly.'
        : 'Private reply sent — the thread is in your inbox.'
    );
  }

  function toggleHide() {
    if (busy || isDeleted) return;
    void act('/hide', { hidden: !isHidden }, isHidden ? 'Unhidden.' : 'Hidden.');
  }

  // Re-registered whenever the closed-over state a handler reads
  // changes, so a keystroke never fires a stale closure — `toggleHide`
  // in particular reads `isHidden` and `busy`.
  useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      openPublicReply: () => {
        if (!isDeleted) setMode('public');
      },
      openPrivateReply: () => {
        if (!isDeleted && !block) setMode('private');
      },
      toggleHide,
      isComposing: () => mode !== null,
    });
    return () => registerHandle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerHandle, mode, isDeleted, isHidden, busy, block]);

  return (
    <li
      ref={rootRef}
      className={cn(
        'bg-card rounded-xl border p-4 transition-colors',
        selected ? 'border-primary/60 bg-primary/[0.03]' : 'border-border',
        // Focus is the keyboard cursor, distinct from selection: a ring
        // rather than a fill, so a card can be both at once and still
        // read as two different things.
        focused && 'ring-primary/70 ring-2 ring-offset-0',
        isDeleted && 'opacity-60'
      )}
    >
      <div className="flex gap-3">
        {selectable && (
          <Checkbox
            checked={selected ?? false}
            onCheckedChange={(next) => onSelectedChange?.(next === true)}
            className="mt-1"
            aria-label={`Select comment from @${handle}`}
          />
        )}

        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase',
            handleTint(comment.from_username)
          )}
          aria-hidden
        >
          {handle.charAt(0)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground font-medium">@{handle}</span>

            <span
              className="text-muted-foreground text-xs"
              title={formatAbsolute(comment.commented_at)}
            >
              {formatRelative(comment.commented_at)}
            </span>

            {comment.parent_comment_id && (
              <Badge variant="ghost" className="text-muted-foreground gap-1">
                <CornerDownRight />
                reply
              </Badge>
            )}

            {comment.status !== 'open' && (
              <Badge
                variant={isDeleted ? 'destructive' : 'secondary'}
                className="capitalize"
              >
                {comment.status}
              </Badge>
            )}

            {comment.contact && (
              <Link
                href={`/contacts?contact=${comment.contact.id}`}
                className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
              >
                <User className="size-3" />
                {comment.contact.name || 'Contact'}
              </Link>
            )}
          </div>

          <p className="text-foreground mt-1 text-sm whitespace-pre-wrap">
            {comment.text || (
              <span className="text-muted-foreground italic">No text</span>
            )}
          </p>

          {/* What was already said back. Without this the queue can tell
              you a comment was handled but not how. */}
          {comment.replies.length > 0 && (
            <ul className="border-border mt-2 space-y-1.5 border-l-2 pl-3">
              {comment.replies.map((reply) => (
                <li key={reply.id} className="text-xs">
                  <span className="text-foreground font-medium">
                    {reply.is_from_business
                      ? 'You'
                      : `@${reply.from_username ?? 'unknown'}`}
                  </span>{' '}
                  <span
                    className="text-muted-foreground"
                    title={formatAbsolute(reply.commented_at)}
                  >
                    {formatRelative(reply.commented_at)}
                  </span>
                  <p className="text-muted-foreground whitespace-pre-wrap">
                    {reply.text}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {/* What the funnel did, if one answered this comment. The
              queue otherwise shows a comment that looks untouched but
              has already had a whole conversation attached to it. */}
          {comment.funnel_run && (
            <div className="border-border bg-muted/30 mt-2 rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-foreground inline-flex items-center gap-1 font-medium">
                  <Gift className="size-3" />
                  {comment.funnel_run.funnel?.name ?? 'Comment funnel'}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1',
                    comment.funnel_run.state === 'delivered'
                      ? 'text-accent-green'
                      : comment.funnel_run.state === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                  )}
                >
                  {funnelStateLabel(comment.funnel_run.state)}
                </span>
                {/* Only meaningful once the gate has actually run. */}
                {comment.funnel_run.was_following !== null && (
                  <span className="text-muted-foreground">
                    ·{' '}
                    {comment.funnel_run.was_following
                      ? 'already followed'
                      : 'was not following'}
                  </span>
                )}
              </div>
              {comment.funnel_run.conversation_id && (
                <Link
                  href={`/inbox?c=${comment.funnel_run.conversation_id}`}
                  className="text-primary mt-1 inline-flex items-center gap-1 text-xs hover:underline"
                >
                  <MessageCircle className="size-3" />
                  Open the DM thread
                </Link>
              )}
            </div>
          )}

          {/* Suppressed when a funnel run is shown — it carries the same
              link, and two "Open the DM thread" rows on one card is just
              noise. */}
          {comment.private_reply_conversation_id && !comment.funnel_run && (
            <Link
              href={`/inbox?c=${comment.private_reply_conversation_id}`}
              className="text-primary mt-2 inline-flex items-center gap-1 text-xs hover:underline"
            >
              <MessageCircle className="size-3" />
              Open the DM thread
            </Link>
          )}

          {mode ? (
            <div className="mt-3 space-y-2">
              <textarea
                value={text}
                onChange={(e) =>
                  setText(e.target.value.slice(0, MAX_REPLY_CHARS))
                }
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter sends; Esc backs out. A queue is worked
                  // with both hands on the keyboard.
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'Escape') {
                    setMode(null);
                  }
                }}
                rows={3}
                autoFocus
                placeholder={
                  mode === 'public'
                    ? `Reply publicly to @${handle}…`
                    : `Send a private DM to @${handle}…`
                }
                className="border-border bg-background focus-visible:ring-primary/40 w-full rounded-md border p-2 text-sm outline-none focus-visible:ring-2"
              />

              {savedReplies.replies.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {savedReplies.replies.map((saved) => (
                    <span key={saved} className="group/chip relative">
                      <button
                        type="button"
                        onClick={() => setText(saved)}
                        className="border-border bg-muted/40 text-muted-foreground hover:border-primary/40 hover:text-foreground max-w-[220px] truncate rounded-full border py-1 pr-6 pl-2.5 text-xs transition-colors"
                        title={saved}
                      >
                        {saved}
                      </button>
                      <button
                        type="button"
                        onClick={() => savedReplies.remove(saved)}
                        aria-label={`Remove saved reply "${saved}"`}
                        className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 transition-opacity group-hover/chip:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || !text.trim()}
                  onClick={send}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {mode === 'public' ? 'Reply' : 'Send DM'}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMode(null)}
                  disabled={busy}
                >
                  Cancel
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!text.trim() || savedReplies.isFull}
                  onClick={() => {
                    savedReplies.add(text);
                    toast.success('Saved as a quick reply.');
                  }}
                  title={
                    savedReplies.isFull
                      ? 'Quick reply list is full — remove one first'
                      : 'Save this as a reusable quick reply'
                  }
                >
                  <Sparkles className="size-4" />
                  Save
                </Button>

                <span className="text-muted-foreground ml-auto text-xs">
                  {text.length}/{MAX_REPLY_CHARS} · ⌘↵ to send
                </span>
              </div>
            </div>
          ) : (
            !isDeleted && (
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
                  disabled={!!block}
                  title={privateReplyBlockReason(block) || undefined}
                >
                  Send DM
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={toggleHide}
                >
                  {isHidden ? (
                    <Eye className="size-4" />
                  ) : (
                    <EyeOff className="size-4" />
                  )}
                  {isHidden ? 'Unhide' : 'Hide'}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>

                {showMedia && comment.media?.permalink && (
                  <a
                    href={comment.media.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground ml-auto text-xs"
                  >
                    View post
                  </a>
                )}
              </div>
            )
          )}

          {block && !mode && !isDeleted && (
            <p className="text-muted-foreground mt-2 text-xs">
              {privateReplyBlockReason(block, comment.funnel_run?.funnel?.name)}
            </p>
          )}
        </div>

        {showMedia && comment.media?.thumbnail_url && (
          // Plain <img>: the Instagram CDN host is not in the
          // next/image allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={comment.media.thumbnail_url}
            alt=""
            className="hidden size-14 shrink-0 rounded-md object-cover sm:block"
          />
        )}
      </div>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Delete this comment?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              It is removed from Instagram for everyone and cannot be restored.
              To take it out of public view reversibly, hide it instead.
            </DialogDescription>
          </DialogHeader>

          <p className="border-border bg-muted/40 text-foreground rounded-md border p-3 text-sm">
            <span className="font-medium">@{handle}</span>: {comment.text}
          </p>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(false);
                void act('', undefined, 'Comment deleted.');
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
