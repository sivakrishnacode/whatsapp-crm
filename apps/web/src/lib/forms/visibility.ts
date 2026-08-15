/**
 * Conditional field visibility — the browser half.
 *
 * ⚠️ MIRROR OF `computeFieldVisibility` / `matchesCondition` IN
 * apps/api/src/forms/form.types.ts, WHICH IS THE AUTHORITY.
 *
 * The two must agree exactly. The server decides whether a submission is
 * accepted; this decides what the visitor is asked. When they disagree the
 * failure is the nastiest kind a form has: the browser hides a required
 * field, the server demands it, and the error comes back pinned to an
 * input that is not on screen — an unsubmittable form and a lost lead,
 * with nothing visibly wrong.
 *
 * Kept as a copy rather than a shared package because `apps/web` does not
 * import from `apps/api`; same arrangement as `lib/automations/availability.ts`
 * mirroring the engine's CHANNEL_CAPABILITIES.
 */

export const FIELD_CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
] as const;

export type FieldConditionOperator =
  (typeof FIELD_CONDITION_OPERATORS)[number];

export interface FieldCondition {
  /** The field whose answer decides. Always earlier in the list. */
  field_key: string;
  operator: FieldConditionOperator;
  value?: string;
}

/** Human labels for the builder's operator picker. */
export const CONDITION_OPERATOR_LABELS: Record<FieldConditionOperator, string> =
  {
    equals: 'is',
    not_equals: 'is not',
    contains: 'contains',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
    greater_than: 'is greater than',
    less_than: 'is less than',
  };

/** Operators that compare against nothing, so the value box is hidden. */
export const VALUELESS_OPERATORS: readonly FieldConditionOperator[] = [
  'is_empty',
  'is_not_empty',
];

/**
 * Resolve which fields are visible, given the answers so far.
 *
 * One pass in order: a rule may only name an earlier field, so by the time
 * the loop reaches a field it already knows whether the field it depends
 * on was itself visible. That is what makes chained rules correct — if
 * "Other" hid "Please specify", anything keyed off "Please specify" is
 * hidden too, whatever stale value is still sitting in `answers`.
 */
export function computeFieldVisibility(
  fields: { field_key: string; visible_when?: FieldCondition }[],
  answers: Record<string, unknown>,
): Record<string, boolean> {
  const visible: Record<string, boolean> = {};

  for (const field of fields) {
    const rule = field.visible_when;
    if (!rule?.field_key) {
      visible[field.field_key] = true;
      continue;
    }

    // Unknown or forward reference — shown, not hidden. A field nobody can
    // see is the worse of the two failures.
    if (!(rule.field_key in visible)) {
      visible[field.field_key] = true;
      continue;
    }

    visible[field.field_key] =
      visible[rule.field_key] && matchesCondition(rule, answers[rule.field_key]);
  }

  return visible;
}

/**
 * Render an answer as the string a rule compares against.
 *
 * Objects become `''` rather than `[object Object]`, so an answer shape
 * no field type produces matches nothing.
 */
function toComparable(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'number' || typeof answer === 'boolean') {
    return String(answer);
  }
  return '';
}

/** Evaluate one rule against one answer. Never throws. */
export function matchesCondition(
  rule: FieldCondition,
  answer: unknown,
): boolean {
  const blank =
    answer === undefined ||
    answer === null ||
    (typeof answer === 'string' && answer.trim() === '') ||
    (Array.isArray(answer) && answer.length === 0);

  switch (rule.operator) {
    case 'is_empty':
      return blank;
    case 'is_not_empty':
      return !blank;
  }

  if (blank) return false;

  const expected = (rule.value ?? '').trim();

  // A multiselect answers with a list, so "is" reads as "is one of the
  // ticked boxes" — which is what someone building the rule means.
  if (Array.isArray(answer)) {
    const list = answer.map(toComparable);
    switch (rule.operator) {
      case 'equals':
      case 'contains':
        return list.includes(expected);
      case 'not_equals':
        return !list.includes(expected);
      default:
        return false;
    }
  }

  const actual = toComparable(answer);

  switch (rule.operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case 'greater_than':
    case 'less_than': {
      const left = Number(actual);
      const right = Number(expected);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      return rule.operator === 'greater_than' ? left > right : left < right;
    }
    default:
      return false;
  }
}

/**
 * Split a field list into pages on `page_break`.
 *
 * Always returns at least one page, so a single-page form is just the
 * n = 1 case and the renderer needs no separate code path for it. The
 * break markers themselves are dropped — they are separators, not content.
 */
export function splitIntoPages<T extends { type: string }>(
  fields: T[],
): T[][] {
  const pages: T[][] = [[]];
  for (const field of fields) {
    if (field.type === 'page_break') pages.push([]);
    else pages[pages.length - 1].push(field);
  }
  return pages;
}
