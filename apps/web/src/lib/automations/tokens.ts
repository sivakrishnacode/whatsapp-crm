/**
 * "Available data" — what a given step is allowed to reference.
 *
 * This is the editor half of the expression engine in
 * apps/api/src/automations/services/automation-interpolation.util.ts.
 * The engine resolves an unknown token to an EMPTY STRING rather than
 * leaving it visible, which is right for a customer-facing message and
 * terrible for authoring: a typo produces silence, not an error. The
 * picker exists so the common case is never typed by hand.
 *
 * ONLY WHAT COULD ACTUALLY HAVE RUN
 *   A step in the `no` branch can never read a step from the `yes`
 *   branch — they are mutually exclusive. Offering those tokens would be
 *   offering a guaranteed empty string. Steps in an earlier branch that
 *   MIGHT not have run are offered, marked conditional: they resolve
 *   when that branch was taken, which is a judgement the author is
 *   making on purpose.
 */

import { STEP_META } from '@/lib/automations/step-meta';
import { flattenSteps, type BuilderStep } from '@/lib/automations/graph';
import type { AutomationTriggerType } from '@/types';

export interface TokenOption {
  /** What gets inserted, without the braces. */
  path: string;
  label: string;
  /** Short hint under the label. */
  hint?: string;
  /** Only resolves if a branch was taken. */
  conditional?: boolean;
}

export interface TokenGroup {
  id: string;
  label: string;
  options: TokenOption[];
}

/** Always available, whatever the trigger. */
const CONTACT_TOKENS: TokenOption[] = [
  { path: 'contact.name', label: 'Name' },
  { path: 'contact.phone', label: 'Phone' },
  { path: 'contact.email', label: 'Email' },
  { path: 'contact.company', label: 'Company' },
];

const CLOCK_TOKENS: TokenOption[] = [
  { path: 'now.iso', label: 'Now (ISO 8601, UTC)' },
  { path: 'now.date', label: 'Today (YYYY-MM-DD)' },
  { path: 'now.time', label: 'Time (HH:mm:ss)' },
  { path: 'now.timestamp', label: 'Unix timestamp' },
];

/**
 * Trigger tokens.
 *
 * Narrowed by trigger type: offering `{{ trigger.form_id }}` on a
 * keyword automation is offering an empty string, and a picker that
 * lists impossible options teaches people not to trust it.
 */
function triggerTokens(trigger: AutomationTriggerType): TokenOption[] {
  const base: TokenOption[] = [
    { path: 'trigger.channel', label: 'Channel', hint: 'whatsapp · instagram · web' },
    { path: 'conversation.id', label: 'Conversation id' },
  ];

  const messageish: TokenOption[] = [
    { path: 'message.text', label: 'Message text', hint: 'What the contact wrote' },
  ];

  switch (trigger) {
    case 'form_submitted':
      return [
        ...base,
        { path: 'trigger.form_id', label: 'Form id' },
        { path: 'trigger.submission_id', label: 'Submission id' },
        {
          path: 'form.<field_key>',
          label: 'A form answer',
          hint: 'Replace <field_key> with the field’s key',
        },
      ];
    case 'appointment_booked':
    case 'appointment_cancelled':
    case 'appointment_rescheduled':
      return [
        ...base,
        { path: 'trigger.appointment_id', label: 'Appointment id' },
        { path: 'trigger.appointment_type_id', label: 'Appointment type id' },
      ];
    case 'tag_added':
      return [...base, { path: 'trigger.tag_id', label: 'Tag that was added' }];
    case 'conversation_assigned':
      return [...base, { path: 'trigger.agent_id', label: 'Assigned agent id' }];
    case 'instagram_comment':
      return [
        ...base,
        ...messageish,
        { path: 'trigger.ig_comment_id', label: 'Instagram comment id' },
        { path: 'trigger.ig_media_id', label: 'Instagram post id' },
      ];
    case 'time_based':
      // No message, no conversation — a scheduled run has neither.
      return [{ path: 'trigger.channel', label: 'Channel' }];
    default:
      return [...base, ...messageish];
  }
}

/**
 * Steps whose output `targetKey` can read, in execution order.
 *
 * Walks the tree keeping only what precedes the target on its own path:
 * earlier siblings at every level, plus the branch the target lives in.
 * The opposite branch of any ancestor is dropped — it cannot have run.
 */
export function precedingSteps(
  steps: BuilderStep[],
  targetKey: string,
): { step: BuilderStep; conditional: boolean }[] {
  const out: { step: BuilderStep; conditional: boolean }[] = [];

  const walk = (
    list: BuilderStep[],
    conditional: boolean,
  ): boolean /* found */ => {
    for (const step of list) {
      if (step.key === targetKey) return true;

      if (step.branches) {
        // Is the target inside one of this step's branches? If so, only
        // that branch's earlier steps are reachable, and the other
        // branch is unreachable by definition.
        for (const branch of ['yes', 'no'] as const) {
          const inThisBranch = flattenSteps(step.branches[branch]).some(
            (f) => f.step.key === targetKey,
          );
          if (inThisBranch) {
            out.push({ step, conditional });
            walk(step.branches[branch], conditional);
            return true;
          }
        }
      }

      out.push({ step, conditional });
      // A branching step that does NOT contain the target still ran, and
      // steps inside its branches ran only if that branch was taken.
      if (step.branches) {
        for (const branch of ['yes', 'no'] as const) {
          for (const f of flattenSteps(step.branches[branch])) {
            out.push({ step: f.step, conditional: true });
          }
        }
      }
    }
    return false;
  };

  walk(steps, false);
  return out;
}

/**
 * Every token offered for a step, grouped for the picker.
 *
 * `targetKey` null means "the whole automation" (used by the trigger
 * panel and by anything not attached to a step).
 */
export function tokensFor(
  steps: BuilderStep[],
  targetKey: string | null,
  trigger: AutomationTriggerType,
  variableNames: string[] = [],
): TokenGroup[] {
  const groups: TokenGroup[] = [
    { id: 'trigger', label: 'Trigger', options: triggerTokens(trigger) },
    { id: 'contact', label: 'Contact', options: CONTACT_TOKENS },
  ];

  if (variableNames.length > 0) {
    groups.push({
      id: 'vars',
      label: 'Variables',
      options: variableNames.map((name) => ({
        path: `vars.${name}`,
        label: name,
        hint: 'Set by a Set variable step',
      })),
    });
  }

  const before = targetKey
    ? precedingSteps(steps, targetKey)
    : flattenSteps(steps).map((f) => ({ step: f.step, conditional: false }));

  for (const { step, conditional } of before) {
    const meta = STEP_META[step.step_type];
    const outputs = meta?.outputs;
    if (!outputs || outputs.length === 0) continue;
    groups.push({
      id: `step:${step.key}`,
      label: `${meta.label} · ${step.key}`,
      options: outputs.map((o) => ({
        path: `steps.${step.key}.${o.path}`,
        label: o.label,
        hint: conditional ? 'Only if that branch ran' : undefined,
        conditional,
      })),
    });
  }

  groups.push({ id: 'clock', label: 'Date & time', options: CLOCK_TOKENS });
  return groups;
}

/**
 * Variable names declared by `set_variable` steps, so the picker can
 * offer them. Read off the config rather than tracked separately —
 * there is no second place for them to drift from.
 */
export function declaredVariables(steps: BuilderStep[]): string[] {
  const names = new Set<string>();
  for (const { step } of flattenSteps(steps)) {
    if (step.step_type === 'set_variable') {
      const name = String(step.step_config.name ?? '').trim();
      if (name) names.add(name);
    }
    // ANY step can copy its output to a variable via `save_as`, which is
    // why this is not inside the set_variable branch above.
    const saveAs = String(step.step_config.save_as ?? '').trim();
    if (saveAs) names.add(saveAs);
  }
  return [...names].sort();
}

/** Wrap a path in the braces the engine expects. */
export function toTokenText(path: string): string {
  return `{{ ${path} }}`;
}
