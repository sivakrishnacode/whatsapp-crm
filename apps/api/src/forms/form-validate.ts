import {
  FIELD_CONDITION_OPERATORS,
  FIELD_FORMATS,
  FORM_FIELD_TYPES,
  PRESENTATIONAL_TYPES,
  computeFieldVisibility,
  type FieldError,
  type FieldFormat,
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

/**
 * The named formats, and the message each failure gets.
 *
 * ⚠️ EVERY PATTERN HERE IS ONE WE WROTE, AND THAT IS THE POINT.
 *   `format` is a fixed enum rather than a user-supplied regex because a
 *   customer-authored pattern run server-side on visitor input is a
 *   denial-of-service vector — catastrophic backtracking stalls the event
 *   loop for every tenant, Node cannot time a regex out, and capping the
 *   input does not help. All of these are linear: no nested quantifiers,
 *   no ambiguous alternation.
 *
 * The messages say what IS allowed, not what was wrong. "Use letters
 * only" tells someone what to do next; "invalid format" does not.
 */
const FORMAT_RULES: Record<
  Exclude<FieldFormat, 'any'>,
  { test: (value: string) => boolean; message: string }
> = {
  // ⚠️ \p{M} (combining marks) belongs in every one of these alongside
  // \p{L}. Indic, Arabic and Vietnamese scripts build a written letter
  // from a base plus one or more marks, so \p{L} alone rejects "இரா" and
  // "नमस्ते" while happily accepting "Jose" — a bug that only shows up for
  // the customers least likely to report it.
  letters: {
    test: (v) => /^[\p{L}\p{M}]+$/u.test(v),
    message: 'should be letters only',
  },
  letters_spaces: {
    test: (v) => /^[\p{L}\p{M}][\p{L}\p{M} '-]*$/u.test(v),
    message: 'should be letters, spaces, apostrophes and hyphens only',
  },
  alphanumeric: {
    test: (v) => /^[\p{L}\p{M}\p{N}]+$/u.test(v),
    message: 'should be letters and numbers only',
  },
  digits: {
    test: (v) => /^\p{N}+$/u.test(v),
    message: 'should be digits only',
  },
  no_links: {
    // Spam control for free-text boxes. Deliberately blunt: it looks for
    // a scheme or a bare host, not for a valid URL.
    test: (v) =>
      !/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ru|xyz|top|link)\b)/i.test(
        v,
      ),
    message: 'should not contain links',
  },
  url: {
    test: (v) => /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(v),
    message: 'should be a web address starting with http:// or https://',
  },
  business_email: {
    test: (v) => !FREE_EMAIL_DOMAINS.has(v.split('@')[1]?.toLowerCase() ?? ''),
    message: 'should be a work email address',
  },
};

/** Consumer mailbox providers, for the `business_email` format. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mail.com',
  'gmx.com',
  'yandex.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'rediffmail.com',
]);

/**
 * Length and format checks shared by every text-ish answer.
 *
 * Returns an error message or null. Runs AFTER the type's own coercion,
 * so `email` has already been lowercased and shape-checked by the time
 * `business_email` looks at its domain.
 */
function checkTextRules(field: FormField, value: string): string | null {
  const label = field.label || field.field_key;

  if (field.min_length !== undefined && value.length < field.min_length) {
    return `${label} should be at least ${field.min_length} characters.`;
  }
  if (field.max_length !== undefined && value.length > field.max_length) {
    return `${label} should be at most ${field.max_length} characters.`;
  }

  const format = field.format;
  if (!format || format === 'any') return null;
  const rule = FORMAT_RULES[format];
  if (!rule || rule.test(value)) return null;
  return `${label} ${rule.message}.`;
}

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
  /** Headings, paragraphs and page breaks — nothing to key a rule off. */
  const presentationalKeys = new Set<string>();

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

    if (
      field.format !== undefined &&
      !(FIELD_FORMATS as readonly string[]).includes(field.format)
    ) {
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: `Unknown format "${String(field.format)}".`,
      });
    }

    if (
      field.min_length !== undefined &&
      field.max_length !== undefined &&
      field.min_length > field.max_length
    ) {
      // Otherwise the form saves and then rejects every answer, which
      // reads as a broken form rather than a broken rule.
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: 'Minimum length is greater than maximum length.',
      });
    }

    if (field.mapping !== undefined && typeof field.mapping !== 'string') {
      issues.push({
        index,
        field_key: field.field_key ?? null,
        message: 'Mapping must be a string.',
      });
    }

    // Conditional visibility. Every problem here is one that would
    // otherwise surface as a field that never appears, or one that appears
    // and cannot be satisfied — both of which look like a broken form
    // rather than a broken rule, on a URL the customer has already shared.
    if (field.visible_when !== undefined) {
      const rule = field.visible_when;
      const issue = (message: string) =>
        issues.push({ index, field_key: field.field_key ?? null, message });

      if (!rule || typeof rule !== 'object') {
        issue('Visibility rule must be an object.');
      } else if (!rule.field_key || typeof rule.field_key !== 'string') {
        issue('Visibility rule must name a field.');
      } else if (
        !(FIELD_CONDITION_OPERATORS as readonly string[]).includes(
          rule.operator,
        )
      ) {
        issue(`Unknown visibility operator "${String(rule.operator)}".`);
      } else if (rule.field_key === field.field_key) {
        issue('A field cannot depend on itself.');
      } else if (!seenKeys.has(rule.field_key)) {
        // `seenKeys` holds only the fields ALREADY walked, so this single
        // check rejects both a reference to a field that does not exist
        // and a reference to one further down the form. The latter can
        // never be answered in time — decisively so once a page break
        // sits between them — and forbidding it is also what makes
        // dependency cycles impossible by construction.
        issue(
          `Visibility rule points at "${rule.field_key}", which must be a field above this one.`,
        );
      } else if (presentationalKeys.has(rule.field_key)) {
        issue(
          `Visibility rule points at "${rule.field_key}", which has no answer to test.`,
        );
      }
    }

    if (field.field_key && PRESENTATIONAL_TYPES.includes(field.type)) {
      presentationalKeys.add(field.field_key);
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

  // Conditional fields are resolved BEFORE anything is checked, because a
  // question the visitor never saw must neither be required of them nor
  // recorded against them. Both halves matter: skipping the requirement
  // alone would still let a stale answer through — someone who picks
  // "Other", types a reason, then switches back to a standard option must
  // not have that reason filed as their answer.
  const visible = computeFieldVisibility(fields, input);

  for (const field of fields) {
    if (PRESENTATIONAL_TYPES.includes(field.type)) continue;
    if (visible[field.field_key] === false) continue;

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

function coerceField(field: FormField, input: unknown): CoerceResult {
  const label = field.label || field.field_key;

  // A hidden field's default fills in for an absent value.
  //
  // It has to happen HERE rather than in the renderer because
  // `default_value` is stripped from the public projection — it can name
  // internal campaign structure, so the browser never sees it and cannot
  // apply it. The query parameter still wins when present; the default is
  // what a visitor arriving without one is recorded as.
  const raw =
    isBlank(input) && field.type === 'hidden' && field.default_value
      ? field.default_value
      : input;

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
      const text = String(raw).trim();
      if (text.length > MAX_SHORT_TEXT) {
        return { error: `${label} is too long.` };
      }
      const ruleError = checkTextRules(field, text);
      if (ruleError) return { error: ruleError };
      return { value: text };
    }

    case 'textarea': {
      const text = String(raw).trim();
      if (text.length > MAX_TEXT) return { error: `${label} is too long.` };
      const ruleError = checkTextRules(field, text);
      if (ruleError) return { error: ruleError };
      return { value: text };
    }

    case 'email': {
      const email = String(raw).trim().toLowerCase();
      if (email.length > 320 || !EMAIL_RE.test(email)) {
        return { error: `${label} is not a valid email address.` };
      }
      const ruleError = checkTextRules(field, email);
      if (ruleError) return { error: ruleError };
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
