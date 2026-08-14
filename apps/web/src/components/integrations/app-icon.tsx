'use client';

/**
 * A connected app's product icon.
 *
 * ONE COMPONENT SO THE TWO SURFACES CANNOT DRIFT
 *   The Integrations cards and the automation step picker both show
 *   these. Before this they each drew their own monogram tile, which is
 *   how one of them ends up with real logos and the other with initials.
 *
 * THE MONOGRAM IS A FALLBACK, NOT DEAD CODE
 *   `icon` is optional in the catalogue, and a file can 404 after a
 *   rename. Either way this falls back to the tinted initials rather
 *   than leaving a broken-image glyph or an empty square — a connector
 *   added server-side with no artwork yet still looks deliberate.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { CatalogApp } from '@/lib/automations/connectors';

export function AppIcon({
  app,
  size = 44,
  className,
}: {
  app: Pick<CatalogApp, 'name' | 'icon' | 'monogram' | 'hue'>;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (app.icon && !failed) {
    return (
      /* A local 48px PNG in /public. next/image would add a loader round
         trip for no benefit at this size, and the Shopify/Woo/Zapier
         cards already make the same call. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={app.icon}
        alt=""
        aria-hidden
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={cn('shrink-0 object-contain', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl font-bold',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.28),
        background: `color-mix(in oklch, ${app.hue} 16%, transparent)`,
        color: `color-mix(in oklch, ${app.hue}, var(--foreground) 22%)`,
      }}
    >
      {app.monogram}
    </span>
  );
}
