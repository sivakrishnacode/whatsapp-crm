import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Figures, per the stat-tile contract: label (sentence case, no colon), value,
 * optional context line.
 *
 * A tile only shows a delta when the comparison is real (a prior window the
 * source actually measured). Money tiles never do: this database keeps no
 * history of what MRR was last month, and an invented comparison is worse
 * than none.
 */

export function HeroStat({
  label,
  value,
  context,
}: {
  label: string;
  value: string;
  context?: ReactNode;
}) {
  return (
    <div>
      <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
        {label}
      </p>
      {/* Proportional figures: tabular-nums makes a large number look loose. */}
      <p className="text-ink mt-2 text-4xl leading-none font-bold tracking-tight sm:text-5xl">
        {value}
      </p>
      {context ? <p className="text-ink-2 mt-3 text-sm">{context}</p> : null}
    </div>
  );
}

export type StatTone = 'neutral' | 'good' | 'warning' | 'critical';

const MARKER: Record<StatTone, string | null> = {
  neutral: null,
  good: 'bg-good',
  warning: 'bg-warning',
  critical: 'bg-critical',
};

/**
 * A delta against a measured prior window. `better` says which direction is
 * good, because a rise in failed messages is not good news. Rendered as text
 * with a sign, so it reads without colour.
 */
export type StatDelta = {
  current: number;
  previous: number;
  better: 'up' | 'down';
  /** e.g. "vs previous 30 days" */
  label: string;
};

function DeltaLine({ delta }: { delta: StatDelta }) {
  if (delta.previous === 0) {
    return (
      <span className="text-muted">
        {delta.current === 0 ? 'no change' : 'up from 0'} {delta.label}
      </span>
    );
  }
  const change = ((delta.current - delta.previous) / delta.previous) * 100;
  // Past ten-fold, a percentage stops meaning anything ("+18225%"); say the
  // multiple instead.
  if (change >= 900) {
    const multiple = delta.current / delta.previous;
    const good = delta.better === 'up';
    return (
      <span className={good ? 'text-good-fg' : 'text-bad-fg'}>
        {multiple >= 100 ? '>100' : Math.round(multiple)}×{' '}
        <span className="text-muted">{delta.label}</span>
      </span>
    );
  }
  const rounded = Math.round(change);
  const good = rounded === 0 ? null : rounded > 0 === (delta.better === 'up');
  return (
    <span
      className={
        good === null ? 'text-muted' : good ? 'text-good-fg' : 'text-bad-fg'
      }
    >
      {rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}
      {Math.abs(rounded)}% <span className="text-muted">{delta.label}</span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  context,
  tone = 'neutral',
  href,
  delta,
}: {
  label: string;
  value: string;
  context?: ReactNode;
  tone?: StatTone;
  /** Makes the whole tile a link to the list behind the number. */
  href?: string;
  delta?: StatDelta;
}) {
  const body = (
    <>
      <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
        {label}
      </p>
      {/* Tone is a marker beside the value, never the value's colour — a
       * status hue as text either fails contrast or impersonates a series. */}
      <p className="text-ink mt-2 flex items-center gap-2 text-[26px] leading-none font-bold tracking-tight">
        {MARKER[tone] ? (
          <span
            aria-hidden
            className={`size-2.5 shrink-0 rounded-full ${MARKER[tone]}`}
          />
        ) : null}
        {value}
      </p>
      {delta ? (
        <p className="mt-2 text-xs">
          <DeltaLine delta={delta} />
        </p>
      ) : null}
      {context ? (
        <p className="text-muted mt-1.5 text-xs leading-relaxed">{context}</p>
      ) : null}
    </>
  );

  const shell =
    'border-ring bg-surface shadow-card block min-w-0 rounded-2xl border px-4 py-4';

  return href ? (
    <Link
      href={href}
      className={`${shell} hover:border-primary/40 transition-colors`}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

export function StatRow({
  children,
  columns = 4,
}: {
  children: ReactNode;
  columns?: 3 | 4 | 5 | 6;
}) {
  const cols = {
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
    5: 'md:grid-cols-3 xl:grid-cols-5',
    6: 'md:grid-cols-3 xl:grid-cols-6',
  }[columns];
  return <div className={`grid grid-cols-2 gap-3 ${cols}`}>{children}</div>;
}

/**
 * A single ratio against a limit. Severity escalates as the limit approaches.
 */
export function Meter({
  label,
  used,
  limit,
  format = (value: number) => String(value),
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (value: number) => string;
}) {
  const unlimited = limit === null || limit <= 0;
  const ratio = unlimited ? 0 : Math.min(used / limit, 1);
  const pct = Math.round(ratio * 100);

  const fill =
    ratio >= 1 ? 'bg-critical' : ratio >= 0.8 ? 'bg-warning' : 'bg-primary';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="text-muted tabular">
          {format(used)}
          {unlimited ? ' / unlimited' : ` / ${format(limit)}`}
        </span>
      </div>
      <div className="bg-surface-3 mt-1.5 h-2 overflow-hidden rounded-full">
        {unlimited ? null : (
          <div
            className={`h-full rounded-full ${fill}`}
            style={{ width: `${Math.max(pct, ratio > 0 ? 2 : 0)}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** A plain 0–100 progress bar with its number. */
export function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      {label ? (
        <div className="text-ink-2 mb-1.5 flex justify-between text-xs">
          <span>{label}</span>
          <span className="tabular font-semibold">{pct}%</span>
        </div>
      ) : null}
      <div
        className="bg-surface-3 h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="bg-good h-full rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
