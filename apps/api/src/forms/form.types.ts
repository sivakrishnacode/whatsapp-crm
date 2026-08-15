/**
 * Form field definitions.
 *
 * ONE UNION, NOT A CLASS PER TYPE
 *   Every field shares 80% of its shape (key, label, required, help text)
 *   and differs in a handful of optional extras. A discriminated union
 *   with shared base props keeps the renderer a single switch and the
 *   validator a single function, which is what stops the client and server
 *   validation drifting.
 *
 * FIELD KEYS ARE STABLE AND CLIENT-INVISIBLE
 *   `field_key` is what `form_submissions.data` is keyed by, so it must
 *   survive the label being reworded — otherwise every historical
 *   submission loses the column it belonged to. The builder generates it
 *   once and never regenerates it from the label.
 */

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'select',
  'multiselect',
  'radio',
  'checkbox',
  'date',
  'time',
  'file',
  'rating',
  'hidden',
  'consent',
  // Presentational — carry no answer and are skipped by the validator.
  'heading',
  'paragraph',
  // Splits the form into steps. Presentational for the same reason as the
  // two above: it is a marker in the field list, not a question.
  'page_break',
  // Turns a form into a booking form. Lands with appointments (055).
  'appointment_slot',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Types that never produce a value in `submissions.data`. */
export const PRESENTATIONAL_TYPES: readonly FormFieldType[] = [
  'heading',
  'paragraph',
  'page_break',
];

/**
 * A field's visibility rule.
 *
 * WHY THE VALIDATOR HAS TO KNOW ABOUT THIS
 *   A required field that the visitor never saw must not block their
 *   submission. If only the renderer understood conditions, a form with
 *   "Which product?" required-but-hidden would validate client-side (the
 *   renderer skips it) and then be rejected by the server, with the error
 *   painted onto an input that is not on screen. That is an unsubmittable
 *   form and a lost lead, so `evaluateVisibility` is shared logic and
 *   `validateSubmission` runs it first.
 *
 * BACKWARD REFERENCES ONLY
 *   `field_key` must name a field EARLIER in the list. That single rule
 *   makes cycles impossible by construction rather than by cycle
 *   detection, and it is also the only rule under which a condition can
 *   actually be satisfied once the form is split into pages — a field on
 *   page 3 cannot decide whether something on page 1 is visible.
 */
export interface FieldCondition {
  /** The field whose answer decides. Must appear earlier in the list. */
  field_key: string;
  operator: FieldConditionOperator;
  /**
   * Compared against. Unused by `is_empty` / `is_not_empty`, and compared
   * as a string for every operator except the numeric two.
   */
  value?: string;
}

export const FIELD_CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
] as const;

export type FieldConditionOperator = (typeof FIELD_CONDITION_OPERATORS)[number];

export interface FormFieldOption {
  /** Stored value. Stable, like field_key. */
  value: string;
  /** Displayed text. Safe to reword. */
  label: string;
}

export interface FormField {
  /** Stable key. Keys `submissions.data`; never regenerated from the label. */
  field_key: string;
  type: FormFieldType;
  label: string;
  placeholder?: string;
  help_text?: string;
  required?: boolean;
  /** Rendered full width vs. half, for side-by-side name/email rows. */
  width?: 'full' | 'half';

  /** select / multiselect / radio. */
  options?: FormFieldOption[];

  /** text / textarea / number bounds. */
  min?: number;
  max?: number;
  /** rating only — how many stars. */
  scale?: number;

  /**
   * Where this answer lands on the contact: a built-in column
   * (`name` | `email` | `phone` | `company`) or `custom:<custom_field_id>`.
   *
   * Deliberately the same encoding as `UpdateContactFieldStepConfig.field`
   * in the automations engine — one convention, one parser, and the two
   * cannot drift into disagreeing about what `custom:` means.
   */
  mapping?: string;

  /** hidden only. Prefilled from a query param of the same name. */
  default_value?: string;

  /** file only. */
  accept?: string[];

  /**
   * Show this field only when the rule holds. Absent = always shown.
   *
   * Deliberately NOT stripped from the public projection: the renderer
   * cannot apply a rule it cannot see. It names one of the form's own
   * field keys, which the visitor is already looking at, so it leaks
   * nothing that `fields` did not already.
   */
  visible_when?: FieldCondition;
}

export interface FormSettings {
  submit_label: string;
  success_mode: 'message' | 'redirect';
  success_message: string;
  redirect_url: string | null;
  /** Spam controls — see form-submit.service. */
  honeypot: boolean;
  /** Reject submissions faster than this; a human cannot fill a form in 0s. */
  min_seconds: number;
  captcha: boolean;
}

export interface FormNotify {
  emails: string[];
  in_app: boolean;
}

/** The public projection — what an anonymous visitor may see. */
export interface PublicForm {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: 'form' | 'booking';
  /** `mapping` and `default_value` are stripped. See form-render.service. */
  fields: PublicFormField[];
  settings: Pick<FormSettings, 'submit_label' | 'honeypot'>;
}

export type PublicFormField = Omit<FormField, 'mapping'>;

/** One field's verdict from the validator. */
export interface FieldError {
  field_key: string;
  message: string;
}

/**
 * Resolve which fields are visible, given the answers so far.
 *
 * ONE PASS, IN ORDER, BECAUSE REFERENCES POINT BACKWARDS
 *   A condition may only name an earlier field, so by the time this loop
 *   reaches a field it already knows whether the field it depends on was
 *   itself visible. That is what makes CHAINED conditions correct: if
 *   "Other" hid the "Please specify" field, anything keyed off "Please
 *   specify" must be hidden too, regardless of what stale value is still
 *   sitting in `answers` from before the visitor changed their mind.
 *
 * A HIDDEN FIELD IS NOT A BLANK ONE
 *   Callers use this to decide what to skip entirely — not to substitute
 *   an empty answer. `validateSubmission` neither requires nor stores a
 *   hidden field, so a lead is never lost to a question nobody was asked
 *   and no answer is ever recorded to a question that was not on screen.
 *
 * Mirrored by `computeFieldVisibility` in
 * apps/web/src/lib/forms/visibility.ts, which the renderer uses to paint
 * the same result. Both must agree or the browser and the server will
 * disagree about whether a form can be submitted.
 */
export function computeFieldVisibility(
  fields: Pick<FormField, 'field_key' | 'visible_when'>[],
  answers: Record<string, unknown>,
): Record<string, boolean> {
  const visible: Record<string, boolean> = {};

  for (const field of fields) {
    const rule = field.visible_when;
    if (!rule?.field_key) {
      visible[field.field_key] = true;
      continue;
    }

    // Unknown or forward reference. Definition validation rejects both, so
    // this only catches a form saved before the rule existed — shown
    // rather than hidden, because a field nobody can see is the worse
    // failure of the two.
    if (!(rule.field_key in visible)) {
      visible[field.field_key] = true;
      continue;
    }

    visible[field.field_key] =
      visible[rule.field_key] &&
      matchesCondition(rule, answers[rule.field_key]);
  }

  return visible;
}

/**
 * Render an answer as the string a rule compares against.
 *
 * Objects deliberately become `''` rather than `[object Object]`: an
 * answer shape that no field type produces should match nothing, not
 * match a rule whose value someone happened to type as "[object Object]".
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

  // A multiselect answers with a list, so "equals" reads as "is one of
  // the ticked boxes" — which is what someone building the rule means.
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
      // Non-numeric on either side is "no match", not an error: a rule
      // comparing text with `>` is nonsense the builder should have
      // caught, and throwing here would reject the whole submission.
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      return rule.operator === 'greater_than' ? left > right : left < right;
    }
    default:
      return false;
  }
}

export const CONTACT_COLUMN_MAPPINGS = [
  'name',
  'email',
  'phone',
  'company',
] as const;

export type ContactColumnMapping = (typeof CONTACT_COLUMN_MAPPINGS)[number];

/**
 * Split a `mapping` into where it writes.
 *
 * Returns null for an unmapped or unrecognised field rather than
 * throwing: a mapping that no longer resolves (a deleted custom field)
 * must not stop a submission from being recorded — losing the lead is
 * worse than losing one column of it.
 */
export function parseMapping(
  mapping: string | undefined,
):
  | { kind: 'column'; column: ContactColumnMapping }
  | { kind: 'custom'; customFieldId: string }
  | null {
  if (!mapping) return null;

  if (mapping.startsWith('custom:')) {
    const id = mapping.slice('custom:'.length);
    return id ? { kind: 'custom', customFieldId: id } : null;
  }

  return (CONTACT_COLUMN_MAPPINGS as readonly string[]).includes(mapping)
    ? { kind: 'column', column: mapping as ContactColumnMapping }
    : null;
}
