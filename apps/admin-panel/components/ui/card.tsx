import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`border-ring bg-surface shadow-card min-w-0 rounded-2xl border ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-muted mb-1 text-[11px] font-semibold tracking-wider uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-ink text-[15px] leading-snug font-semibold">
          {title}
        </h2>
        {description ? (
          <p className="text-muted mt-1 max-w-2xl text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
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

/**
 * What an empty list says. Name what would make it non-empty — "no tickets"
 * reads as a failure, "no open tickets — new ones appear here" reads as news.
 */
export function EmptyState({
  children,
  title,
}: {
  children: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div className="px-5 py-10 text-center">
      {title ? (
        <p className="text-ink-2 text-sm font-semibold">{title}</p>
      ) : null}
      <p className="text-muted mx-auto mt-1 max-w-md text-sm leading-relaxed">
        {children}
      </p>
    </div>
  );
}

/**
 * The one-line caveat that belongs under a derived figure: where it comes
 * from, what window, what it does NOT include. The handoff requires every
 * KPI to state its definition; this is where it goes.
 */
export function DerivedNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted border-line mt-4 border-t pt-3 text-xs leading-relaxed">
      {children}
    </p>
  );
}
