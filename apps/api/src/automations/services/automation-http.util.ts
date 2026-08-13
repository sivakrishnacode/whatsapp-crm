import { isDeliverableUrl } from '../../common/security/ssrf.util';
import { interpolate, interpolateDeep } from './automation-interpolation.util';
import type { AutomationContext, SendWebhookStepConfig } from '../automation.types';

/**
 * Builds and performs the request behind `send_webhook` / `http_request`.
 *
 * SEPARATE FROM THE EXECUTOR ON PURPOSE
 *   Assembling the request is where the interesting decisions are (units,
 *   escaping, what counts as an error) and it is pure apart from the one
 *   fetch — so it can be tested without a database, a queue or a Nest
 *   context. The executor keeps the parts that need those.
 */

/**
 * Bounds on the caller-supplied timeout.
 *
 * A step is holding a queue worker while it waits, so an unbounded
 * timeout is one slow third party away from stalling every automation in
 * the workspace. 30s is already generous for a webhook.
 */
export const HTTP_TIMEOUT_BOUNDS = { minMs: 1_000, maxMs: 30_000, defaultMs: 10_000 };

/** Response bytes we will read. Beyond this the body is truncated and
 *  flagged — a step that fetches a 500MB file must not take the process
 *  down with it. */
export const HTTP_MAX_RESPONSE_BYTES = 256 * 1024;

export interface HttpStepOutput {
  status: number;
  ok: boolean;
  /** Parsed JSON when the response says JSON, otherwise the raw text. */
  body: unknown;
  headers: Record<string, string>;
  /** True when the body hit HTTP_MAX_RESPONSE_BYTES and was cut short. */
  truncated: boolean;
  /** Milliseconds, for the log line. */
  duration_ms: number;
}

export class HttpStepError extends Error {
  constructor(
    message: string,
    readonly output?: HttpStepOutput,
  ) {
    super(message);
    this.name = 'HttpStepError';
  }
}

/**
 * Resolve the config into an actual request and perform it.
 *
 * Throws `HttpStepError` for a blocked destination, a transport failure
 * or (unless `ignore_http_errors`) a non-2xx response. The error carries
 * the output when there was one, so a `continue`-on-error step can still
 * publish `steps.<key>.status` for a later condition to read.
 */
export async function performHttpStep(
  cfg: SendWebhookStepConfig,
  context: AutomationContext | undefined,
): Promise<HttpStepOutput> {
  const url = buildUrl(cfg, context);

  // SSRF guard. The URL is account-controlled and OUR server makes the
  // request, so anything resolving to a private / loopback / link-local /
  // reserved address is refused. Checked AFTER interpolation because the
  // host itself can come from a variable.
  if (!(await isDeliverableUrl(url))) {
    throw new HttpStepError(`destination not allowed: ${redactUrl(url)}`);
  }

  const method = (cfg.method ?? 'POST').toUpperCase();
  const { body, contentType } = buildBody(cfg, context, method);

  const headers: Record<string, string> = {};
  // Caller headers first so the auth block below cannot be overridden by
  // a stray "Authorization" in the headers map — the auth field is the
  // more specific statement of intent.
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    if (!k.trim()) continue;
    headers[k.trim()] = interpolate(String(v ?? ''), context);
  }
  if (contentType && !hasHeader(headers, 'content-type')) {
    headers['content-type'] = contentType;
  }
  applyAuth(headers, cfg, context);

  const timeoutMs = clampTimeout(cfg.timeout_seconds);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, defeating the guard above.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortSignal.timeout produces a TimeoutError whose message is not
    // obviously about us; say which limit was hit.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    throw new HttpStepError(
      isTimeout ? `request timed out after ${timeoutMs}ms` : `request failed: ${msg}`,
    );
  }

  const output = await readResponse(res, startedAt);

  if (!output.ok && !cfg.ignore_http_errors) {
    throw new HttpStepError(`returned ${output.status}`, output);
  }
  return output;
}

/** URL with its query parameters interpolated and appended. */
function buildUrl(
  cfg: SendWebhookStepConfig,
  context: AutomationContext | undefined,
): string {
  const base = interpolate(String(cfg.url ?? ''), context).trim();
  const entries = Object.entries(cfg.query ?? {}).filter(([k]) => k.trim());
  if (entries.length === 0) return base;

  // Built with URL so an existing query string on the base is preserved
  // and every value is escaped exactly once. A malformed base is left
  // alone rather than mangled — the SSRF guard will reject it next.
  try {
    const u = new URL(base);
    for (const [k, v] of entries) {
      u.searchParams.set(
        interpolate(k, context),
        interpolate(String(v ?? ''), context),
      );
    }
    return u.toString();
  } catch {
    return base;
  }
}

function buildBody(
  cfg: SendWebhookStepConfig,
  context: AutomationContext | undefined,
  method: string,
): { body: string | undefined; contentType?: string } {
  // GET and DELETE with a body are legal-ish and widely mishandled;
  // more importantly, nobody means to send one.
  if (method === 'GET' || method === 'DELETE') return { body: undefined };

  const mode = cfg.body_mode ?? (cfg.body_template ? 'raw' : 'json');

  if (mode === 'none') return { body: undefined };

  if (mode === 'raw') {
    // The historical behaviour, preserved exactly: no template means the
    // whole context as JSON. Automations relying on that still work.
    const raw = cfg.body_template
      ? interpolate(cfg.body_template, context)
      : JSON.stringify(contextForBody(context));
    return { body: raw, contentType: 'application/json' };
  }

  if (mode === 'form') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(cfg.body_fields ?? {})) {
      if (!k.trim()) continue;
      const resolved = interpolateDeep(v, context);
      params.set(
        interpolate(k, context),
        typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? ''),
      );
    }
    return {
      body: params.toString(),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  // json — the default for new steps. interpolateDeep resolves every
  // value in place, and a value that is a lone token keeps its type, so
  // `{"qty": "{{ vars.count }}"}` posts a number rather than a string.
  const payload = interpolateDeep(cfg.body_fields ?? {}, context);
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}

/**
 * The context as a webhook payload.
 *
 * `steps` is deliberately included — it is the run's accumulated data and
 * the most useful thing a "send me everything" webhook could carry.
 */
function contextForBody(context: AutomationContext | undefined): unknown {
  return context ?? {};
}

function applyAuth(
  headers: Record<string, string>,
  cfg: SendWebhookStepConfig,
  context: AutomationContext | undefined,
): void {
  const auth = cfg.auth;
  if (!auth || auth.type === 'none') return;
  const fill = (v: string) => interpolate(String(v ?? ''), context);

  if (auth.type === 'bearer') {
    headers['authorization'] = `Bearer ${fill(auth.token)}`;
    return;
  }
  if (auth.type === 'basic') {
    const pair = `${fill(auth.username)}:${fill(auth.password)}`;
    headers['authorization'] = `Basic ${Buffer.from(pair).toString('base64')}`;
    return;
  }
  if (auth.type === 'header' && auth.name?.trim()) {
    headers[auth.name.trim()] = fill(auth.value);
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function clampTimeout(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return HTTP_TIMEOUT_BOUNDS.defaultMs;
  }
  return Math.min(
    HTTP_TIMEOUT_BOUNDS.maxMs,
    Math.max(HTTP_TIMEOUT_BOUNDS.minMs, Math.round(seconds * 1000)),
  );
}

async function readResponse(
  res: Response,
  startedAt: number,
): Promise<HttpStepOutput> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    // Response headers land in the run context, which is persisted on a
    // wait and rendered in the logs UI. Cookies are credentials and have
    // no business in either.
    if (key.toLowerCase() === 'set-cookie') return;
    headers[key.toLowerCase()] = value;
  });

  const { text, truncated } = await readBounded(res);
  const isJson = (headers['content-type'] ?? '').includes('json');
  let body: unknown = text;
  if (isJson && text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Server said JSON and sent something else. The text is more
      // useful to the author than an exception.
      body = text;
    }
  }

  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    body,
    headers,
    truncated,
    duration_ms: Date.now() - startedAt,
  };
}

/** Read at most HTTP_MAX_RESPONSE_BYTES, streaming so an enormous body is
 *  never fully buffered. */
async function readBounded(
  res: Response,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text().catch(() => '');
    return {
      text: text.slice(0, HTTP_MAX_RESPONSE_BYTES),
      truncated: text.length > HTTP_MAX_RESPONSE_BYTES,
    };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > HTTP_MAX_RESPONSE_BYTES) {
        chunks.push(
          value.slice(0, value.byteLength - (total - HTTP_MAX_RESPONSE_BYTES)),
        );
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(
    chunks.reduce((n, c) => n + c.byteLength, 0),
  );
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * A URL safe to put in a log line: credentials and query values stripped.
 *
 * Automation logs are readable by every member of the workspace, and an
 * API key pasted into a query string is exactly the kind of thing that
 * ends up there.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) {
      u.searchParams.set(key, '…');
    }
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}
