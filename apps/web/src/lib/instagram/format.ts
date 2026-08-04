import type { IgComment, IgFunnelRunState, IgMedia } from './types';

/** Meta allows one private reply per comment, within 7 days of it. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Short relative time for dense lists ("3h ago"), falling back to a
 * date once "42d ago" stops being easier to read than "12 Mar".
 *
 * Callers should put the absolute timestamp in a `title` — relative
 * time is quick to scan but useless for "was this before or after the
 * campaign went out".
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** 1_240 → "1.2k". Keeps engagement numbers from wrapping a tile. */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

/**
 * "79 likes", "1 comment", "— likes".
 *
 * Exists because "1 comments" is the kind of thing that makes a product
 * look unfinished, and the check has to live next to the formatting or
 * it gets forgotten at the next call site.
 */
export function formatCountLabel(
  value: number | null | undefined,
  singular: string,
  plural = `${singular}s`
): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

export interface MediaKind {
  label: string;
  /** True when the tile should show a play affordance. */
  isVideo: boolean;
  isCarousel: boolean;
}

/**
 * What kind of post this is, in the words Instagram itself uses.
 *
 * `media_product_type` (REELS/FEED/STORY/AD) is checked before
 * `media_type` (IMAGE/VIDEO/CAROUSEL_ALBUM) because a Reel is stored as
 * a VIDEO and calling it "Video" loses the distinction that matters to
 * anyone looking at the grid.
 */
export function mediaKind(media: {
  media_type: string | null;
  media_product_type: string | null;
}): MediaKind {
  const product = media.media_product_type?.toUpperCase();
  const type = media.media_type?.toUpperCase();
  const isCarousel = type === 'CAROUSEL_ALBUM';

  if (product === 'REELS') return { label: 'Reel', isVideo: true, isCarousel };
  if (product === 'STORY')
    return { label: 'Story', isVideo: type === 'VIDEO', isCarousel };
  if (product === 'AD')
    return { label: 'Ad', isVideo: type === 'VIDEO', isCarousel };
  if (isCarousel)
    return { label: 'Carousel', isVideo: false, isCarousel: true };
  if (type === 'VIDEO')
    return { label: 'Video', isVideo: true, isCarousel: false };
  return { label: 'Photo', isVideo: false, isCarousel: false };
}

/**
 * A post named for a dropdown row.
 *
 * Captions are the only human-readable thing Instagram gives a post, and
 * plenty of posts have none — hence the media-type fallback, so a picker
 * never renders a column of blanks. Never the media id: an 18-digit
 * number identifies nothing to a human.
 */
export function postLabel(post: {
  caption: string | null;
  media_product_type: string | null;
  media_type: string | null;
}): string {
  const caption = post.caption?.trim().replace(/\s+/g, ' ');
  if (caption) {
    return caption.length > 40 ? `${caption.slice(0, 40)}…` : caption;
  }
  const kind = post.media_product_type || post.media_type || 'Post';
  return kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** Best available preview URL, largest first. */
export function mediaPreviewUrl(media: IgMedia): string | null {
  return (
    media.media_url ??
    media.thumbnail_url ??
    media.children?.[0]?.mediaUrl ??
    media.children?.[0]?.thumbnailUrl ??
    null
  );
}

export type PrivateReplyBlock =
  | 'already-replied'
  | 'funnel-claimed'
  | 'window-closed'
  | null;

/**
 * Why a private reply is unavailable, or `null` if it is available.
 *
 * Both of Meta's limits are permanent for a given comment, so the UI
 * disables the affordance rather than letting the agent write a message
 * that the API will reject.
 */
export function privateReplyBlock(comment: IgComment): PrivateReplyBlock {
  // A funnel spends the same single private reply an agent would, so
  // this is the same block — named separately only because "already
  // sent" reads as an accusation when nobody on the team sent anything.
  if (comment.private_replied_at) {
    return comment.funnel_run ? 'funnel-claimed' : 'already-replied';
  }
  if (!comment.commented_at) return null;
  const age = Date.now() - new Date(comment.commented_at).getTime();
  return age > PRIVATE_REPLY_WINDOW_MS ? 'window-closed' : null;
}

export function privateReplyBlockReason(
  block: PrivateReplyBlock,
  funnelName?: string | null,
): string {
  if (block === 'already-replied')
    return 'A private reply was already sent — Instagram allows only one per comment.';
  if (block === 'funnel-claimed')
    return funnelName
      ? `The “${funnelName}” funnel used this comment’s one private reply.`
      : 'A comment funnel used this comment’s one private reply.';
  if (block === 'window-closed')
    return 'Too old for a private reply — Instagram allows 7 days.';
  return '';
}

/** Plain-language stage label for a funnel run. */
export function funnelStateLabel(state: IgFunnelRunState): string {
  switch (state) {
    case 'awaiting_optin':
      return 'DM sent — waiting for them to tap';
    case 'awaiting_follow':
      return 'Asked them to follow';
    case 'delivered':
      return 'Reward delivered';
    case 'failed':
      return 'Funnel failed';
  }
}

/**
 * Deterministic avatar tint from a handle.
 *
 * Instagram exposes no profile picture for a commenter (there is no
 * public user lookup), so the alternative to a coloured initial is
 * fifty identical grey circles.
 */
export function handleTint(handle: string | null): string {
  const palette = [
    'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400',
  ];
  if (!handle) return palette[0];
  let hash = 0;
  for (let i = 0; i < handle.length; i++)
    hash = (hash * 31 + handle.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}
