import type { ReactNode } from 'react';

/** Label/value pairs — the read-only counterpart to a form. */
export function Facts({
  items,
}: {
  items: { label: string; value: ReactNode; hint?: ReactNode }[];
}) {
  return (
    <dl className="divide-line divide-y">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 first:pt-0 last:pb-0"
        >
          <dt className="text-muted text-xs">{item.label}</dt>
          <dd className="text-ink-2 min-w-0 text-right text-sm break-words">
            {item.value}
            {item.hint ? (
              <span className="text-muted block text-xs">{item.hint}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
