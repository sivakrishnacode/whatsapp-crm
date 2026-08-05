import 'server-only';

/**
 * Form parsing for Server Actions.
 *
 * Every action in this panel writes to billing data, and a Server Action is
 * reachable by direct POST — so nothing trusts the shape of what arrives.
 * `FieldError` is thrown for bad input and caught by the action, which turns it
 * into a message on the form rather than a 500.
 */

export class FieldError extends Error {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function text(form: FormData, name: string, label = name): string {
  const value = form.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new FieldError(`${label} is required.`);
  }
  return value.trim();
}

export function optionalText(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

export function uuid(form: FormData, name: string, label = name): string {
  const value = text(form, name, label);
  if (!UUID_RE.test(value)) throw new FieldError(`${label} is not a valid id.`);
  return value;
}

export function integer(
  form: FormData,
  name: string,
  {
    label = name,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    optional = false,
  }: { label?: string; min?: number; max?: number; optional?: boolean } = {}
): number | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw.trim()) {
    if (optional) return null;
    throw new FieldError(`${label} is required.`);
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new FieldError(`${label} must be a whole number.`);
  }
  if (value < min || value > max) {
    throw new FieldError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function decimal(
  form: FormData,
  name: string,
  {
    label = name,
    min = 0,
    max = 99_999_999,
  }: { label?: string; min?: number; max?: number } = {}
): number {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new FieldError(`${label} is required.`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new FieldError(`${label} must be a number.`);
  }
  if (value < min || value > max) {
    throw new FieldError(`${label} must be between ${min} and ${max}.`);
  }
  // Two decimal places — the column is numeric(10,2), so anything finer would
  // be silently rounded by Postgres instead of visibly rejected here.
  return Math.round(value * 100) / 100;
}

export function boolean(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === 'on' || value === 'true' || value === '1';
}

/**
 * `<input type="date">` posts `YYYY-MM-DD`. Interpreted as UTC midnight, which
 * keeps a date the operator typed from drifting a day depending on where the
 * server is.
 */
export function date(form: FormData, name: string, label = name): Date | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const parsed = new Date(`${raw.trim()}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new FieldError(`${label} is not a valid date.`);
  }
  return parsed;
}

export function oneOf<T extends string>(
  form: FormData,
  name: string,
  allowed: readonly T[],
  {
    label = name,
    optional = false,
  }: { label?: string; optional?: boolean } = {}
): T | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw) {
    if (optional) return null;
    throw new FieldError(`${label} is required.`);
  }
  if (!allowed.includes(raw as T)) {
    throw new FieldError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

/** For `<input type="date" value={...}>` — the inverse of `date()`. */
export function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}
