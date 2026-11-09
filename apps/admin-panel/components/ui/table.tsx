import type { ReactNode } from 'react';

/**
 * Table primitives.
 *
 * The horizontal scroll lives on the wrapper, not the page: a wide subscriber
 * table must never make the whole layout scroll sideways.
 */

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="w-full overflow-x-auto">{children}</div>;
}

/**
 * `minWidth` is the point below which the wrapper starts scrolling instead of
 * squeezing. It is a prop because the same table markup appears both full-bleed
 * and inside a half-width dashboard card — one fixed floor would either crush
 * the wide tables or leave the narrow ones scrolling a few pixels.
 */
export function Table({
  children,
  minWidth = '42rem',
}: {
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <table className="w-full text-left text-sm" style={{ minWidth }}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="text-muted border-line bg-surface-2 border-b text-[11px] font-semibold tracking-wide uppercase">
      {children}
    </thead>
  );
}

export function TH({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 font-semibold whitespace-nowrap first:pl-5 last:pr-5 ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-line divide-y">{children}</tbody>;
}

export function TR({ children }: { children: ReactNode }) {
  return <tr className="hover:bg-surface-2 transition-colors">{children}</tr>;
}

export function TD({
  children,
  align = 'left',
  className = '',
  title,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Exact value behind a relative one ("3 h ago" → the timestamp). */
  title?: string;
}) {
  return (
    <td
      title={title}
      className={`px-4 py-3 align-middle first:pl-5 last:pr-5 ${align === 'right' ? 'text-right' : ''} ${className}`}
    >
      {children}
    </td>
  );
}
