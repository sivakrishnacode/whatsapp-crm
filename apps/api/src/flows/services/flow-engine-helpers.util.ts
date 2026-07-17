/**
 * Pure decision helpers for the Flows engine — extracted from
 * apps/web/src/lib/flows/engine.ts so they can be unit-tested without
 * a Prisma / Meta mock (mirrors automation-trigger-match.util.ts's
 * extraction pattern from the automations port).
 *
 * Signatures kept verbatim (snake_case `node_type` on the node
 * wrapper) — they operate on JSONB config shapes and the ported test
 * suite exercises them as-is; the engine adapts its Prisma models at
 * the call site.
 */

import type {
  ConditionNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
} from '../flow.types';

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? 'contains';
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (
      matchType === 'exact' ? haystack === needle : haystack.includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === 'start' ||
    node_type === 'send_message' ||
    node_type === 'send_media' ||
    node_type === 'condition' ||
    node_type === 'set_tag'
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === 'send_buttons' ||
    node_type === 'send_list' ||
    node_type === 'collect_input'
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === 'handoff' || node_type === 'end';
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Pure — the engine wraps it with a DB lookup for `tag` /
 * `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig['operator'];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case 'present':
      return args.subjectValue !== undefined && args.subjectValue !== '';
    case 'absent':
      return args.subjectValue === undefined || args.subjectValue === '';
    case 'equals':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? '');
    case 'contains':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? '');
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
export function interpolateVars(
  template: string,
  vars: Record<string, unknown>,
): string {
  if (!template) return '';
  return template.replace(
    /\{\{vars\.([a-zA-Z0-9_]+)\}\}/g,
    (_, key: string) => {
      const v = vars[key];
      return v === undefined || v === null
        ? ''
        : String(v as string | number | boolean);
    },
  );
}
