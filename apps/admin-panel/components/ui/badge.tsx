import type { ReactNode } from 'react';

import type { SubscriptionStatus } from '@/lib/queries/sql';

/**
 * Pills and badges.
 *
 * ⚠️ Status is never carried by colour alone: a status pill renders a shape
 * glyph AND a word. The tone colour is a second channel. That is what keeps
 * these readable under CVD, in print and in forced-colors mode — and why the
 * glyph is `aria-hidden` (the word already says it).
 */

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'primary';

export const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-good-soft text-good-fg',
  warn: 'bg-warn-soft text-warn-fg',
  bad: 'bg-bad-soft text-bad-fg',
  info: 'bg-info-soft text-info-fg',
  neutral: 'bg-neutral-soft text-neutral-fg',
  primary: 'bg-primary-soft text-primary-soft-ink',
};

/**
 * A status pill. `glyph` is the shape that carries the state without colour;
 * pass one whenever the pill reports a state rather than a category.
 */
export function Pill({
  children,
  tone = 'neutral',
  glyph,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  glyph?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {glyph ? (
        <span aria-hidden className="text-[9px] leading-none">
          {glyph}
        </span>
      ) : null}
      {children}
    </span>
  );
}

const STATUS_STYLE: Record<
  SubscriptionStatus,
  { tone: Tone; label: string; glyph: string }
> = {
  active: { tone: 'good', label: 'Active', glyph: '●' },
  trial: { tone: 'info', label: 'Trial', glyph: '◐' },
  // Dunning, and still entitled — warn, never bad (see CLAUDE.md, past_due).
  past_due: { tone: 'warn', label: 'Past due', glyph: '▲' },
  cancelled: { tone: 'bad', label: 'Cancelled', glyph: '■' },
  expired: { tone: 'neutral', label: 'Expired', glyph: '□' },
};

/** A subscription's status. */
export function StatusBadge({ status }: { status: SubscriptionStatus | null }) {
  if (!status) {
    return (
      <Pill tone="neutral" glyph="○">
        No subscription
      </Pill>
    );
  }
  const style = STATUS_STYLE[status];
  return (
    <Pill tone={style.tone} glyph={style.glyph}>
      {style.label}
    </Pill>
  );
}

/** A category label — a plan code, a role, a source. Not a state. */
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
      : 'bg-surface-2 text-ink-2 border border-transparent';

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${styles}`}
    >
      {children}
    </span>
  );
}
