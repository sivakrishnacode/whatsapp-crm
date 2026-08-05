import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`border-ring bg-surface rounded-xl border ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
      <div>
        <h2 className="text-ink text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="text-muted mt-1 max-w-2xl text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-muted px-5 py-8 text-center text-sm">{children}</p>;
}

/**
 * The one-line caveat that belongs under a derived figure. Used wherever a
 * number is computed from plan prices rather than read from a payment record —
 * see lib/queries/sql.ts for why that distinction exists.
 */
export function DerivedNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted border-line mt-4 border-t pt-3 text-xs leading-relaxed">
      {children}
    </p>
  );
}
