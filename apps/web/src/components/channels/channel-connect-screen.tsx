'use client';

import { ArrowLeftRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CHANNELS, type ChannelId } from '@/lib/nav/channels';

/**
 * The split "Connect to <channel>" screen used by every channel that has
 * no backend yet — copy + CTA on the left, a soft brand wash with the two
 * logos on the right, matching the reference product.
 *
 * Every panel row for a placeholder channel lands here (the routes are a
 * single optional catch-all per channel), so this is the whole surface
 * area of Instagram and Web Chat until their APIs are implemented. The
 * CTA is deliberately disabled rather than absent: it states plainly that
 * the integration isn't available yet instead of implying a broken click.
 */
export function ChannelConnectScreen({
  channel: channelId,
  /** Panel row the user arrived from, e.g. "Posts" — sharpens the copy. */
  section,
}: {
  channel: ChannelId;
  section?: string;
}) {
  const channel = CHANNELS[channelId];
  const Icon = channel.icon;

  return (
    <div className="flex min-h-full flex-col overflow-hidden rounded-xl border border-border lg:flex-row">
      {/* Left: copy + CTA */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-card px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-foreground">
          Connect to {channel.label}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">{channel.tagline}</p>

        <Button disabled className="mt-2">
          Connect {channel.label}
        </Button>
        <p className="text-xs text-muted-foreground">
          {section
            ? `${section} unlocks once ${channel.label} is connected.`
            : `${channel.label} support is coming soon.`}
        </p>
      </div>

      {/* Right: brand artwork. Purely decorative, so it's hidden from
          assistive tech and dropped entirely on narrow screens. */}
      <div
        aria-hidden="true"
        className={cn(
          'hidden flex-1 items-center justify-center gap-6 lg:flex',
          channel.connectArtClass,
        )}
      >
        <div className="flex size-28 items-center justify-center rounded-full bg-card shadow-sm">
          <img
            src="/conceps-logo/conceps-logo-01.svg"
            alt=""
            className="size-14 rounded-lg"
          />
        </div>
        <ArrowLeftRight className="size-8 text-foreground/70" />
        <div className="flex size-28 items-center justify-center rounded-full bg-card shadow-sm">
          <Icon className={cn('size-14', channel.accentClass)} />
        </div>
      </div>
    </div>
  );
}
