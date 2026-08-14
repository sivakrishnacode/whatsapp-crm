'use client';

/**
 * One card on the Integrations page, whatever kind of integration it is.
 *
 * WHY ONE COMPONENT FOR BOTH SECTIONS
 *   Connected apps (OAuth) and stores/webhooks (API keys) are different
 *   things technically and identical things visually — a logo, a name, a
 *   state, what is connected, and one action. They were two sets of
 *   hand-written cards that had already drifted: different badge
 *   wording, different empty states, and the same 50 lines of markup
 *   copied four times. Adding a fifth integration meant copying it again.
 *
 * SIZING
 *   These were `max-w-[350px]` in a `flex-wrap`, which produced very tall
 *   cards with a dead zone between the account row and the button, and
 *   left an orphan on its own line whenever the count was not a multiple
 *   of the column count. The grid below fills the row instead, and the
 *   card is only as tall as its content: the footer sits under the body
 *   rather than being pushed to the bottom of the tallest sibling.
 */

import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

export type IntegrationStatus = 'connected' | 'attention' | 'off';

const STATUS_STYLES: Record<
  IntegrationStatus,
  { icon: typeof CheckCircle; className: string }
> = {
  connected: {
    icon: CheckCircle,
    className:
      'border-green-500/20 bg-green-500/10 text-accent-green',
  },
  // Amber, not red. A connection that needs re-authorising is a chore,
  // not an outage, and red here would sit next to genuinely broken
  // things and mean the same as them.
  attention: {
    icon: AlertCircle,
    className:
      'border-amber-500/20 bg-amber-500/10 text-accent-amber',
  },
  off: {
    icon: XCircle,
    className: 'border-border bg-muted/60 text-muted-foreground',
  },
};

/**
 * The grid the cards live in.
 *
 * `auto-fill` + a min track, not fixed max-widths: the row fills at any
 * viewport, and a fourth card joins the third instead of starting a
 * lonely second row.
 */
export function IntegrationGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(clamp(240px,100%,300px),1fr))] gap-3">
      {children}
    </div>
  );
}

export function IntegrationCard({
  icon,
  name,
  blurb,
  status,
  statusLabel,
  badge,
  children,
  footer,
}: {
  icon: ReactNode;
  name: string;
  blurb: string;
  status: IntegrationStatus;
  statusLabel: string;
  /** e.g. a "Beta" chip beside the name. */
  badge?: ReactNode;
  /** Connected accounts, stores — omitted entirely when there are none. */
  children?: ReactNode;
  footer: ReactNode;
}) {
  const { icon: StatusIcon, className: statusClass } = STATUS_STYLES[status];

  return (
    <div className="border-border bg-card/45 hover:border-border/80 flex flex-col gap-3 rounded-xl border p-4 transition-colors">
      <div className="flex items-start gap-3">
        {icon}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-foreground truncate text-sm font-semibold">
              {name}
            </h3>
            {badge}
          </div>
          {/* Clamped rather than truncated: two lines is enough for every
              blurb we have, and a fixed height would leave a gap under
              the short ones. */}
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-snug">
            {blurb}
          </p>
        </div>

        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
            statusClass,
          )}
        >
          <StatusIcon className="size-2.5" />
          {statusLabel}
        </span>
      </div>

      {children && <div className="space-y-1">{children}</div>}

      <div className="mt-auto">{footer}</div>
    </div>
  );
}

/**
 * One connected thing inside a card — an account, a store.
 *
 * The remove control is always in the DOM and always focusable; only its
 * COLOUR is held back until hover or focus. Hiding it outright would put
 * disconnecting behind a mouse, which is the kind of thing that reads as
 * tidy and is simply unusable by keyboard.
 */
export function IntegrationRow({
  label,
  sublabel,
  tone = 'default',
  action,
}: {
  label: string;
  sublabel?: string;
  tone?: 'default' | 'attention';
  action?: ReactNode;
}) {
  return (
    <div className="bg-muted/40 group/row flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="text-foreground truncate font-mono text-[11px]">
          {label}
        </p>
        {sublabel && (
          <p
            className={cn(
              'truncate text-[10px]',
              tone === 'attention'
                ? 'text-accent-amber'
                : 'text-muted-foreground',
            )}
          >
            {sublabel}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
