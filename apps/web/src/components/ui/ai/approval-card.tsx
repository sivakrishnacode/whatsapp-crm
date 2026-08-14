"use client"

/**
 * Human-in-the-loop: what the assistant produced, and what happens next.
 *
 * A Beautiful UI primitive (https://www.beautifului.dev), rebuilt on
 * this app's tokens.
 *
 * WHY THIS EXISTS RATHER THAN JUST APPLYING THE RESULT
 *   The thing being approved here is an automation — configuration that
 *   will message real customers once somebody activates it. The gap
 *   between "the model produced this" and "this is in your workspace"
 *   has to be a deliberate click, and the card has to show enough for
 *   that click to mean something.
 */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function ApprovalCard({
  title,
  subtitle,
  children,
  actions,
  className,
}: {
  title: string
  subtitle?: string
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {children && <div className="px-4 py-3">{children}</div>}

      {actions && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {actions}
        </div>
      )}
    </div>
  )
}

/**
 * Something the assistant could not decide and is handing back.
 *
 * Amber, not red: an unpicked tag is an unfinished form field, not an
 * error. Red here would put a failure state on every draft that touches
 * a tag, which is most of them.
 */
export function OpenQuestions({
  items,
  title,
  className,
}: {
  items: string[]
  title: string
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5",
        className,
      )}
    >
      <p className="text-xs font-medium text-accent-amber">
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground"
          >
            <span aria-hidden>·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
