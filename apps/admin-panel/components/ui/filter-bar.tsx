import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * One filter row above everything it scopes — never a filter per card.
 *
 * A plain GET form, so the current filter is always in the URL: shareable,
 * bookmarkable, survives a reload, and works with JavaScript off. Submitting
 * drops `page`, because filtering to a smaller set while sitting on page 4 is
 * how you land on an empty table.
 */
export function FilterBar({
  action,
  children,
  hasFilters,
}: {
  action: string;
  children: ReactNode;
  hasFilters: boolean;
}) {
  return (
    <form
      method="get"
      action={action}
      className="border-ring bg-surface flex flex-wrap items-end gap-3 rounded-xl border px-4 py-3.5"
    >
      {children}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="bg-series-1 rounded-lg px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Apply
        </button>
        {hasFilters ? (
          <Link
            href={action}
            className="text-muted hover:text-ink text-sm underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

export function FilterField({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-muted mb-1.5 block text-xs font-medium">
        {label}
      </span>
      {children}
    </label>
  );
}
