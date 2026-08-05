'use client';

import { useState } from 'react';

/**
 * Subscriptions gained and lost per month, as a diverging column chart.
 *
 * Why this form: the data's job is polarity — additions against losses on one
 * common measure (a count of subscriptions). Diverging columns off a single zero
 * baseline show the net at a glance; a grouped pair of bars makes the reader do
 * the subtraction, and two y-scales would be a lie.
 *
 * The two hues are the validated diverging pair (blue ↔ red — warm/cool, so they
 * read as opposite) with the zero rule as the neutral midpoint. Both series are
 * in the legend, hover and focus expose exact values, and the table twin below
 * carries every number for anyone the color doesn't reach.
 *
 * Counts, not money: see lib/queries/sql.ts — historical revenue isn't
 * recoverable from this schema, so this chart never claims to show it.
 */
export type MovementPoint = {
  /** Pre-formatted for display; the server owns date formatting. */
  label: string;
  started: number;
  churned: number;
  startedMrr: string;
};

export function MovementChart({ points }: { points: MovementPoint[] }) {
  const [active, setActive] = useState<number | null>(null);

  const max = Math.max(
    ...points.map((point) => Math.max(point.started, point.churned)),
    1
  );

  if (points.every((point) => point.started === 0 && point.churned === 0)) {
    return (
      <p className="text-muted text-sm">
        No subscriptions started or ended in this window.
      </p>
    );
  }

  const current = active === null ? null : points[active];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs">
        <span className="text-ink-2 inline-flex items-center gap-1.5">
          <span aria-hidden className="bg-series-1 size-2 rounded-full" />
          Started
        </span>
        <span className="text-ink-2 inline-flex items-center gap-1.5">
          <span aria-hidden className="bg-series-2 size-2 rounded-full" />
          Cancelled or expired
        </span>
        <span className="text-muted tabular ml-auto">peak {max} / month</span>
      </div>

      <div className="relative">
        {/* Tooltip. Reserved space above the plot rather than an overlay, so it
         * never covers the columns it describes and never shifts the layout. */}
        <div className="mb-2 h-9">
          {current ? (
            <div className="border-ring bg-surface inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-xs">
              <span className="text-ink font-medium">{current.label}</span>
              <span className="text-ink-2">
                <span
                  aria-hidden
                  className="bg-series-1 mr-1.5 inline-block size-2 rounded-full align-middle"
                />
                {current.started} started
                {current.started > 0 ? ` · ${current.startedMrr}/mo` : ''}
              </span>
              <span className="text-ink-2">
                <span
                  aria-hidden
                  className="bg-series-2 mr-1.5 inline-block size-2 rounded-full align-middle"
                />
                {current.churned} ended
              </span>
            </div>
          ) : (
            <p className="text-muted text-xs">
              Hover or focus a month for exact figures.
            </p>
          )}
        </div>

        {/* Fixed plot height, with the axis band sized separately below — a
         * container that only fits the plot pushes the month labels into a
         * nested scrollbar. */}
        <div className="relative flex items-stretch gap-[2px]">
          {/* One continuous hairline for the zero baseline. Drawn once across
           * the plot rather than per column: the 2px column gaps would break a
           * per-column rule into dashes, and a dashed axis reads as a threshold
           * or a projection when it is just the zero line. Rendered first so the
           * bars paint over it. */}
          <span
            aria-hidden
            className="bg-line absolute inset-x-0 top-20 h-px"
          />
          {points.map((point, index) => {
            const upPct = (point.started / max) * 100;
            const downPct = (point.churned / max) * 100;
            const isActive = active === index;

            return (
              <div
                key={point.label}
                className="group flex-1"
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <button
                  type="button"
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  aria-label={`${point.label}: ${point.started} started, ${point.churned} cancelled or expired`}
                  className="block w-full cursor-default"
                >
                  {/* Additions: grow up from the zero rule. */}
                  <span className="flex h-20 w-full items-end justify-center">
                    <span
                      className="bg-series-1 block w-full max-w-6 rounded-t-[4px]"
                      style={{
                        height: `${Math.max(upPct, point.started > 0 ? 3 : 0)}%`,
                      }}
                    />
                  </span>

                  {/* Losses: grow down from the same rule. */}
                  <span className="flex h-20 w-full items-start justify-center">
                    <span
                      className="bg-series-2 block w-full max-w-6 rounded-b-[4px]"
                      style={{
                        height: `${Math.max(downPct, point.churned > 0 ? 3 : 0)}%`,
                      }}
                    />
                  </span>

                  <span
                    className={`mt-2 block truncate text-center text-[10px] ${isActive ? 'text-ink' : 'text-muted'}`}
                  >
                    {point.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <details className="mt-4">
        <summary className="text-muted hover:text-ink cursor-pointer text-xs">
          Show as table
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-line border-b">
              <tr>
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  Month
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  Started
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  Ended
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  Net
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  MRR of new
                </th>
              </tr>
            </thead>
            <tbody className="divide-line text-ink-2 divide-y">
              {points.map((point) => (
                <tr key={point.label}>
                  <td className="py-1.5 pr-4">{point.label}</td>
                  <td className="py-1.5 pr-4 text-right">{point.started}</td>
                  <td className="py-1.5 pr-4 text-right">{point.churned}</td>
                  <td className="py-1.5 pr-4 text-right">
                    {point.started - point.churned > 0 ? '+' : ''}
                    {point.started - point.churned}
                  </td>
                  <td className="py-1.5 text-right">{point.startedMrr}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
