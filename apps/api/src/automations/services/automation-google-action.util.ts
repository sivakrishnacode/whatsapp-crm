import type { FieldSpec } from '../../google-script/google-script.types';
import type { AutomationContext } from '../automation.types';
import { interpolate, resolveValue } from './automation-interpolation.util';

/**
 * Interpolate a Google action's inputs, guided by the action's field specs.
 *
 * WHY THE SPEC DRIVES THIS RATHER THAN "INTERPOLATE EVERYTHING"
 *   A blanket walk would also rewrite ids and enum values, where a
 *   `{{ }}` is almost always a mistake — and where an unknown token
 *   resolving to "" (which is what the engine does everywhere, by
 *   design) turns into an obscure provider error rather than a visible
 *   one. `tokens: false` on a spec means "this is a machine value, leave
 *   it alone".
 *
 * WHY `resolveValue` AND NOT `interpolate` FOR WHOLE-TOKEN VALUES
 *   Same reason `set_variable` uses it: a field whose value is exactly
 *   one token keeps the underlying TYPE. `{{ steps.lookup.body.total }}`
 *   in a number field arrives as 42, not "42", and a whole row object
 *   dropped into a value_list field stays an array instead of becoming
 *   "[object Object]".
 */
export function interpolateGoogleActionInput(
  specs: FieldSpec[],
  raw: Record<string, unknown> | undefined,
  context: AutomationContext,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const source = raw ?? {};

  for (const spec of specs) {
    const value = source[spec.key];
    if (value === undefined || value === null) continue;

    if (!spec.tokens) {
      input[spec.key] = value;
      continue;
    }

    input[spec.key] = interpolateDeep(value, context);
  }

  return input;
}

/**
 * Walk a value, interpolating strings wherever they appear.
 *
 * Depth matters because a spreadsheet row arrives as a LIST of
 * author-written values — `['{{ contact.name }}', '{{ contact.phone }}']`
 * — and interpolating only the top level would post the templates
 * verbatim into somebody's spreadsheet.
 */
function interpolateDeep(value: unknown, context: AutomationContext): unknown {
  if (typeof value === 'string') {
    return resolveValue(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, context));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Keys are interpolated too: a spreadsheet column chosen by an
      // earlier step is a real (if rarer) case, and `interpolate` rather
      // than `resolveValue` because a key must end up a string.
      out[interpolate(key, context)] = interpolateDeep(item, context);
    }
    return out;
  }
  return value;
}
