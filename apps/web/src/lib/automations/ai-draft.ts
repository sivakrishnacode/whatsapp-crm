/**
 * The AI draft, and how it reaches the builder.
 *
 * WHY sessionStorage AND NOT A ROW, OR THE URL
 *   A draft is an automation-shaped object with a dozen nested configs.
 *   The URL cannot carry it. Writing it to the database first WOULD work
 *   and is exactly what must not happen: the whole point of the approval
 *   step is that nothing exists in the workspace until a human presses
 *   save, and a draft row that someone abandons is a half-built
 *   automation sitting in their list. sessionStorage is per-tab and dies
 *   with the tab, which is the correct lifetime for a handoff between
 *   two routes.
 *
 *   It is read ONCE and removed (`takeDraft`). Leaving it behind means a
 *   refresh of /automations/new silently re-seeds a draft the author has
 *   since edited, throwing away their work.
 */

import { blankStep, type BuilderStep } from '@/lib/automations/graph'
import type { AutomationStepType, AutomationTriggerType } from '@/types'

export interface AiDraftStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: AiDraftStep[]; no: AiDraftStep[] }
}

export interface AiDraft {
  name: string
  description: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  channels: string[]
  steps: AiDraftStep[]
  /** Caveats and assumptions the model recorded. */
  notes: string[]
  /** Ids the author still has to choose. */
  needs: string[]
}

export interface AiDraftResponse {
  draft: AiDraft
  /** Absent on a bring-your-own-key run — that call cost no credits. */
  credits_used?: number
  credits_remaining?: number
}

const KEY_PREFIX = 'automation-ai-draft:'

/** Stash a draft for the builder to pick up, returning its handoff id. */
export function stashDraft(draft: AiDraft): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    sessionStorage.setItem(KEY_PREFIX + id, JSON.stringify(draft))
  } catch {
    // Private-mode Safari and a full quota both throw here. The caller
    // navigates either way and the builder opens blank rather than
    // crashing — worse than the happy path, better than a dead button.
  }
  return id
}

/** Read a stashed draft and remove it. Returns null if it is not there. */
export function takeDraft(id: string | null): AiDraft | null {
  if (!id) return null
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + id)
    if (!raw) return null
    sessionStorage.removeItem(KEY_PREFIX + id)
    return JSON.parse(raw) as AiDraft
  } catch {
    return null
  }
}

/**
 * Draft tree → builder tree.
 *
 * Keys are minted here rather than by the model: they are the canvas
 * node ids AND the `{{ steps.<key>.… }}` token paths, and `uniqueStepKey`
 * is the only thing that guarantees they are unique and sanitised across
 * the whole tree (see the note on `blankStep`).
 */
export function draftStepsToBuilderSteps(
  steps: AiDraftStep[],
  taken: Set<string> = new Set(),
): BuilderStep[] {
  return steps.map((step) => {
    const type = step.step_type as AutomationStepType
    const node = blankStep(type, taken, step.step_config)
    taken.add(node.key)
    if (step.branches && node.branches) {
      node.branches = {
        yes: draftStepsToBuilderSteps(step.branches.yes ?? [], taken),
        no: draftStepsToBuilderSteps(step.branches.no ?? [], taken),
      }
    }
    return node
  })
}

export interface DraftBuilderSeed {
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  channels: string[]
  is_active: boolean
  steps: BuilderStep[]
}

export function draftToBuilderSeed(draft: AiDraft): DraftBuilderSeed {
  return {
    name: draft.name,
    description: draft.description,
    trigger_type: draft.trigger_type as AutomationTriggerType,
    trigger_config: draft.trigger_config ?? {},
    channels: draft.channels ?? [],
    // NEVER active. A generated automation that arrives switched on is a
    // model with a send button.
    is_active: false,
    steps: draftStepsToBuilderSteps(draft.steps ?? []),
  }
}

/** Every step in the tree, flattened — for counting and summarising. */
export function flattenDraftSteps(steps: AiDraftStep[]): AiDraftStep[] {
  return steps.flatMap((s) => [
    s,
    ...flattenDraftSteps(s.branches?.yes ?? []),
    ...flattenDraftSteps(s.branches?.no ?? []),
  ])
}
