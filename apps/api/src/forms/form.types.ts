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
  // Turns a form into a booking form. Lands with appointments (055).
  'appointment_slot',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Types that never produce a value in `submissions.data`. */
export const PRESENTATIONAL_TYPES: readonly FormFieldType[] = [
  'heading',
  'paragraph',
];

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
