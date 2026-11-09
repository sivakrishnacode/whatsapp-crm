/**
 * An ordered funnel: each step's count, its share of the first step, and the
 * step-to-step conversion. Horizontal bars from one baseline so lengths
 * compare directly.
 *
 * The denominator is stated, not implied — "of 42 workspaces created in the
 * last 30 days" — because a funnel percentage without its base is the number
 * people most often misread.
 */

export type FunnelStep = {
  label: string;
  count: number;
  hint?: string;
};

export function Funnel({
  steps,
  denominatorLabel,
}: {
  steps: FunnelStep[];
  denominatorLabel: string;
}) {
  const base = steps[0]?.count ?? 0;

  return (
    <div>
      <ol className="space-y-3">
        {steps.map((step, index) => {
          const share = base > 0 ? (step.count / base) * 100 : 0;
          const previous = index > 0 ? steps[index - 1]!.count : null;
          const conversion =
            previous && previous > 0 ? (step.count / previous) * 100 : null;
          return (
            <li key={step.label}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-ink-2 min-w-0 truncate">
                  <span className="text-muted tabular mr-2 text-xs">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {step.label}
                  {step.hint ? (
                    <span className="text-muted ml-2 text-xs">{step.hint}</span>
                  ) : null}
                </span>
                <span className="tabular shrink-0 text-right">
                  <span className="text-ink font-semibold">
                    {step.count.toLocaleString('en-IN')}
                  </span>
                  <span className="text-muted ml-2 text-xs">
                    {base > 0 ? `${share.toFixed(0)}%` : '—'}
                  </span>
                </span>
              </div>
              <div className="bg-surface-3 mt-1.5 h-2.5 overflow-hidden rounded-r">
                <div
                  className="bg-series-1 h-full rounded-r"
                  style={{
                    width: `${Math.max(share, step.count > 0 ? 1 : 0)}%`,
                  }}
                />
              </div>
              {conversion !== null ? (
                <p className="text-muted mt-1 text-[11px]">
                  {conversion.toFixed(0)}% of the previous step
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="text-muted mt-4 text-xs">
        Percentages are of {denominatorLabel}.
      </p>
    </div>
  );
}
