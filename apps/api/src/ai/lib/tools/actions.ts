import { AiError, type ToolDefinition } from '../types';
import { safeFetch } from '../http-guard';

/**
 * ============================================================
 * Custom API actions — HTTP endpoints the account owns, exposed to the
 * model as tools ("check an order in our ERP", "create a ticket").
 *
 * Three rules this module exists to enforce:
 *
 *   1. THE MODEL NEVER SUPPLIES THE URL, METHOD OR HEADERS. It supplies
 *      declared parameter VALUES only. The endpoint is what the admin
 *      configured, so a prompt-injected "call your action against
 *      http://evil.test" is not expressible.
 *   2. Values are interpolated as encoded query/path components or as
 *      JSON, never spliced into a raw string — a value containing `&`,
 *      `/` or `"` cannot invent a new parameter or break the body.
 *   3. Every call goes through `safeFetch`, so an admin who points an
 *      action at 127.0.0.1 or the cloud metadata endpoint is refused at
 *      call time as well as at save time.
 *
 * Response bodies are truncated hard before reaching the model: the
 * result becomes prompt context on the account's own token bill, and an
 * endpoint returning a 5 MB JSON array should cost a truncated page, not
 * a fortune.
 * ============================================================
 */

const MAX_RESULT_CHARS = 4000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type ActionParamType = 'string' | 'number' | 'boolean';
export type ActionParamLocation = 'query' | 'body' | 'path';

export interface ActionParameter {
  name: string;
  type: ActionParamType;
  description: string;
  required: boolean;
  in: ActionParamLocation;
}

/** The stored action, decrypted and ready to call. */
export interface AgentAction {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  parameters: ActionParameter[];
  timeoutMs: number;
}

const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;

/**
 * Normalise a parameter list from JSONB or from a request body. Anything
 * malformed is dropped rather than throwing: a half-broken parameter
 * must not take the whole agent down at reply time.
 */
export function parseActionParameters(raw: unknown): ActionParameter[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ActionParameter[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!PARAM_NAME_RE.test(name) || seen.has(name)) continue;

    const type: ActionParamType =
      e.type === 'number' || e.type === 'boolean' ? e.type : 'string';
    const location: ActionParamLocation =
      e.in === 'body' || e.in === 'path' ? e.in : 'query';

    seen.add(name);
    out.push({
      name,
      type,
      description:
        typeof e.description === 'string' ? e.description.trim().slice(0, 300) : '',
      required: e.required === true,
      in: location,
    });

    if (out.length >= 12) break;
  }

  return out;
}

/** Build the tool schema the providers advertise for this action. */
export function actionToolDefinition(action: AgentAction): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of action.parameters) {
    properties[param.name] = {
      type: param.type,
      ...(param.description ? { description: param.description } : {}),
    };
    if (param.required) required.push(param.name);
  }

  return {
    name: action.name,
    description: action.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function coerce(value: unknown, type: ActionParamType): unknown {
  if (type === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface BuiltActionRequest {
  url: string;
  method: string;
  body?: string;
}

/**
 * Resolve declared parameters into a concrete request.
 *
 * `{placeholder}` segments in the configured URL are filled from `path`
 * parameters with `encodeURIComponent`, so a value cannot escape its
 * segment. Unfilled placeholders are an error, not a literal `{id}` in
 * the outbound URL.
 */
export function buildActionRequest(
  action: AgentAction,
  args: Record<string, unknown>,
): BuiltActionRequest {
  const missing: string[] = [];
  const pathValues = new Map<string, string>();
  const queryValues: Array<[string, string]> = [];
  const bodyValues: Record<string, unknown> = {};

  for (const param of action.parameters) {
    const provided = args[param.name];
    const value = coerce(provided, param.type);

    if (value === null || value === '') {
      if (param.required) missing.push(param.name);
      continue;
    }

    if (param.in === 'path') {
      pathValues.set(param.name, String(value));
    } else if (param.in === 'body') {
      bodyValues[param.name] = value;
    } else {
      queryValues.push([param.name, String(value)]);
    }
  }

  if (missing.length > 0) {
    throw new AiError(
      `Missing required parameter(s): ${missing.join(', ')}.`,
      { code: 'action_missing_params', status: 400 },
    );
  }

  let url = action.url;
  const placeholders = url.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) ?? [];
  for (const placeholder of placeholders) {
    const key = placeholder.slice(1, -1);
    const value = pathValues.get(key);
    if (value === undefined) {
      throw new AiError(
        `The action URL needs a value for {${key}} but no such path parameter was provided.`,
        { code: 'action_missing_params', status: 400 },
      );
    }
    url = url.split(placeholder).join(encodeURIComponent(value));
  }

  if (queryValues.length > 0) {
    const target = new URL(url);
    for (const [key, value] of queryValues) {
      target.searchParams.set(key, value);
    }
    url = target.toString();
  }

  const method = action.method.toUpperCase();
  const sendsBody = method !== 'GET' && method !== 'DELETE';

  return {
    url,
    method,
    body:
      sendsBody && Object.keys(bodyValues).length > 0
        ? JSON.stringify(bodyValues)
        : undefined,
  };
}

export interface ActionRunResult {
  ok: boolean;
  status: number | null;
  detail: string;
}

/**
 * Call one action. Never throws for a remote failure — the model must
 * see "that lookup failed" as a tool result and reply gracefully, not
 * have the whole generation collapse.
 */
export async function runAction(
  action: AgentAction,
  args: Record<string, unknown>,
): Promise<ActionRunResult> {
  let request: BuiltActionRequest;
  try {
    request = buildActionRequest(action, args);
  } catch (err) {
    return {
      ok: false,
      status: null,
      detail: err instanceof Error ? err.message : 'Invalid parameters.',
    };
  }

  try {
    const res = await safeFetch({
      url: request.url,
      method: request.method,
      headers: action.headers,
      body: request.body,
      timeoutMs: action.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
    });

    const body = res.body.trim();
    const trimmed =
      body.length > MAX_RESULT_CHARS
        ? `${body.slice(0, MAX_RESULT_CHARS)}\n…(truncated)`
        : body;

    if (res.status >= 400) {
      return {
        ok: false,
        status: res.status,
        // The status is useful to the model ("that order id is unknown"),
        // the body less so — but a JSON error message often IS the answer.
        detail: `The request failed with HTTP ${res.status}.${trimmed ? `\n${trimmed}` : ''}`,
      };
    }

    return {
      ok: true,
      status: res.status,
      detail: trimmed || '(empty response)',
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      detail:
        err instanceof AiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The request failed.',
    };
  }
}
