'use client';

/**
 * The layout primitives every tab of the form editor is built from.
 *
 * WHY THIS EXISTS
 *   The editor is `fixed inset-0` — the whole viewport — but each tab used
 *   to declare its own width and padding: `max-w-xl` on Settings and Share,
 *   `max-w-2xl` on Availability, nothing at all on the two tables, and the
 *   padding split between the tab panel and the component. On a wide screen
 *   that read as a narrow ribbon of controls pinned to the left with two
 *   thirds of the screen empty, and every tab switch moved the content.
 *
 *   So width, gutters and the screen header live HERE, once. A panel says
 *   what it contains and stops thinking about how wide it is.
 *
 * ONE WIDTH, NOT ONE PER SCREEN
 *   Every screen — and the tab bar and the title bar above them — is capped
 *   and guttered by `EDITOR_CONTAINER`. A different cap per tab is the same
 *   bug in a politer form: the left edge of the content would move when you
 *   switch tabs, and a tab would no longer line up with the screen it opens.
 *   Wide screens are filled with COLUMNS inside that cap, never by
 *   stretching one text box to 1900px.
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shared edge of the whole editor. Used by `EditorScreen` and, in
 * `forms/[id]/page.tsx`, by the title bar and the tab bar — change it in one
 * place and all three still agree.
 *
 * The cap stops at 100rem because a settings card wider than ~600px and a
 * table row wider than ~1600px are both harder to read, not easier; past
 * that the margins grow evenly on both sides, which is a margin rather than
 * the one-sided void this replaced.
 */
export const EDITOR_CONTAINER =
  'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-8';

/**
 * One tab's screen: centred content column, a header that names the screen,
 * and an optional action slot on the right of that header.
 *
 * Renders no scroll container of its own — the tab panel above it scrolls,
 * so a `sticky` footer inside a screen sticks to the viewport rather than
 * to a nested box the user cannot see the edges of.
 */
export function EditorScreen({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(EDITOR_CONTAINER, 'py-5', className)}>
      <header className="border-border/60 mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b pb-4">
        <div className="min-w-0">
          <h2 className="text-foreground text-base font-semibold">{title}</h2>
          {description && (
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      {children}
    </div>
  );
}

/**
 * A titled card. The config screens are grids of these, which is what turns
 * the recovered width into something to look at instead of empty space.
 */
export function EditorCard({
  title,
  description,
  icon: Icon,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn(
        'border-border bg-card flex flex-col overflow-hidden rounded-xl border',
        className
      )}
    >
      <div className="border-border/60 flex items-start gap-2.5 border-b px-5 py-3.5">
        {Icon && (
          <Icon className="text-muted-foreground mt-0.5 size-4 flex-shrink-0" />
        )}
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className={cn('flex flex-1 flex-col gap-4 p-5', contentClassName)}>
        {children}
      </div>
    </section>
  );
}

/** Two columns from `lg` up, one below it. `items-start` so a short card
 *  next to a tall one keeps its own height instead of stretching. */
export function EditorGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid items-start gap-4 lg:grid-cols-2', className)}>
      {children}
    </div>
  );
}

/** A label + hint on the left, a control on the right. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label
          htmlFor={htmlFor}
          className="text-foreground text-sm font-medium"
        >
          {label}
        </label>
        {hint && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {hint}
          </p>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

/**
 * The save bar for a screen that saves independently of the header's Save.
 *
 * Sticks to the bottom of the scrolling tab panel so the action is reachable
 * without scrolling to the end of a long form — and so a screen with unsaved
 * work always says so somewhere visible.
 */
export function EditorActionBar({
  children,
  note,
}: {
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="border-border/60 bg-background/85 sticky bottom-0 z-10 -mx-4 mt-5 flex flex-wrap items-center justify-end gap-3 border-t px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      {note && <p className="text-muted-foreground mr-auto text-xs">{note}</p>}
      {children}
    </div>
  );
}

/**
 * Nothing here yet.
 *
 * The FRAME spans the screen — it stands in for the table or list that will
 * be there, and a 400px dashed box adrift in a 1500px column reads as a
 * rendering fault. The COPY inside is capped, because an explanation whose
 * icon, heading and sentence sit in three different parts of the room is
 * not one message any more.
 */
export function EditorEmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-center rounded-xl border border-dashed px-6 py-16">
      <Icon className="text-muted-foreground/70 size-9" />
      <div className="mt-3 flex max-w-sm flex-col items-center gap-1 text-center">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {children && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {children}
          </p>
        )}
      </div>
    </div>
  );
}
