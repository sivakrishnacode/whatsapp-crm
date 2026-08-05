import type { ReactNode } from 'react';

/**
 * Figures, per the stat-tile contract: label (sentence case, no colon), value,
 * optional context line.
 *
 * There is no delta on the money tiles and that is deliberate — a delta needs a
 * prior value, and this database keeps no history of what MRR was last month.
 * Inventing a comparison would be worse than omitting one, so the tiles carry a
 * factual context line instead.
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
      <p className="text-muted text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      {/* Proportional figures: tabular-nums makes a large number look loose. */}
      <p className="text-ink mt-2 text-5xl leading-none font-semibold">
        {value}
      </p>
      {context ? <p className="text-ink-2 mt-3 text-sm">{context}</p> : null}
    </div>
  );
}

export function StatTile({
  label,
  value,
  context,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  context?: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
}) {
  // Tone is carried by a small marker beside the value, never by coloring the
  // value text — a status hue as text either fails contrast or impersonates a
  // series color.
  const marker: Record<typeof tone, string | null> = {
    neutral: null,
    good: 'bg-good',
    warning: 'bg-warning',
    critical: 'bg-critical',
  };

  return (
    <div className="border-ring bg-surface rounded-xl border px-4 py-3.5">
      <p className="text-muted text-xs font-medium">{label}</p>
      <p className="text-ink mt-1.5 flex items-center gap-2 text-2xl leading-none font-semibold">
        {marker[tone] ? (
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${marker[tone]}`}
          />
        ) : null}
        {value}
      </p>
      {context ? (
        <p className="text-muted mt-1.5 text-xs leading-relaxed">{context}</p>
      ) : null}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
  );
}

/**
 * A single ratio against a limit. The unfilled track is a lighter step of the
 * fill's own ramp so the state reads across the whole bar; severity escalates
 * as the limit approaches.
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
    ratio >= 1 ? 'bg-critical' : ratio >= 0.8 ? 'bg-warning' : 'bg-series-1';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="text-muted tabular">
          {format(used)}
          {unlimited ? ' / unlimited' : ` / ${format(limit)}`}
        </span>
      </div>
      <div className="bg-surface-2 mt-1.5 h-1.5 overflow-hidden rounded-full">
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
