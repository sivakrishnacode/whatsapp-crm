/**
 * Horizontal bar list — the form for "compare magnitude across a handful of
 * named things" (MRR per plan, per billing cycle, per payment method).
 *
 * One series, so one hue for every bar and no legend: the card title says what
 * is plotted. Bars are deliberately *not* shaded by size — a value ramp on top
 * of bar length double-encodes the same number and burns the only free channel.
 *
 * Every row carries its own value, so the list is its own table view. Hover adds
 * the share of total, which is the one thing the bars imply but don't state.
 */
export type BarRow = {
  label: string;
  value: number;
  valueLabel: string;
  meta?: string;
};

export function BarList({ rows }: { rows: BarRow[] }) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  if (rows.length === 0) {
    return <p className="text-muted text-sm">Nothing to show yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        // A zero-value row still gets a hairline of bar so the row doesn't read
        // as missing data.
        const width = max > 0 ? Math.max((row.value / max) * 100, 0.5) : 0.5;
        const share = total > 0 ? (row.value / total) * 100 : 0;

        return (
          <li key={row.label} className="group">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink-2 truncate">
                {row.label}
                {row.meta ? (
                  <span className="text-muted ml-2 text-xs">{row.meta}</span>
                ) : null}
              </span>
              <span className="text-ink tabular shrink-0 font-medium">
                {row.valueLabel}
                <span className="text-muted ml-2 hidden text-xs font-normal group-hover:inline">
                  {share.toFixed(0)}%
                </span>
              </span>
            </div>
            {/* Grows from a single baseline at the left; 4px rounded data-end,
             * square where it meets the baseline. */}
            <div className="bg-surface-2 mt-1.5 h-2 w-full overflow-hidden rounded-r-[4px]">
              <div
                className="bg-series-1 h-full rounded-r-[4px]"
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
