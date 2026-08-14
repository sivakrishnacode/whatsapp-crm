/**
 * Template seeds → the builder's nested tree.
 *
 * Seeds are stored FLAT with `parent_index` pointers because that is the
 * readable way to write one by hand; the builder wants a tree. This is
 * the one place that conversion happens.
 *
 * ⚠️ EVERY MINTED KEY MUST BE ADDED TO `taken`.
 *   `blankStep` asks for a free key but does not claim it — that is the
 *   caller's job (see `fromServerSteps` and `duplicateStep`, which both
 *   do it). Forgetting means two steps of the same type in one template
 *   both get the key `send_message`, and a key is the React Flow node id
 *   AND the `{{ steps.<key>.… }}` token path: duplicates give you a
 *   canvas that drops a node and a token that reads the wrong step.
 *   Pinned by `template-expand.test.ts`.
 */

import { blankStep, type BuilderStep } from '@/lib/automations/graph'
import type { AutomationTemplateDefinition } from '@/lib/automations/templates'
import type { AutomationStepType } from '@/types'

export interface SeedRow {
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branch: 'yes' | 'no' | null
  parent_index: number | null
}

export function expandFromSeeds(rows: SeedRow[]): BuilderStep[] {
  // ONE shared set, not one per scope: keys must be unique across the
  // whole tree, because that is what a token path addresses.
  const taken = new Set<string>()
  const nodes: BuilderStep[] = rows.map((r) => {
    const node = blankStep(r.step_type, taken, r.step_config)
    taken.add(node.key)
    return node
  })

  const roots: BuilderStep[] = []
  rows.forEach((r, i) => {
    if (r.parent_index == null || !nodes[r.parent_index]) {
      roots.push(nodes[i])
      return
    }
    const parent = nodes[r.parent_index]
    if (!parent.branches) parent.branches = { yes: [], no: [] }
    parent.branches[r.branch ?? 'yes'].push(nodes[i])
  })
  return roots
}

export interface TemplateBuilderSeed {
  name: string
  description: string
  trigger_type: AutomationTemplateDefinition['trigger_type']
  trigger_config: Record<string, unknown>
  channels: string[]
  is_active: boolean
  steps: BuilderStep[]
}

export function templateToBuilderSeed(
  template: AutomationTemplateDefinition,
): TemplateBuilderSeed {
  return {
    name: template.name,
    description: template.description,
    trigger_type: template.trigger_type,
    trigger_config: template.trigger_config as Record<string, unknown>,
    // Templates that only work on one channel say so. An Instagram
    // comment automation scoped to every channel is a rule that can
    // never fire on two of them.
    channels: template.channels ?? [],
    // A template opens as a DRAFT. Everything else in this product
    // requires a deliberate activation, and half of these need a tag or
    // a connection picked before they would do anything anyway.
    is_active: false,
    steps: expandFromSeeds(
      template.steps.map((seed) => ({
        step_type: seed.step_type,
        step_config: seed.step_config as Record<string, unknown>,
        branch: seed.branch ?? null,
        parent_index: seed.parent_index ?? null,
      })),
    ),
  }
}
