import type { AutomationContext } from '../automation.types';

/**
 * Token resolution for automation step configs.
 *
 * ORIGINAL CONTRACT, STILL HONOURED
 *   `{{message.text}}`, `{{vars.<key>}}` and `{{contact.<field>}}` resolve
 *   as they always did, and an unknown token resolves to an EMPTY STRING
 *   rather than being left verbatim. That is deliberate and load-bearing:
 *   an unresolved `{{vars.name}}` sent to a customer reads as a broken app,
 *   whereas a gap reads as a typo in the copy. It also keeps a template
 *   variable from being rejected by Meta for containing braces.
 *
 * WHAT IS NEW (and why)
 *   1. DEEP PATHS — `{{ steps.lookup.body.data.0.id }}`. A webhook returns
 *      JSON; being able to name only the top level of it means the answer
 *      to "post the order id to Slack" is "you can't".
 *   2. `steps.<key>` — every step publishes an output object under its
 *      author-chosen key (migration 080). This is the whole point: a step
 *      can build its request from what earlier steps produced.
 *   3. `trigger.*`, `conversation.*`, `form.*`, `now.*` — context that was
 *      already in the run but had no way to be named.
 *   4. FILTERS — `{{ contact.name | default: "there" }}`. Without a
 *      default, one missing field turns a greeting into "Hi ,". `json` is
 *      the load-bearing one: it is what makes a value safe to paste inside
 *      a hand-written JSON body.
 *
 * WHY NOT A REAL EXPRESSION LANGUAGE
 *   Anything with operators or function calls invites `eval`, and this
 *   string comes from the account's own config but is rendered by OUR
 *   server, on OUR network, inside a shared process. Path lookup plus a
 *   fixed filter list has no evaluation step to escape from.
 */

/** Namespaces a token may address. Anything else resolves to "". */
export const TOKEN_NAMESPACES = [
  'message',
  'vars',
  'contact',
  'steps',
  'trigger',
  'conversation',
  'form',
  'now',
] as const;

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Resolve every `{{ … }}` in `s` against the run context.
 *
 * The return is always a string — this is for building message text, URLs
 * and header values. Use `resolveToken` when the raw value matters (an
 * object, a number) and `interpolateDeep` for a JSON body.
 */
export function interpolate(
  s: string,
  context: AutomationContext | undefined,
): string {
  if (typeof s !== 'string' || s.indexOf('{{') === -1) return s ?? '';
  return s.replace(TOKEN_RE, (_whole, expr: string) => {
    const value = evaluateExpression(String(expr), context);
    return stringifyForText(value);
  });
}

/**
 * Resolve a template that is EXACTLY one token (`"{{ steps.x.body }}"`)
 * to the underlying value with its type intact, and anything else by
 * ordinary string interpolation.
 *
 * This is what lets a JSON body builder produce `"qty": 3` rather than
 * `"qty": "3"`, and pass a whole object through as an object.
 */
export function resolveValue(
  s: unknown,
  context: AutomationContext | undefined,
): unknown {
  if (typeof s !== 'string') return s;
  const soleToken = s.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
  if (soleToken) return evaluateExpression(soleToken[1], context);
  return interpolate(s, context);
}

/**
 * Walk an arbitrary JSON structure resolving every string it contains.
 *
 * Object KEYS are interpolated too — a body keyed by
 * `{{ contact.phone }}` is unusual but not wrong, and silently ignoring
 * the token there would be the surprising behaviour.
 */
export function interpolateDeep(
  value: unknown,
  context: AutomationContext | undefined,
): unknown {
  if (typeof value === 'string') return resolveValue(value, context);
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, context));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[interpolate(k, context)] = interpolateDeep(v, context);
    }
    return out;
  }
  return value;
}

/**
 * One `path | filter: arg | filter` expression.
 *
 * Split on `|` first so a filter argument containing a dot (a default of
 * "N/A." say) cannot be mistaken for a path segment.
 */
function evaluateExpression(
  expr: string,
  context: AutomationContext | undefined,
): unknown {
  const [pathPart, ...filterParts] = splitTopLevel(expr, '|');
  let value = resolveToken(pathPart.trim(), context);
  for (const f of filterParts) {
    value = applyFilter(value, f.trim());
  }
  return value;
}

/**
 * Split on `sep`, ignoring separators inside quotes — so
 * `default: "a|b"` survives.
 */
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === sep) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Resolve a dotted path against the context.
 *
 * The first segment picks the namespace; the rest is an ordinary lookup
 * into whatever that namespace holds, including array indices
 * (`items.0.sku`).
 */
export function resolveToken(
  path: string,
  context: AutomationContext | undefined,
): unknown {
  const ctx = context ?? {};
  const segments = path.split('.').map((p) => p.trim()).filter(Boolean);
  if (segments.length === 0) return '';
  const [ns, ...rest] = segments;

  switch (ns) {
    case 'message':
      // `{{message.text}}` is the historical spelling and by far the most
      // used token in existing accounts.
      return rest[0] === 'text' ? (ctx.message_text ?? '') : '';
    case 'vars':
      return dig(ctx.vars, rest);
    case 'contact':
      return dig(ctx.contact, rest);
    case 'steps':
      return dig(ctx.steps, rest);
    case 'form':
      return dig(ctx.form, rest);
    case 'trigger':
      return dig(triggerNamespace(ctx), rest);
    case 'conversation':
      return dig(
        { id: ctx.conversation_id ?? '', channel: ctx.channel ?? '' },
        rest,
      );
    case 'now':
      return nowNamespace(rest);
    default:
      // Unknown namespace → "". See the header: a visible {{token}} in a
      // customer-facing message is worse than a gap.
      return '';
  }
}

/**
 * Facts about what started the run.
 *
 * Assembled on demand rather than stored: every field here already lives
 * on the context under its own name, and duplicating them at dispatch
 * would mean two copies to keep in step.
 */
function triggerNamespace(ctx: AutomationContext): Record<string, unknown> {
  return {
    channel: ctx.channel ?? '',
    message: ctx.message_text ?? '',
    tag_id: ctx.tag_id ?? '',
    form_id: ctx.form_id ?? '',
    submission_id: ctx.submission_id ?? '',
    appointment_id: ctx.appointment_id ?? '',
    appointment_type_id: ctx.appointment_type_id ?? '',
    agent_id: ctx.agent_id ?? '',
    ig_comment_id: ctx.ig_comment_id ?? '',
    ig_media_id: ctx.ig_media_id ?? '',
  };
}

/**
 * Clock tokens, resolved at the moment the step runs.
 *
 * UTC, always. A run has no single "local" timezone to be right about —
 * the account, the agent and the contact can all be in different ones —
 * and an ISO-8601 UTC string is the one form every downstream system
 * parses unambiguously.
 */
function nowNamespace(rest: string[]): unknown {
  const d = new Date();
  const table: Record<string, unknown> = {
    iso: d.toISOString(),
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 19),
    timestamp: Math.floor(d.getTime() / 1000),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
  // Bare `{{ now }}` is the common case and should not need a suffix.
  if (rest.length === 0) return table.iso;
  return table[rest[0]] ?? '';
}

/** Follow `path` into a plain object / array graph. */
function dig(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || current === undefined) return '';
    if (Array.isArray(current)) {
      const idx = Number(key);
      // A named lookup into an array is a mistake, not an index — return
      // "" rather than JavaScript's `undefined`-shaped surprises.
      if (!Number.isInteger(idx)) return '';
      current = current[idx];
      continue;
    }
    if (typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? '';
}

/**
 * Render a resolved value for insertion into text.
 *
 * Objects and arrays become JSON rather than "[object Object]" — someone
 * who drops `{{ steps.lookup.body }}` into a message wants to see the
 * payload, and the alternative teaches them nothing.
 */
function stringifyForText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * The filter table. Deliberately small and total: every filter has a
 * defined answer for every input type, because a filter that throws would
 * fail a send over formatting.
 */
function applyFilter(value: unknown, spec: string): unknown {
  const colon = spec.indexOf(':');
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  const rawArg = colon === -1 ? '' : spec.slice(colon + 1).trim();
  const arg = unquote(rawArg);

  switch (name) {
    case 'default':
      return isBlank(value) ? arg : value;
    case 'upper':
      return stringifyForText(value).toUpperCase();
    case 'lower':
      return stringifyForText(value).toLowerCase();
    case 'trim':
      return stringifyForText(value).trim();
    case 'truncate': {
      const n = Number(arg);
      const s = stringifyForText(value);
      if (!Number.isFinite(n) || n <= 0 || s.length <= n) return s;
      return `${s.slice(0, n)}…`;
    }
    case 'json':
      // The reason this exists: pasting a raw value into a hand-written
      // JSON body breaks the moment it contains a quote or a newline.
      try {
        return JSON.stringify(value ?? '');
      } catch {
        return '""';
      }
    case 'urlencode':
      return encodeURIComponent(stringifyForText(value));
    case 'number': {
      const n = Number(stringifyForText(value).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    case 'digits':
      // Phone numbers arrive formatted in a dozen ways and most APIs want
      // only the digits.
      return stringifyForText(value).replace(/\D/g, '');
    default:
      // Unknown filter: pass the value through untouched rather than
      // blanking it. A typo'd filter name should not silently delete the
      // data it was applied to.
      return value;
  }
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
