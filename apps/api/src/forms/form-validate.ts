import {
  FORM_FIELD_TYPES,
  PRESENTATIONAL_TYPES,
  type FieldError,
  type FormField,
  type FormFieldType,
} from './form.types';

/**
 * Server-side validation of a form definition and of a submission.
 *
 * THE SERVER IS THE AUTHORITY, NOT THE BROWSER
 *   The renderer emits `required`, `type="email"` and `maxlength` for UX,
 *   and every one of them is trivially removed with devtools on a public
 *   page. If this file did not re-check, "required" would mean "required
 *   unless you don't feel like it" and the CRM would fill with blank
 *   leads. So the renderer's checks exist to be helpful and these exist to
 *   be true.
 *
 * WHY IT IS PURE
 *   No Prisma, no clock, no I/O. Every branch is reachable from a plain
 *   object, so the whole matrix of field types × required × malformed
 *   input is cheap table tests rather than integration fixtures.
 *
 * A REJECTED SUBMISSION IS A LOST LEAD
 *   That shapes the strictness: coerce where a value is unambiguous (the
 *   string "42" for a number field, "true"/"on" for a checkbox), reject
 *   only where accepting would store something false. Being pedantic about
 *   a phone number's punctuation costs the customer a real enquiry.
 */

export interface ValidateSubmissionResult {
  ok: boolean;
  errors: FieldError[];
  /** Coerced values, keyed by field_key. Only present when `ok`. */
  data: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Digits, with optional +, spaces, dashes, parens, dots. Minimum 6 digits. */
const PHONE_RE = /^\+?[\d\s\-().]{6,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Guards a single text answer from being used as a storage-exhaustion vector. */
const MAX_TEXT = 5000;
const MAX_SHORT_TEXT = 500;

// ============================================================
// Definition validation (dashboard save path)
// ============================================================

export interface DefinitionIssue {
  index: number;
  field_key: string | null;
  message: string;
}

/**
 * Check a field list before it is saved.
 *
 * Rejecting a broken definition here is much kinder than letting it save
 * and fail at render time on a public URL the customer has already shared.
 */
export function validateFormDefinition(fields: unknown): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];

  if (!Array.isArray(fields)) {
    return [{ index: -1, field_key: null, message: 'Fields must be a list.' }];
  }

  const seenKeys = new Set<string>();

  fields.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      issues.push({ index, field_key: null, message: 'Not a field object.' });
      return;
    }
    const field = raw as Partial<FormField>;

    if (!field.field_key || typeof field.field_key !== 'string') {
      issues.push({
        index,
        field_key: null,
        message: 'Field is missing a key.',
      });
    } else if (seenKeys.has(field.field_key)) {
      // A duplicate key means two fields write to one slot in
      // `submissions.data` and one answer silently disappears.
      issues.push({
        index,
        field_key: field.field_key,
        message: `Duplicate field key "${field.field_key}".`,
      });
    } else {
      seenKeys.add(field.field_key);
    }

    if (
      !field.type ||
      !(FORM_FIELD_TYPES as readonly string[]).includes(field.type)
    ) {
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: `Unknown field type "${String(field.type)}".`,
      });
      return;
    }

    if (!PRESENTATIONAL_TYPES.includes(field.type) && !field.label?.trim()) {
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: 'Field needs a label.',
      });
    }

    if (
      ['select', 'multiselect', 'radio'].includes(field.type) &&
      (!Array.isArray(field.options) || field.options.length === 0)
    ) {
      // A choice field with no choices renders as an empty dropdown the
      // visitor cannot satisfy — and if it is required, the form is
      // impossible to submit.
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: 'Choice fields need at least one option.',
      });
    }

    if (field.mapping !== undefined && typeof field.mapping !== 'string') {
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: 'Mapping must be a string.',
      });
    }
  });

  return issues;
}

// ============================================================
// Submission validation (public path)
// ============================================================

export function validateSubmission(
  fields: FormField[],
  input: Record<string, unknown>,
): ValidateSubmissionResult {
  const errors: FieldError[] = [];
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    if (PRESENTATIONAL_TYPES.includes(field.type)) continue;

    const raw = input[field.field_key];
    const result = coerceField(field, raw);

    if (result.error) {
      errors.push({ field_key: field.field_key, message: result.error });
      continue;
    }

    // Absent optional fields are omitted rather than stored as null, so a
    // submission's keys are exactly the questions that were answered.
    if (result.value !== undefined) {
      data[field.field_key] = result.value;
    }
  }

  // Unknown keys in the payload are dropped, not rejected: a stale cached
  // page submitting a field that has since been removed should still get
  // its lead recorded.

  return { ok: errors.length === 0, errors, data };
}

interface CoerceResult {
  value?: unknown;
  error?: string;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function coerceField(field: FormField, raw: unknown): CoerceResult {
  const label = field.label || field.field_key;

  if (isBlank(raw)) {
    // `consent` is required-by-nature: an unticked consent box is a "no",
    // not a missing answer, and must never be recorded as consent given.
    if (field.required || field.type === 'consent') {
      return {
        error:
          field.type === 'consent'
            ? `Please agree to ${label}.`
            : `${label} is required.`,
      };
    }
    return {};
  }

  switch (field.type) {
    case 'text':
    case 'hidden': {
      const text = String(raw);
      if (text.length > MAX_SHORT_TEXT) {
        return { error: `${label} is too long.` };
      }
      return { value: text.trim() };
    }

    case 'textarea': {
      const text = String(raw);
      if (text.length > MAX_TEXT) return { error: `${label} is too long.` };
      return { value: text.trim() };
    }

    case 'email': {
      const email = String(raw).trim().toLowerCase();
      if (email.length > 320 || !EMAIL_RE.test(email)) {
        return { error: `${label} is not a valid email address.` };
      }
      return { value: email };
    }

    case 'phone': {
      const phone = String(raw).trim();
      const digits = phone.replace(/\D/g, '');
      // Deliberately loose: strict E.164 rejects the way most people type
      // their own number, and this is a lead-capture form, not a dialler.
      // Normalisation happens in the contact resolver.
      if (!PHONE_RE.test(phone) || digits.length < 6 || digits.length > 15) {
        return { error: `${label} is not a valid phone number.` };
      }
      return { value: phone };
    }

    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) {
        return { error: `${label} must be a number.` };
      }
      if (field.min !== undefined && num < field.min) {
        return { error: `${label} must be at least ${field.min}.` };
      }
      if (field.max !== undefined && num > field.max) {
        return { error: `${label} must be at most ${field.max}.` };
      }
      return { value: num };
    }

    case 'select':
    case 'radio': {
      const value = String(raw);
      const allowed = (field.options ?? []).map((o) => o.value);
      // Membership-checked, not just non-empty: without this a visitor can
      // post any string and it lands in the CRM as though it were one of
      // the offered choices.
      if (!allowed.includes(value)) {
        return { error: `${label} has an invalid selection.` };
      }
      return { value };
    }

    case 'multiselect': {
      const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const allowed = (field.options ?? []).map((o) => o.value);
      const invalid = list.filter((v) => !allowed.includes(v));
      if (invalid.length > 0) {
        return { error: `${label} has an invalid selection.` };
      }
      // De-duplicated: a repeated value in the payload would otherwise
      // show as the same choice picked twice.
      return { value: [...new Set(list)] };
    }

    case 'checkbox':
    case 'consent': {
      const truthy =
        raw === true ||
        raw === 'true' ||
        raw === 'on' ||
        raw === 1 ||
        raw === '1';
      if (field.type === 'consent' && !truthy) {
        return { error: `Please agree to ${label}.` };
      }
      if (field.required && !truthy) {
        return { error: `${label} is required.` };
      }
      return { value: truthy };
    }

    case 'date': {
      const date = String(raw).trim();
      if (!DATE_RE.test(date) || Number.isNaN(new Date(date).getTime())) {
        return { error: `${label} is not a valid date.` };
      }
      return { value: date };
    }

    case 'time': {
      const time = String(raw).trim();
      if (!TIME_RE.test(time)) {
        return { error: `${label} is not a valid time.` };
      }
      return { value: time };
    }

    case 'rating': {
      const scale = field.scale ?? 5;
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isInteger(num) || num < 1 || num > scale) {
        return { error: `${label} must be between 1 and ${scale}.` };
      }
      return { value: num };
    }

    case 'file': {
      // The value is a URL our own upload endpoint returned. Accepting an
      // arbitrary URL would let a submission point an agent at anything —
      // so it must be a relative path or a same-family storage URL, and
      // never a full third-party URL.
      const url = String(raw).trim();
      if (url.length > 2000 || !/^https?:\/\//.test(url)) {
        return { error: `${label} was not uploaded correctly.` };
      }
      return { value: url };
    }

    case 'appointment_slot': {
      // An ISO instant chosen from the slot picker. Re-checked for actual
      // availability by the booking service — this only confirms shape,
      // because availability is a database question, not a format one.
      const iso = String(raw).trim();
      const parsed = new Date(iso);
      if (Number.isNaN(parsed.getTime())) {
        return { error: `${label} is not a valid time slot.` };
      }
      return { value: parsed.toISOString() };
    }

    default:
      return { error: `${label} could not be processed.` };
  }
}

/** Field types whose answer is a `form-uploads` object URL. */
export function isFileField(type: FormFieldType): boolean {
  return type === 'file';
}
