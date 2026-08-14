"use client"

/**
 * The composer — the one place the user says what they want.
 *
 * A Beautiful UI primitive (https://www.beautifului.dev), rebuilt on
 * this app's tokens.
 *
 * Enter submits and Shift+Enter adds a line, which is the convention
 * every chat surface in this product already uses. The textarea grows
 * with its content up to a cap rather than scrolling from line two — a
 * three-sentence description is the normal case here, not the long tail.
 */

import { useEffect, useRef, type KeyboardEvent } from "react"
import { ArrowUp, Loader2, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

const MAX_HEIGHT = 200

export function PromptBar({
  value,
  onChange,
  onSubmit,
  busy = false,
  disabled = false,
  placeholder = "Describe what should happen automatically…",
  hint,
  maxLength,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  busy?: boolean
  disabled?: boolean
  placeholder?: string
  hint?: string
  maxLength?: number
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const canSubmit = value.trim().length > 0 && !busy && !disabled

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (canSubmit) onSubmit()
    }
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-2 transition-colors focus-within:border-primary/50",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className="flex items-end gap-2">
        <Sparkles className="mb-2.5 ml-2 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          rows={1}
          aria-label="Describe the automation"
          className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          aria-label="Generate automation"
          className={cn(
            "mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors",
            canSubmit
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground",
          )}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>

      {hint && (
        <p className="px-2 pb-1 pt-1 text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/** Tappable example prompts. Fills the composer rather than submitting —
 *  an example is a starting point people edit, not a button. */
export function PromptSuggestions({
  suggestions,
  onPick,
  className,
}: {
  suggestions: string[]
  onPick: (suggestion: string) => void
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground"
        >
          {s}
        </button>
      ))}
    </div>
  )
}
