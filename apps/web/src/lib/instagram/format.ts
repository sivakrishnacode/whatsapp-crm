import type { IgComment, IgMedia } from './types';

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

export type PrivateReplyBlock = 'already-replied' | 'window-closed' | null;

/**
 * Why a private reply is unavailable, or `null` if it is available.
 *
 * Both of Meta's limits are permanent for a given comment, so the UI
 * disables the affordance rather than letting the agent write a message
 * that the API will reject.
 */
export function privateReplyBlock(comment: IgComment): PrivateReplyBlock {
  if (comment.private_replied_at) return 'already-replied';
  if (!comment.commented_at) return null;
  const age = Date.now() - new Date(comment.commented_at).getTime();
  return age > PRIVATE_REPLY_WINDOW_MS ? 'window-closed' : null;
}

export function privateReplyBlockReason(block: PrivateReplyBlock): string {
  if (block === 'already-replied')
    return 'A private reply was already sent — Instagram allows only one per comment.';
  if (block === 'window-closed')
    return 'Too old for a private reply — Instagram allows 7 days.';
  return '';
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
