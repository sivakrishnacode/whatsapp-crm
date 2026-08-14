/**
 * Turn a validated action input into a string, honestly.
 *
 * WHY NOT JUST `String(value)`
 *   Action inputs are `Record<string, unknown>`, and `String()` on an
 *   object yields the literal text `[object Object]`. That is not a
 *   type-checker complaint about a case that cannot happen: a
 *   `key_values` field holds an object, and interpolation resolves a
 *   whole-token value to whatever type it found — so
 *   `{{ steps.lookup.body }}` in a text field really does arrive as an
 *   object. Sending `[object Object]` into somebody's spreadsheet or
 *   calendar invite is the failure this prevents.
 *
 *   JSON is the least surprising thing to put in a text field when an
 *   object turns up there: it is at least readable, and it makes the
 *   mistake obvious to whoever wrote the automation.
 */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** As `asText`, but an empty/absent value falls back to `fallback`. */
export function asTextOr(value: unknown, fallback: string): string {
  const text = asText(value);
  return text.trim() === '' ? fallback : text;
}
