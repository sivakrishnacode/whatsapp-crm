'use client';

import { useState } from 'react';
import { ExternalLink, Grid3x3, MessageCircle, Send } from 'lucide-react';

import { mediaPreviewUrl } from '@/lib/instagram/format';
import { triggerSummary } from '@/lib/instagram/automation';
import type { IgFunnelDraft, IgMedia } from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

type PreviewTab = 'comment' | 'dm';

/**
 * What the commenter will see, on a phone.
 *
 * WHY A MOCKUP AND NOT A FIELD SUMMARY
 *   The deliverable of this editor is a message sent in the merchant's
 *   name to a stranger. Six textareas cannot answer "does this read like
 *   a person"; a thread can. Every merchant who has published a funnel
 *   that says "Hey {name}!" literally did it because nothing showed them
 *   the message as a message.
 *
 * IT IS A PREVIEW, NOT A SIMULATOR
 *   Rendered from the draft only — it never calls Meta and never sends.
 *   The follow ask is shown whenever the gate is on, even though at
 *   runtime it is skipped for people who already follow: the merchant is
 *   proof-reading their own copy, and copy they cannot see is copy they
 *   cannot fix.
 */
export function InstagramAutomationPreview({
  draft,
  media,
  username,
  triggerMode = 'all',
}: {
  draft: IgFunnelDraft;
  media: IgMedia | null;
  /** The business's own handle, for the reply's byline. */
  username?: string | null;
  /**
   * The editor's trigger mode, which the draft cannot express: an empty
   * `keywords` means "any comment" on the server, so mid-edit — "Specific
   * words" picked, nothing typed yet — the preview would otherwise claim
   * every comment matches, contradicting the control the merchant just set.
   */
  triggerMode?: 'specific' | 'all';
}) {
  const [tab, setTab] = useState<PreviewTab>('comment');
  const preview = media ? mediaPreviewUrl(media) : null;
  const handle = username ? `@${username.replace(/^@/, '')}` : 'your_account';

  const awaitingKeyword = triggerMode === 'specific' && draft.keywords.length === 0;
  // The trigger word a commenter would actually type. First keyword
  // because that is the one the merchant will put in the caption.
  const sampleComment = awaitingKeyword
    ? 'your trigger word'
    : (draft.keywords[0] ?? 'Any comment will be automated');
  const publicReply = draft.public_reply_texts.find((t) => t.trim());

  return (
    <div className="flex flex-col items-center gap-3">
      {/* The device. Fixed aspect so the thread does not reflow as the
          merchant types, which is distracting when the point is to read
          it as a finished message. */}
      <div className="border-foreground/80 bg-background w-full max-w-[320px] overflow-hidden rounded-[2.25rem] border-[10px] shadow-xl">
        <div className="text-muted-foreground flex items-center justify-between px-5 pt-2 pb-1 text-[10px] font-medium">
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <span className="bg-muted-foreground/60 h-2 w-4 rounded-sm" />
            <span className="bg-muted-foreground/60 h-2 w-2 rounded-full" />
          </span>
        </div>

        <div className="flex gap-1 px-2 pb-2">
          <PreviewTabButton
            active={tab === 'comment'}
            onClick={() => setTab('comment')}
            icon={<MessageCircle className="size-3.5" />}
            label="Comment"
          />
          <PreviewTabButton
            active={tab === 'dm'}
            onClick={() => setTab('dm')}
            icon={<Send className="size-3.5" />}
            label="DMs"
          />
        </div>

        {tab === 'comment' ? (
          <div className="bg-muted/40">
            <div className="bg-muted relative aspect-square w-full">
              {preview ? (
                // Plain <img>: the Instagram CDN host is not in the
                // next/image allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-2 text-xs">
                  <Grid3x3 className="size-7" />
                  {media ? 'No preview' : 'Every post'}
                </div>
              )}
            </div>

            <div className="space-y-2.5 bg-neutral-900/95 p-3 text-white">
              <PreviewComment
                author="a_commenter"
                text={sampleComment}
                muted={draft.keywords.length === 0}
              />
              {publicReply ? (
                <PreviewComment
                  author={handle}
                  text={publicReply}
                  indent
                />
              ) : (
                <p className="pl-8 text-[10px] text-white/40 italic">
                  No public reply — the DM goes out silently.
                </p>
              )}
              <div className="flex items-center gap-2 border-t border-white/10 pt-2 text-[11px] text-white/40">
                <span className="size-5 shrink-0 rounded-full bg-white/20" />
                Add a comment…
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-muted/30 min-h-[380px] space-y-3 p-3">
            <p className="text-muted-foreground text-center text-[10px]">
              {draft.reply_delay_seconds > 0
                ? `Sent ${draft.reply_delay_seconds}s after the comment`
                : 'Sent as soon as they comment'}
            </p>

            <PreviewBubble
              text={draft.optin_text}
              button={draft.optin_button_label}
            />

            {draft.follow_gate_enabled && (
              <>
                <PreviewReply label={draft.optin_button_label} />
                <PreviewBubble
                  text={draft.follow_ask_text ?? ''}
                  button={draft.follow_button_label}
                  note="Only people who don’t follow you see this"
                />
                <PreviewReply label={draft.follow_button_label} />
              </>
            )}

            {!draft.follow_gate_enabled && (
              <PreviewReply label={draft.optin_button_label} />
            )}

            <PreviewBubble
              text={draft.reward_text}
              links={(draft.reward_buttons ?? []).filter((b) =>
                b.label.trim()
              )}
            />
          </div>
        )}
      </div>

      <p className="text-muted-foreground max-w-[320px] text-center text-xs">
        {awaitingKeyword
          ? 'Add a trigger word to see what starts this.'
          : draft.keywords.length === 0
            ? 'Every comment on this post gets this.'
            : `Comments containing ${triggerSummary(draft.keywords)} get this.`}
      </p>
    </div>
  );
}

function PreviewTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PreviewComment({
  author,
  text,
  indent,
  muted,
}: {
  author: string;
  text: string;
  indent?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={cn('flex items-start gap-2', indent && 'pl-6')}>
      <span className="mt-0.5 size-5 shrink-0 rounded-full bg-white/20" />
      <p className="min-w-0 text-[11px] leading-snug">
        <span className="font-semibold">{author}</span>{' '}
        <span className={muted ? 'text-white/50 italic' : 'text-white/90'}>
          {text}
        </span>
      </p>
    </div>
  );
}

/** A message from the business, with its button underneath. */
function PreviewBubble({
  text,
  button,
  links,
  note,
}: {
  text: string;
  button?: string;
  links?: { label: string; url: string }[];
  note?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="border-border bg-card max-w-[85%] space-y-2 rounded-2xl rounded-bl-sm border p-2.5">
        <p className="text-foreground text-[11px] leading-snug whitespace-pre-wrap">
          {text.trim() || (
            <span className="text-muted-foreground italic">Empty message</span>
          )}
        </p>
        {button && (
          <div className="border-border/70 rounded-lg border py-1 text-center text-[11px] font-medium">
            {button}
          </div>
        )}
        {links?.map((link, i) => (
          <div
            key={i}
            className="border-border/70 text-primary flex items-center justify-center gap-1 rounded-lg border py-1 text-center text-[11px] font-medium"
          >
            {link.label}
            <ExternalLink className="size-2.5" />
          </div>
        ))}
      </div>
      {note && (
        <p className="text-muted-foreground pl-1 text-[10px]">{note}</p>
      )}
    </div>
  );
}

/** The commenter's tap, echoed back into the thread as they see it. */
function PreviewReply({ label }: { label: string }) {
  return (
    <div className="flex justify-end">
      <span className="bg-primary text-primary-foreground max-w-[75%] rounded-2xl rounded-br-sm px-3 py-1.5 text-[11px] font-medium">
        {label}
      </span>
    </div>
  );
}
