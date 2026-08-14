"use client"

/**
 * Live task status — running, failed, completed — with nested detail.
 *
 * A Beautiful UI primitive (https://www.beautifului.dev), rebuilt on
 * this app's tokens.
 *
 * Used here to show what the assistant actually produced: one row per
 * step of the drafted automation, nested under the branch that owns it.
 * The `status` on a row is a fact about the DRAFT (is this step ready to
 * run, or is it waiting on something the human must pick), not a
 * simulation of work in progress.
 */

import type { ReactNode } from "react"
import { AlertTriangle, Check, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

export type TaskStatus = "running" | "ready" | "needs_input" | "failed"

export interface TaskRow {
  id: string
  label: string
  /** Right-aligned count or state word. */
  meta?: string
  status: TaskStatus
  icon?: ReactNode
  children?: TaskRow[]
}

export function TaskRows({
  rows,
  className,
}: {
  rows: TaskRow[]
  className?: string
}) {
  return (
    <ul className={cn("space-y-1", className)}>
      {rows.map((row) => (
        <TaskRowItem key={row.id} row={row} depth={0} />
      ))}
    </ul>
  )
}

function TaskRowItem({ row, depth }: { row: TaskRow; depth: number }) {
  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2",
          depth === 0 ? "bg-muted/40" : "bg-transparent",
        )}
        style={{ marginLeft: depth * 18 }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
          {row.icon ?? <StatusIcon status={row.status} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {row.label}
        </span>
        {row.meta && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              row.status === "needs_input"
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {row.meta}
          </span>
        )}
      </div>

      {row.children && row.children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {row.children.map((child) => (
            <TaskRowItem key={child.id} row={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
  if (status === "needs_input")
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
  if (status === "failed")
    return <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
  return <Check className="h-3.5 w-3.5 text-emerald-500" />
}
