/**
 * Daily (or any ordered) volume as vertical bars, optionally stacked.
 *
 * Server-rendered HTML, no chart library and no JavaScript — the same choice
 * as the rest of this panel's charts. Every bar carries a `title` with its
 * exact values, and the whole chart has a visually hidden table twin so the
 * numbers are reachable without hovering or seeing.
 *
 * Stacks are drawn bottom-up in series order. Use the second series for the
 * part of the whole that is bad news (failed within outbound): it gets the
 * diverging hue and the legend names it.
 */

export type TrendSeries = {
  key: string;
  label: string;
  /** 'primary' for the main series, 'alert' for the bad-news part. */
  tone: 'primary' | 'alert' | 'muted';
};

export type TrendPoint = {
  /** Axis label, e.g. "Mon 3". */
  label: string;
  values: Record<string, number>;
};

const TONE_BG: Record<TrendSeries['tone'], string> = {
  primary: 'bg-series-1',
  alert: 'bg-series-2',
  muted: 'bg-rule',
};

export function TrendBars({
  series,
  points,
  caption,
  height = 160,
  format = (value: number) => value.toLocaleString('en-IN'),
}: {
  series: TrendSeries[];
  points: TrendPoint[];
  caption: string;
  height?: number;
  format?: (value: number) => string;
}) {
  const totals = points.map((point) =>
    series.reduce((sum, s) => sum + (point.values[s.key] ?? 0), 0)
  );
  const max = Math.max(...totals, 0);
  // Label every bar when there is room, otherwise every Nth so labels never
  // collide; the hidden table still names every point.
  const step = points.length > 16 ? Math.ceil(points.length / 8) : 1;

  return (
    <figure className="min-w-0">
      {series.length > 1 ? (
        <div className="text-muted mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={`size-2.5 rounded-sm ${TONE_BG[s.tone]}`}
              />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}

      {max === 0 ? (
        <div
          className="border-line text-muted grid place-items-center border-b text-xs"
          style={{ height }}
        >
          No activity in this window.
        </div>
      ) : (
        <div
          aria-hidden
          className="border-rule flex items-end gap-[3px] border-b"
          style={{ height }}
        >
          {points.map((point, index) => {
            const total = totals[index]!;
            const title = `${point.label}: ${series
              .map((s) => `${s.label} ${format(point.values[s.key] ?? 0)}`)
              .join(', ')}`;
            return (
              <div
                key={`${point.label}-${index}`}
                title={title}
                className="flex h-full min-w-0 flex-1 flex-col-reverse"
              >
                {total === 0 ? (
                  <div className="bg-surface-3 h-px w-full" />
                ) : (
                  series.map((s) => {
                    const value = point.values[s.key] ?? 0;
                    if (value === 0) return null;
                    // flex-col-reverse: the LAST element child is the top of
                    // the stack, so only it gets the rounded data-end.
                    return (
                      <div
                        key={s.key}
                        className={`w-full ${TONE_BG[s.tone]} last:rounded-t-[3px] hover:opacity-80`}
                        style={{ height: `${(value / max) * 100}%` }}
                      />
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      <div aria-hidden className="text-muted mt-1.5 flex gap-[3px] text-[10px]">
        {points.map((point, index) => (
          <span
            key={`${point.label}-${index}`}
            className="min-w-0 flex-1 truncate text-center"
          >
            {index % step === 0 ? point.label : ''}
          </span>
        ))}
      </div>

      <figcaption className="sr-only">{caption}</figcaption>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Point</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.label}-${index}`}>
              <th scope="row">{point.label}</th>
              {series.map((s) => (
                <td key={s.key}>{format(point.values[s.key] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
