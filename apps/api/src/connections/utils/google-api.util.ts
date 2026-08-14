/**
 * The one way a connector talks to Google.
 *
 * WHY AN ALLOWLIST INSTEAD OF THE SSRF GUARD
 *   `common/security/ssrf.util.ts` exists for URLs a USER supplied — the
 *   automation `http_request` step, the AI page crawler. It resolves DNS
 *   and rejects private ranges, which is the right (and only possible)
 *   answer when the destination is arbitrary.
 *
 *   Connector URLs are not arbitrary. They are constants in our own
 *   source, so the stronger check is the cheaper one: the host must be
 *   on a fixed list. A connector that wants a host outside it does not
 *   get one, and the failure is a startup-visible throw rather than a
 *   DNS-dependent maybe.
 *
 * REDIRECTS ARE NOT FOLLOWED
 *   `redirect: 'manual'`. Google does not 3xx its API endpoints, so a
 *   redirect means something is wrong — a captive portal, a proxy, a
 *   misrouted host — and following it would send a bearer token
 *   somewhere unintended.
 *
 * THE RESPONSE IS BOUNDED
 *   A Sheets range or a Gmail thread can be large, and the whole body is
 *   about to be JSON-parsed into memory and published to
 *   `context.steps[<key>]`. Same cap and same reasoning as
 *   HTTP_MAX_RESPONSE_BYTES in automation-http.util.ts.
 */

const ALLOWED_HOSTS = new Set([
  'sheets.googleapis.com',
  'gmail.googleapis.com',
  'www.googleapis.com',
  'meet.googleapis.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  'accounts.google.com',
]);

export const GOOGLE_TIMEOUT_MS = 20_000;
export const GOOGLE_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * A Google API call that failed.
 *
 * `status` is preserved because the caller branches on it: 401 means the
 * token died mid-flight (re-auth), 403 usually means a missing scope or
 * a disabled API, 429 is a quota that a retry might clear.
 */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleRequestOptions {
  url: string;
  accessToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body. Serialised here so no caller sets content-type by hand. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function googleRequest<T = unknown>(
  options: GoogleRequestOptions,
): Promise<T> {
  const { url, accessToken, method = 'GET', body, query } = options;

  const target = new URL(url);
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    throw new GoogleApiError(
      `Refusing to call non-Google host ${target.hostname}`,
      0,
    );
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new GoogleApiError(
      aborted
        ? `Google did not respond within ${GOOGLE_TIMEOUT_MS / 1000}s`
        : `Could not reach Google: ${(err as Error).message}`,
      0,
    );
  }
  clearTimeout(timer);

  const text = await readBounded(res);

  if (!res.ok) {
    // Google's error envelope is {error: {message, status, details}}. The
    // message is the only part worth showing an automation author.
    let message = `Google returned ${res.status}`;
    let detail: unknown;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string;
        error_description?: string;
      };
      detail = parsed;
      if (typeof parsed.error === 'object' && parsed.error?.message) {
        message = parsed.error.message;
      } else if (parsed.error_description) {
        message = parsed.error_description;
      }
    } catch {
      if (text) detail = text.slice(0, 500);
    }
    throw new GoogleApiError(message, res.status, detail);
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleApiError('Google returned a non-JSON body', res.status);
  }
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > GOOGLE_MAX_RESPONSE_BYTES) {
      // Cancel rather than drain: there is no use for the rest, and a
      // large response should not hold a socket open while we discard it.
      await reader.cancel().catch(() => undefined);
      throw new GoogleApiError(
        `Google response exceeded ${GOOGLE_MAX_RESPONSE_BYTES} bytes`,
        res.status,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
