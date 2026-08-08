'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * The workspace's own mark — wherever the product says "you are in
 * Acme Retail".
 *
 * A rounded SQUARE, not a circle. Circles read as people in this app
 * (the rail footer and every teammate list use one), so a workspace that
 * borrowed the shape would look like a user account. The distinction is
 * the whole reason to have a component instead of reusing <Avatar>,
 * which is round at three levels and would have to be fought at each.
 *
 * `object-contain` on a plate, never `object-cover`: a customer uploads
 * a mark, and cropping someone's logo to fill a square is the kind of
 * detail that makes a product look careless. Letterboxing is the honest
 * result when their artwork is not square.
 *
 * With no logo it falls back to the first letter of the name — the
 * behaviour the header already had, kept identical so nothing regresses
 * for the accounts (most of them) that never upload one.
 */

const SIZES = {
  sm: { box: 'size-6 rounded-md', text: 'text-[11px]' },
  md: { box: 'size-11 rounded-lg', text: 'text-base' },
  lg: { box: 'size-16 rounded-xl', text: 'text-2xl' },
} as const;

export type WorkspaceLogoSize = keyof typeof SIZES;

export function WorkspaceLogo({
  name,
  logoUrl,
  size = 'sm',
  className,
}: {
  name: string | null | undefined;
  logoUrl: string | null | undefined;
  size?: WorkspaceLogoSize;
  className?: string;
}) {
  // A logo can outlive its object — someone empties the bucket, an old
  // URL survives on a cached page. Falling back to the initial beats
  // rendering the browser's broken-image glyph in the header.
  //
  // The failure is remembered as the URL that failed, not as a boolean:
  // a boolean would need an effect to reset it when the logo changes,
  // and a new URL deserves a fresh attempt. Comparing makes that
  // automatic with no effect at all.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const dims = SIZES[size];
  const initial = name?.trim().charAt(0).toUpperCase() || '?';
  const showImage = Boolean(logoUrl) && logoUrl !== failedUrl;

  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden font-semibold',
        // The plate stays behind a transparent PNG, so a dark mark on a
        // transparent background is still legible in dark mode.
        showImage ? 'bg-white ring-1 ring-border' : 'bg-primary/10 text-primary',
        dims.box,
        dims.text,
        className,
      )}
    >
      {showImage ? (
        <img
          src={logoUrl!}
          alt=""
          className="size-full object-contain"
          onError={() => setFailedUrl(logoUrl!)}
        />
      ) : (
        initial
      )}
    </span>
  );
}
