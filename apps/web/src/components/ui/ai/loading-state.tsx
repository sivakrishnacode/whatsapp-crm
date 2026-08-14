"use client"

/**
 * Pixel-grid loader with shimmer and elapsed time.
 *
 * One of the AI-native primitives from Beautiful UI
 * (https://www.beautifului.dev) — a copy-paste reference set rather than
 * a package, so the primitives live here, rebuilt on this app's tokens
 * and Tailwind setup instead of the reference site's palette.
 *
 * WHY A COUNTER AND NOT JUST A SPINNER
 *   A model call is a wait with no progress to report — nothing knows
 *   how far through it is, and a progress BAR would be inventing one.
 *   Elapsed seconds is the one honest number available, and it is the
 *   number that answers the question the user actually has ("is this
 *   stuck?"). It counts real wall time from mount.
 */

import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

const CELLS = 16

export function LoadingState({
  label = "Working",
  className,
}: {
  label?: string
  className?: string
}) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    // The clock starts in the effect, not in render: `Date.now()` during
    // render is impure and re-reads on every re-render, so the counter
    // would silently reset whenever a parent re-rendered.
    const started = Date.now()
    const id = window.setInterval(() => {
      setElapsed((Date.now() - started) / 1000)
    }, 100)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div
      className={cn("flex items-center gap-3", className)}
      role="status"
      aria-live="polite"
    >
      <div
        className="grid h-6 w-6 shrink-0 grid-cols-4 gap-[2px]"
        aria-hidden
      >
        {Array.from({ length: CELLS }, (_, i) => (
          <span
            key={i}
            className="rounded-[1px] bg-primary/70 animate-pulse"
            style={{
              // Staggered by index so the grid reads as a wave rather
              // than sixteen squares blinking in unison.
              animationDelay: `${(i % 4) * 90 + Math.floor(i / 4) * 60}ms`,
              animationDuration: "1.1s",
            }}
          />
        ))}
      </div>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {elapsed.toFixed(1)}s
      </span>
    </div>
  )
}

/**
 * Shimmering placeholder text.
 *
 * Used where the CONTENT is not known yet but its shape is — three lines
 * of a summary that is being written. Never used for a value we could
 * show: a shimmer over a number we already have is a lie about latency.
 */
export function ShimmerLines({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-muted"
          style={{
            width: `${[92, 78, 64, 84][i % 4]}%`,
            animationDelay: `${i * 140}ms`,
          }}
        />
      ))}
    </div>
  )
}
