import Link from 'next/link';
import type { ReactNode } from 'react';

import { TONE_CLASS, type Tone } from '@/components/ui/badge';

/**
 * Page-level layout primitives shared by every Control Center module.
 */

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="space-y-3">
      {back ? (
        <Link
          href={back.href}
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs font-medium"
        >
          <span aria-hidden>←</span> {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-muted mb-1 text-[11px] font-semibold tracking-wider uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-ink text-2xl leading-tight font-bold tracking-tight">
            {title}
          </h1>
          {description ? (
            <p className="text-muted mt-1.5 max-w-3xl text-sm leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

const BUTTON_STYLE = {
  primary: 'bg-primary text-white hover:bg-primary-hover border-transparent',
  secondary: 'bg-surface text-ink border-ring hover:bg-surface-2',
  ghost: 'text-ink-2 border-transparent hover:bg-surface-2',
} as const;

/** A link styled as a button — navigation, never a mutation. */
export function ButtonLink({
  href,
  children,
  variant = 'secondary',
  size = 'md',
  prefetch,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof BUTTON_STYLE;
  size?: 'sm' | 'md';
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      className={`inline-flex items-center gap-1.5 rounded-lg border font-semibold whitespace-nowrap transition ${
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'
      } ${BUTTON_STYLE[variant]}`}
    >
      {children}
    </Link>
  );
}

/**
 * A boxed note. `tone` follows the pill tones; a leading glyph carries the
 * meaning without colour.
 */
export function Callout({
  children,
  tone = 'info',
  title,
}: {
  children: ReactNode;
  tone?: Extract<Tone, 'info' | 'warn' | 'bad' | 'good' | 'neutral'>;
  title?: ReactNode;
}) {
  const glyph = { info: 'ℹ', warn: '▲', bad: '■', good: '●', neutral: '·' }[
    tone
  ];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-xs leading-relaxed ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden className="mt-px text-[11px] leading-4">
        {glyph}
      </span>
      <div className="min-w-0">
        {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/**
 * A row of mutually exclusive links — period pickers, queue filters. Links,
 * not buttons, so the choice lives in the URL: shareable, survives a reload,
 * works without JavaScript.
 */
export function Segmented({
  options,
  active,
  label,
}: {
  options: { value: string; label: string; href: string }[];
  active: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="border-ring bg-surface inline-flex flex-wrap gap-0.5 rounded-lg border p-0.5"
    >
      {options.map((option) => {
        const on = option.value === active;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={on ? 'true' : undefined}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition ${
              on ? 'bg-primary text-white' : 'text-ink-2 hover:bg-surface-2'
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A labelled value in a small grid — read-only facts in a card. */
export function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-muted text-xs">{label}</p>
      <p className="text-ink tabular mt-0.5 truncate font-semibold">{value}</p>
      {hint ? <p className="text-muted mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}

/**
 * The definition line the handoff requires on every KPI block: reporting
 * window, timezone, source and freshness — so a number is never shown
 * without saying what it counts.
 */
export function ScopeLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {children}
    </p>
  );
}
