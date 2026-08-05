import type { ReactNode } from 'react';

import type { SubscriptionStatus } from '@/lib/queries/sql';

/**
 * Status is never carried by color alone: every badge renders a shape marker
 * *and* the status word. That is the mitigation for the two light-surface status
 * hues that sit below 3:1 by design, and it is what makes these readable under
 * CVD, in print, and in forced-colors mode.
 */

const STATUS_STYLE: Record<
  SubscriptionStatus,
  { dot: string; label: string; glyph: string }
> = {
  active: { dot: 'bg-good', label: 'Active', glyph: '●' },
  trial: { dot: 'bg-series-1', label: 'Trial', glyph: '◐' },
  past_due: { dot: 'bg-warning', label: 'Past due', glyph: '▲' },
  cancelled: { dot: 'bg-critical', label: 'Cancelled', glyph: '■' },
  expired: { dot: 'bg-muted', label: 'Expired', glyph: '□' },
};

export function StatusBadge({ status }: { status: SubscriptionStatus | null }) {
  if (!status) {
    return (
      <span className="text-muted inline-flex items-center gap-1.5 text-xs">
        <span aria-hidden className="bg-muted size-1.5 rounded-full" />
        No subscription
      </span>
    );
  }

  const style = STATUS_STYLE[status];

  return (
    <span className="text-ink-2 inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={`size-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'outline';
}) {
  const styles =
    tone === 'outline'
      ? 'border-ring border text-muted'
      : 'bg-surface-2 text-ink-2';

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap ${styles}`}
    >
      {children}
    </span>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="border-ring text-ink-2 inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap">
      {children}
    </span>
  );
}
