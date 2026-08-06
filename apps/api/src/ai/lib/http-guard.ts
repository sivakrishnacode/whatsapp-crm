import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AiError } from './types';

/**
 * ============================================================
 * Outbound fetch guard for URLs a USER supplied.
 *
 * Two features in this module hand the server a URL and ask it to make a
 * request: crawling a page into the knowledge base, and custom API
 * actions the agent can call. Both are server-side fetches with the
 * server's own network position, which is the textbook shape of SSRF —
 * without this guard, "crawl http://localhost:8001/ai/config" or
 * "http://169.254.169.254/latest/meta-data/iam/…" is a feature.
 *
 * What is enforced:
 *   - http/https only (no file:, gopher:, data:, ftp:)
 *   - no credentials in the URL (they would leak into logs and, on a
 *     redirect, to a third party)
 *   - every resolved address must be publicly routable: loopback,
 *     private, link-local (incl. cloud metadata), CGNAT, multicast,
 *     unspecified and IPv6 ULA are all refused
 *   - redirects are followed MANUALLY, at most 3, re-validating the host
 *     each hop — a public URL that 302s to 127.0.0.1 is the standard
 *     bypass
 *   - responses are read with a byte cap, so a multi-gigabyte body
 *     cannot exhaust memory
 *
 * KNOWN RESIDUAL RISK: DNS rebinding. We validate the addresses a
 * hostname resolves to, then let undici resolve it again when it
 * connects, so a TTL-0 record that flips between a public and a private
 * address in that window can slip through. Closing it properly means
 * pinning the connection to the validated IP (a custom dispatcher with a
 * `Host` header override), which is a bigger change than this module;
 * the exposure is one request to an internal HTTP endpoint whose
 * response body is then treated as untrusted document text, never as
 * credentials or instructions.
 * ============================================================
 */

const MAX_REDIRECTS = 3;

export interface SafeFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Sent as-is; callers pick something honest and identifiable. */
  userAgent?: string;
  /** Accept header, e.g. `text/html` for the crawler. */
  accept?: string;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  /** Decoded body, truncated at `maxBytes`. */
  body: string;
  truncated: boolean;
  /** Final URL after redirects. */
  url: string;
}

function ipv4IsBlocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function ipv6IsBlocked(raw: string): boolean {
  const ip = raw.toLowerCase().split('%')[0];
  if (ip === '::' || ip === '::1') return true; // unspecified, loopback
  // IPv4-mapped (::ffff:127.0.0.1) and 6to4-ish embeddings: judge the
  // embedded v4 address, which is what the packet ultimately reaches.
  const mapped = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return ipv4IsBlocked(mapped[1]);
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
  if (ip.startsWith('ff')) return true; // multicast
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsBlocked(ip);
  if (version === 6) return ipv6IsBlocked(ip);
  return true; // not an IP literal at all — refuse rather than guess
}

/**
 * Validate one URL: shape, scheme, credentials, and every address its
 * hostname resolves to. Exported for tests and for the "is this URL
 * usable" check the actions UI runs before saving.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiError(`Not a valid URL: ${raw}`, {
      code: 'invalid_url',
      status: 400,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiError(
      `Only http and https URLs are allowed (got ${url.protocol.replace(':', '')}).`,
      { code: 'invalid_url_scheme', status: 400 },
    );
  }

  if (url.username || url.password) {
    throw new AiError(
      'Remove the username/password from the URL — put credentials in a header instead.',
      { code: 'invalid_url_credentials', status: 400 },
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new AiError(
        `${host} is a private or reserved address — only public hosts can be reached.`,
        { code: 'blocked_address', status: 400 },
      );
    }
    return url;
  }

  // `.localhost`, `.local` and friends resolve differently per host; refuse
  // by name as well as by address so the intent is obvious in the error.
  if (/(^|\.)(localhost|local|internal|intranet|home\.arpa)$/i.test(host)) {
    throw new AiError(`${host} is an internal hostname and cannot be reached.`, {
      code: 'blocked_address',
      status: 400,
    });
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new AiError(`Could not resolve ${host}.`, {
      code: 'dns_failed',
      status: 400,
    });
  }

  if (addresses.length === 0) {
    throw new AiError(`Could not resolve ${host}.`, {
      code: 'dns_failed',
      status: 400,
    });
  }

  // EVERY address must be public: a host with one public and one private
  // A record would otherwise be a coin toss at connect time.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new AiError(
        `${host} resolves to a private address (${address}) and cannot be reached.`,
        { code: 'blocked_address', status: 400 },
      );
    }
  }

  return url;
}

/** Read a response body with a hard byte cap. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: '', truncated: false };

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
      if (total > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Stop the transfer as soon as the cap is hit — without this the
    // remote keeps streaming into a socket nobody is draining.
    await reader.cancel().catch(() => undefined);
  }

  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { body: merged.toString('utf8'), truncated };
}

/**
 * Fetch a user-supplied URL with every guard above applied.
 * Throws `AiError` for anything refused; HTTP error statuses are
 * returned to the caller, not thrown (an action may legitimately want
 * to see a 404).
 */
export async function safeFetch(
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 8000,
    maxBytes = 512 * 1024,
    userAgent = 'Converse360-Agent/1.0 (+https://converse360.io)',
    accept,
  } = opts;

  let target = await assertPublicUrl(opts.url);
  let redirects = 0;

  for (;;) {
    const requestHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      ...(accept ? { Accept: accept } : {}),
      ...headers,
    };
    if (body !== undefined && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(target, {
        method,
        headers: requestHeaders,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new AiError(`${target.host} took too long to respond.`, {
          code: 'timeout',
          status: 504,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AiError(`Could not reach ${target.host}: ${message}`, {
        code: 'network_error',
        status: 502,
      });
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) {
        throw new AiError(`${opts.url} redirected too many times.`, {
          code: 'too_many_redirects',
          status: 400,
        });
      }
      redirects += 1;
      // Re-validate: this is the hop that a public → 127.0.0.1 redirect
      // uses, and it is the whole reason redirect: 'manual' is here.
      target = await assertPublicUrl(new URL(location, target).toString());
      continue;
    }

    const { body: text, truncated } = await readCapped(res, maxBytes);
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: text,
      truncated,
      url: target.toString(),
    };
  }
}
