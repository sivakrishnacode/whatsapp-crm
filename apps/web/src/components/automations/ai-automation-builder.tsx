"use client"

/**
 * "Describe it and I'll build it."
 *
 * The AI-facing surfaces are built from the Beautiful UI primitives in
 * `components/ui/ai/*` — prompt bar, pixel-grid loader, expandable
 * thinking trace, task rows, approval card.
 *
 * ⚠️ THE TRACE IS DRIVEN BY THE REQUEST, NOT BY A TIMER.
 *   There are exactly two phases we can observe from here: the request
 *   is in flight, and the request came back. So that is what the trace
 *   shows — one active step while we wait, and REAL facts once the draft
 *   lands (which trigger it chose, how many steps, what it could not
 *   decide). Scripting five plausible stages on setTimeout would look
 *   better and mean nothing.
 *
 * ⚠️ NOTHING IS SAVED HERE.
 *   The draft goes to the builder through sessionStorage and the author
 *   presses save there, against the same validation every other
 *   automation gets.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowRight,
  Bot,
  GitBranch,
  Hourglass,
  MessageSquare,
  RefreshCw,
  Zap,
} from "lucide-react"

import { AiCreditsSheet } from "@/components/ai/ai-credits-sheet"
import { Button } from "@/components/ui/button"
import { ApprovalCard, OpenQuestions } from "@/components/ui/ai/approval-card"
import { LoadingState } from "@/components/ui/ai/loading-state"
import { PromptBar, PromptSuggestions } from "@/components/ui/ai/prompt-bar"
import { TaskRows, type TaskRow } from "@/components/ui/ai/task-rows"
import { Thinking, type TraceStep } from "@/components/ui/ai/thinking"
import { useAiCredits } from "@/hooks/use-ai-credits"
import {
  flattenDraftSteps,
  stashDraft,
  type AiDraft,
  type AiDraftResponse,
  type AiDraftStep,
} from "@/lib/automations/ai-draft"
import { STEP_META, summarizeStep } from "@/lib/automations/step-meta"
import { triggerMeta } from "@/lib/automations/trigger-meta"
import type { AutomationStepType } from "@/types"

const MAX_PROMPT = 2000

const SUGGESTIONS = [
  "Greet first-time WhatsApp customers, then tag them as a new lead",
  "If someone asks about pricing, send our three plans and alert sales",
  "When a message mentions refund or cancel, notify the team and flag the thread",
  "Reply outside 9–6 saying we'll be back in the morning",
  "Wait a day after a booking, then ask if they still want the slot",
]

type Phase = "idle" | "generating" | "done" | "error"

export function AiAutomationBuilder() {
  const router = useRouter()
  const { setBalance } = useAiCredits()
  const [prompt, setPrompt] = useState("")
  const [phase, setPhase] = useState<Phase>("idle")
  const [result, setResult] = useState<AiDraftResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The prompt the current result was generated from. */
  const [answeredPrompt, setAnsweredPrompt] = useState("")
  const [creditsOpen, setCreditsOpen] = useState(false)

  async function generate(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    setPhase("generating")
    setError(null)
    setResult(null)
    setAnsweredPrompt(trimmed)

    try {
      const res = await fetch("/api/ai/automation-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        const message =
          body?.error ?? `The AI could not build that (${res.status}).`
        setError(message)
        setPhase("error")
        // An exhausted wallet has a next action, so it gets a toast that
        // points at it rather than another red box the user cannot use.
        if (body?.code === "ai_credits_exhausted") {
          toast.error("Out of AI credits.", {
            description:
              "Top up to keep building, or switch the agent to your own provider key.",
            action: { label: "Top up", onClick: () => setCreditsOpen(true) },
          })
        }
        return
      }

      setResult(body as AiDraftResponse)
      setPhase("done")
      // The response carries the post-charge balance, so the header badge
      // settles immediately instead of rendering a stale number until a
      // refetch lands. Absent on a bring-your-own-key run, which cost
      // no credits and must not move the badge at all.
      if (typeof body?.credits_remaining === "number") {
        setBalance(body.credits_remaining)
      }
    } catch {
      setError("Could not reach the server. Check your connection and retry.")
      setPhase("error")
    }
  }

  function openInBuilder(draft: AiDraft) {
    const id = stashDraft(draft)
    router.push(`/automations/new?draft=${id}`)
  }

  const trace = buildTrace(phase, result?.draft ?? null, answeredPrompt)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PromptBar
        value={prompt}
        onChange={setPrompt}
        onSubmit={() => generate(prompt)}
        busy={phase === "generating"}
        maxLength={MAX_PROMPT}
        placeholder="e.g. When someone messages us for the first time on WhatsApp, say hello and tag them as a new lead"
        hint="Enter to generate · Shift+Enter for a new line. Nothing is saved until you review it."
      />

      {phase === "idle" && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Or start from one of these
          </p>
          <PromptSuggestions suggestions={SUGGESTIONS} onPick={setPrompt} />
        </div>
      )}

      {phase === "generating" && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <LoadingState label="Designing your automation" />
          </div>
          <Thinking steps={trace} />
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-3">
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
            <p className="text-sm font-medium text-red-500">
              That did not work
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {error}
            </p>
          </div>
          <Button variant="outline" onClick={() => generate(answeredPrompt)}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      )}

      {phase === "done" && result && (
        <div className="space-y-3">
          <Thinking steps={trace} title="How it was built" defaultOpen={false} />
          <DraftReview
            response={result}
            onOpen={() => openInBuilder(result.draft)}
            onRetry={() => generate(answeredPrompt)}
          />
        </div>
      )}

      <AiCreditsSheet open={creditsOpen} onOpenChange={setCreditsOpen} />
    </div>
  )
}

/**
 * The trace, from what we can actually observe.
 *
 * Two phases while in flight; after that every line carries a real fact
 * read off the draft. Nothing here is on a timer.
 */
function buildTrace(
  phase: Phase,
  draft: AiDraft | null,
  prompt: string,
): TraceStep[] {
  const read: TraceStep = {
    id: "read",
    label: "Read your description",
    state: phase === "idle" ? "pending" : "done",
    detail: prompt ? truncate(prompt, 120) : undefined,
  }

  if (phase === "generating") {
    return [
      read,
      {
        id: "design",
        label: "Choosing a trigger and composing the steps",
        state: "active",
      },
      { id: "check", label: "Checking it against this product", state: "pending" },
    ]
  }

  if (phase === "error") {
    return [
      read,
      { id: "design", label: "Composing the steps", state: "failed" },
    ]
  }

  if (!draft) return [read]

  const steps = flattenDraftSteps(draft.steps)
  return [
    read,
    {
      id: "design",
      label: "Chose a trigger",
      state: "done",
      detail: triggerMeta(draft.trigger_type, draft.trigger_config).label,
    },
    {
      id: "steps",
      label: `Composed ${steps.length} step${steps.length === 1 ? "" : "s"}`,
      state: "done",
      detail:
        steps.length > 0
          ? steps
              .map((s) => STEP_META[s.step_type as AutomationStepType]?.label ?? s.step_type)
              .join(" → ")
          : "Nothing it could build from that description.",
    },
    {
      id: "check",
      label: "Checked against this product",
      state: "done",
      detail:
        draft.needs.length > 0
          ? `${draft.needs.length} thing${draft.needs.length === 1 ? "" : "s"} left for you to pick.`
          : "Every step is ready to run.",
    },
  ]
}

function DraftReview({
  response,
  onOpen,
  onRetry,
}: {
  response: AiDraftResponse
  onOpen: () => void
  onRetry: () => void
}) {
  const { draft, credits_used: creditsUsed } = response
  const meta = triggerMeta(draft.trigger_type, draft.trigger_config)
  const empty = draft.steps.length === 0

  return (
    <ApprovalCard
      title={draft.name}
      subtitle={draft.description || undefined}
      actions={
        <>
          <Button onClick={onOpen} disabled={empty}>
            Open in builder
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            Regenerate
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {typeof creditsUsed === "number"
              ? `${creditsUsed} credit${creditsUsed === 1 ? "" : "s"} · nothing saved yet`
              : "Nothing saved yet"}
          </span>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Zap className="h-3.5 w-3.5" />
          </span>
          <span className="text-xs font-medium text-foreground">
            Runs on: {meta.label}
          </span>
          {draft.channels.length > 0 && (
            <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
              {draft.channels.join(" + ")}
            </span>
          )}
        </div>

        {empty ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            It could not turn that into an automation. Try describing the
            trigger (&ldquo;when someone messages us…&rdquo;) and what should
            happen next.
          </p>
        ) : (
          <TaskRows rows={draft.steps.map((s, i) => toTaskRow(s, `s${i}`))} />
        )}

        {draft.needs.length > 0 && (
          <OpenQuestions
            title="You'll need to pick these in the builder"
            items={draft.needs}
          />
        )}

        {draft.notes.length > 0 && (
          <ul className="space-y-1">
            {draft.notes.map((note) => (
              <li
                key={note}
                className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground"
              >
                <Bot className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ApprovalCard>
  )
}

const ROW_ICON: Partial<Record<string, typeof MessageSquare>> = {
  condition: GitBranch,
  random_split: GitBranch,
  wait: Hourglass,
  wait_until: Hourglass,
}

/**
 * A draft step as a task row.
 *
 * `needs_input` is the honest status for a step whose config still has a
 * blank id: it is not broken and it is not ready, and calling it either
 * would mislead. The meta column says which.
 */
function toTaskRow(step: AiDraftStep, id: string): TaskRow {
  const type = step.step_type as AutomationStepType
  const meta = STEP_META[type]
  const blanks = blankIdKeys(step.step_config)
  const Icon = ROW_ICON[step.step_type]

  return {
    id,
    label: meta?.label ?? step.step_type,
    meta:
      blanks.length > 0
        ? `pick ${blanks.join(", ")}`
        : (summarizeStep(type, step.step_config) ?? undefined),
    status: blanks.length > 0 ? "needs_input" : "ready",
    icon: Icon ? <Icon className="h-3.5 w-3.5 text-muted-foreground" /> : undefined,
    children: step.branches
      ? [
          ...step.branches.yes.map((child, i) => toTaskRow(child, `${id}y${i}`)),
          ...step.branches.no.map((child, i) => toTaskRow(child, `${id}n${i}`)),
        ]
      : undefined,
  }
}

/** Config keys the server blanked because only the workspace knows them. */
function blankIdKeys(config: Record<string, unknown>): string[] {
  const labels: Record<string, string> = {
    tag_id: "a tag",
    segment_id: "a segment",
    pipeline_id: "a pipeline",
    stage_id: "a stage",
  }
  return Object.entries(labels)
    .filter(([key]) => key in config && config[key] === "")
    .map(([, label]) => label)
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
