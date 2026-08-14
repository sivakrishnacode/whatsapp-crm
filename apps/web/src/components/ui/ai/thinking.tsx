"use client"

/**
 * Expandable trace — what the assistant is doing, step by step.
 *
 * A Beautiful UI primitive (https://www.beautifului.dev), rebuilt on
 * this app's tokens.
 *
 * ⚠️ EVERY STEP HERE MUST BE A REAL PHASE OF REAL WORK.
 *   The temptation with a trace component is to script it: five
 *   plausible-sounding stages on timers, finishing exactly when the
 *   request happens to return. That is a progress bar for work nobody
 *   is doing, and it teaches users to trust a signal that means nothing.
 *   Callers drive these states from the actual request lifecycle, and a
 *   phase whose duration we cannot observe says so by staying `active`
 *   until the thing it describes genuinely completes.
 */

import { useState } from "react"
import { Check, ChevronDown, Circle, Loader2, X } from "lucide-react"

import { cn } from "@/lib/utils"

export type TraceState = "pending" | "active" | "done" | "failed"

export interface TraceStep {
  id: string
  label: string
  state: TraceState
  /** Shown under the label once known. */
  detail?: string
}

export function Thinking({
  steps,
  title = "Thinking",
  defaultOpen = true,
  className,
}: {
  steps: TraceStep[]
  title?: string
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const done = steps.filter((s) => s.state === "done").length

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {done}/{steps.length}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ol className="space-y-2.5 border-t border-border px-4 py-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2.5">
              <TraceIcon state={step.state} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-xs font-medium",
                    step.state === "pending"
                      ? "text-muted-foreground"
                      : "text-foreground",
                  )}
                >
                  {step.label}
                </p>
                {step.detail && (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function TraceIcon({ state }: { state: TraceState }) {
  const base = "mt-0.5 h-3.5 w-3.5 shrink-0"
  if (state === "done")
    return <Check className={cn(base, "text-emerald-500")} aria-label="done" />
  if (state === "failed")
    return <X className={cn(base, "text-red-500")} aria-label="failed" />
  if (state === "active")
    return (
      <Loader2
        className={cn(base, "animate-spin text-primary")}
        aria-label="in progress"
      />
    )
  return (
    <Circle className={cn(base, "text-muted-foreground/40")} aria-label="waiting" />
  )
}
