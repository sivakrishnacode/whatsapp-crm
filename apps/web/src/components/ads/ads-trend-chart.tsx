'use client';

import { useMemo, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * One metric over time, as an area + line.
 *
 * SINGLE SERIES, AND THAT IS THE POINT.
 *   Spend is money and results are a count — two different scales. The
 *   obvious-looking move, one chart with a second y-axis, is the most
 *   common charting mistake there is: the crossover point where the two
 *   lines meet is an artefact of how the axes were scaled, so readers
 *   draw conclusions the data does not support. Instead this component
 *   is rendered twice side by side (small multiples), sharing an x-axis
 *   by construction and comparing shapes honestly.
 *
 *   A consequence worth stating: with one series per chart there is no
 *   legend, because the title already names the series. A legend box
 *   labelling a single line is noise.
 *
 * Inline SVG rather than recharts, matching
 * components/dashboard/conversations-chart.tsx — the dashboard's
 * established idiom. Everything is drawn in viewBox units and scaled by
 * CSS, so the geometry math stays simple as the container resizes.
 */

const VB_W = 720;
const VB_H = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 48 };

const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;

export interface AdsTrendPoint {
  date: string;
  value: number;
}

/**
 * Round an axis maximum up to something a human would choose.
 *
 * Without this the top gridline lands on 4,733 and every tick label is
 * unreadable noise. Same helper shape as the dashboard's own chart.
 */
function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalised = max / magnitude;
  const step =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

export function AdsTrendChart({
  title,
  subtitle,
  points,
  formatValue,
  /**
   * Which `--chart-N` token to paint with. The series carries identity
   * through position and the title, not through hue — so this is only
   * about keeping the two small multiples visually distinct, and any two
   * of the theme's chart steps do the job.
   */
  colorVar = '--chart-1',
  loading,
}: {
  title: string;
  subtitle?: string;
  points: AdsTrendPoint[];
  formatValue: (value: number) => string;
  colorVar?: string;
  loading?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const { maxY, ticks, areaPath, linePath, xFor, yFor } = useMemo(() => {
    const max = points.reduce((m, p) => Math.max(m, p.value), 0);
    const ceil = niceCeil(max);

    // A single point has no width to interpolate across; pin it to the
    // left edge rather than dividing by zero.
    const xStep = points.length > 1 ? PLOT_W / (points.length - 1) : 0;
    const x = (i: number) => PAD.left + i * xStep;
    const y = (v: number) => PAD.top + PLOT_H - (v / ceil) * PLOT_H;

    const line = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ');

    const area = points.length
      ? `${line} L${x(points.length - 1).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} Z`
      : '';

    return {
      maxY: ceil,
      ticks: Array.from(new Set([0, ceil / 2, ceil])),
      areaPath: area,
      linePath: line,
      xFor: x,
      yFor: y,
    };
  }, [points]);

  const gradientId = `ads-trend-${title.replace(/\W+/g, '-').toLowerCase()}`;
  const active = hover !== null ? points[hover] : null;

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </header>

      <div className="relative px-2 py-3">
        {loading ? (
          <div className="h-[180px] animate-pulse rounded-lg bg-muted/40" />
        ) : points.length === 0 ? (
          <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">
            No data for this range yet.
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              className="w-full"
              role="img"
              aria-label={`${title} over time`}
              style={{ color: `var(${colorVar})` }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Gridlines + y labels. Recessive on purpose: they are
                  reference, not data. */}
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={PAD.left}
                    x2={VB_W - PAD.right}
                    y1={yFor(tick)}
                    y2={yFor(tick)}
                    className="stroke-border"
                    strokeWidth={1}
                    strokeDasharray={tick === 0 ? undefined : '3 3'}
                  />
                  <text
                    x={PAD.left - 8}
                    y={yFor(tick) + 4}
                    textAnchor="end"
                    // Text wears text tokens, never the series colour.
                    className="fill-muted-foreground text-[10px] tabular-nums"
                  >
                    {formatValue(tick)}
                  </text>
                </g>
              ))}

              <path d={areaPath} fill={`url(#${gradientId})`} />
              <path
                d={linePath}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* Crosshair + marker for the hovered day. */}
              {hover !== null && active ? (
                <g>
                  <line
                    x1={xFor(hover)}
                    x2={xFor(hover)}
                    y1={PAD.top}
                    y2={PAD.top + PLOT_H}
                    className="stroke-muted-foreground"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={xFor(hover)}
                    cy={yFor(active.value)}
                    r={4.5}
                    fill="currentColor"
                    // 2px surface ring so the marker reads against the
                    // line and fill beneath it.
                    className="stroke-card"
                    strokeWidth={2}
                  />
                </g>
              ) : null}

              {/* First / last x labels only. A label per day collides
                  well before 30 of them. */}
              {points.length > 0 ? (
                <>
                  <text
                    x={PAD.left}
                    y={VB_H - 6}
                    textAnchor="start"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {shortDate(points[0].date)}
                  </text>
                  <text
                    x={VB_W - PAD.right}
                    y={VB_H - 6}
                    textAnchor="end"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {shortDate(points[points.length - 1].date)}
                  </text>
                </>
              ) : null}

              {/* Hit targets, deliberately wider than the marks — one
                  full-height band per day so hovering never requires
                  precision. */}
              {points.map((point, index) => {
                const bandWidth = PLOT_W / Math.max(points.length, 1);
                return (
                  <rect
                    key={point.date}
                    x={xFor(index) - bandWidth / 2}
                    y={PAD.top}
                    width={bandWidth}
                    height={PLOT_H}
                    fill="transparent"
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
            </svg>

            {/* Tooltip. Positioned in percent of the container rather
                than viewBox units, because the SVG scales and the
                tooltip does not. */}
            {active ? (
              <div
                className={cn(
                  'pointer-events-none absolute top-2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md',
                )}
                style={{
                  left: `${((xFor(hover ?? 0) / VB_W) * 100).toFixed(2)}%`,
                  transform:
                    (hover ?? 0) > points.length / 2
                      ? 'translateX(-100%)'
                      : undefined,
                }}
              >
                <p className="font-medium text-popover-foreground tabular-nums">
                  {formatValue(active.value)}
                </p>
                <p className="text-muted-foreground">{longDate(active.date)}</p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* The table view the accessibility pass asks for: the numbers are
          reachable without reading the chart. Collapsed so it does not
          compete with it. */}
      {points.length > 0 ? (
        <details className="border-t border-border px-4 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            View as table
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Date</th>
                  <th className="py-1 text-right font-medium">{title}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...points].reverse().map((point) => (
                  <tr key={point.date} className="border-t border-border/50">
                    <td className="py-1 text-muted-foreground">
                      {longDate(point.date)}
                    </td>
                    <td className="py-1 text-right text-foreground">
                      {formatValue(point.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {/* Referenced so the memo's maxY is not flagged unused; also the
          honest place to state the scale. */}
      <span className="sr-only">Maximum {formatValue(maxY)}</span>
    </section>
  );
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
