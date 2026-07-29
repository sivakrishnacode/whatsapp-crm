import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The two credentials a web widget installation carries, and the origin
 * allowlist that decides who may use them.
 *
 * THE KEY IS PUBLIC, THE SECRET IS NOT
 *   `widget_key` ships inside a <script> tag on the customer's own
 *   website. Anyone who views source has it, and that is fine by
 *   design — it *locates* an account for the bootstrap endpoint and
 *   authorises nothing. Every endpoint that touches a conversation
 *   additionally requires a signed visitor session token.
 *
 *   `widget_secret` never leaves the server. It signs visitor session
 *   tokens and verifies identity-verification HMACs, and is stored
 *   AES-256-GCM encrypted like every other secret in this codebase.
 *
 * WHY THE ALLOWLIST DENIES WHEN EMPTY
 *   `automations.channels` uses empty-means-all, because an unscoped
 *   automation is the sane default. The opposite is true here: an empty
 *   allowlist that meant "any origin" would turn every freshly created
 *   account into an open relay for anonymous conversation creation
 *   before its owner had configured anything. Empty means deny.
 */

/** Prefix so a leaked key is identifiable in a log or a bug report. */
const WIDGET_KEY_PREFIX = 'wk_';

/**
 * 32 bytes of entropy, base64url-encoded. Long enough that the key is
 * not guessable even though it is public — a guessable key would let an
 * attacker enumerate which accounts exist.
 */
export function generateWidgetKey(): string {
  return `${WIDGET_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * 64 bytes, because this one is a real HMAC/signing key rather than an
 * identifier.
 */
export function generateWidgetSecret(): string {
  return randomBytes(64).toString('base64url');
}

/** Shape check only — says nothing about whether the key exists. */
export function looksLikeWidgetKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(WIDGET_KEY_PREFIX) &&
    value.length > WIDGET_KEY_PREFIX.length + 20 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(WIDGET_KEY_PREFIX.length))
  );
}

/**
 * Constant-time comparison, used when a key is checked against a value
 * we already hold. The DB lookup is by unique index and therefore not
 * timing-sensitive, but any secondary comparison (secret, HMAC digest)
 * must not leak position-of-first-difference.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself a leak of
  // one bit — unavoidable, and length is not the secret here.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Canonicalise an allowlist entry or a request Origin down to
 * `scheme://host[:port]`, lowercased, with a default port dropped.
 *
 * Users type `https://example.com/`, `example.com`, `HTTPS://Example.com:443`
 * and expect all three to mean the same thing. A raw string comparison against
 * `req.headers.origin` would reject two of them, and the resulting bug looks
 * like "the widget just doesn't work on my site".
 *
 * Returns null for anything unparseable or unattributable — callers must treat
 * that as a denial, never as a wildcard.
 */
export function normalizeOrigin(
  value: string | undefined | null,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // `null` is the literal string a browser sends for an OPAQUE origin — a
  // sandboxed iframe, a `file://` page, certain redirects. That is precisely
  // the case where a request cannot be attributed to any site, so it must
  // never become matchable. Mapping it to a pseudo-origin like `'file://'`
  // would let it match an allowlist entry, which inverts the meaning of an
  // opaque origin.
  if (trimmed === 'null') return null;

  // A bare host is the most common way a user types it. Loopback defaults to
  // http (nobody runs TLS on a dev server); everything else to https.
  let withScheme = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    withScheme = isLoopbackHost(trimmed.split(':')[0])
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  // Only web origins can embed an iframe. This is what stops `javascript:`,
  // `data:` and `file:` ever being stored as an allowed origin.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  const isDefaultPort =
    !url.port ||
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80');

  return isDefaultPort
    ? `${url.protocol}//${url.hostname.toLowerCase()}`
    : `${url.protocol}//${url.hostname.toLowerCase()}:${url.port}`;
}

/**
 * Exact loopback host check.
 *
 * Deliberately equality against a fixed set, NOT `host.includes('localhost')`.
 * A substring test admits `evil-localhost.com` and `localhost.attacker.net` —
 * the same lookalike-domain hole that makes `isOriginAllowed` an exact match
 * rather than a suffix one.
 */
function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower === '::1'
  );
}

/**
 * Whether loopback origins are trusted without being listed.
 *
 * Gated on an EXPLICIT opt-in rather than `NODE_ENV !== 'production'`.
 *
 *   `NODE_ENV` is routinely unset in production deployments, and
 *   `undefined !== 'production'` is true — so a "not production" test silently
 *   enables the development escape hatch on live servers. Requiring
 *   `NODE_ENV === 'development'`, or the explicit override, fails closed
 *   instead: an unset variable now means "not development".
 */
function localhostTrusted(): boolean {
  if (process.env.WEB_WIDGET_TRUST_LOCALHOST === 'true') return true;
  if (process.env.WEB_WIDGET_TRUST_LOCALHOST === 'false') return false;
  return process.env.NODE_ENV === 'development';
}

/**
 * Whether a request Origin is permitted by a stored allowlist.
 */
export function isOriginAllowed(
  requestOrigin: string | undefined | null,
  allowedOrigins: readonly string[],
): boolean {
  const origin = normalizeOrigin(requestOrigin);

  // A missing or opaque Origin is ALWAYS denied, in every environment.
  //
  // Browsers send Origin on every cross-origin request and the widget is
  // always cross-origin to this API, so an absent one means a non-browser
  // caller or a sandboxed frame — neither attributable to a site. Defaulting
  // it to localhost during development made every credential-less request
  // pass, which meant the allowlist did nothing while developing and the
  // first real deployment was the first time it was ever exercised.
  if (!origin) return false;

  // Explicit wildcard. An admin opting into "any site may embed" is a real
  // configuration for a customer serving from many dynamic subdomains, but it
  // makes the account an open relay for anonymous conversation creation — so
  // it is honoured only when literally stored, never inferred from an empty
  // list.
  if (allowedOrigins.includes('*')) return true;

  // Loopback, for local development. Needs the explicit opt-in AND a genuine
  // loopback Origin header; it is not a blanket allow.
  if (localhostTrusted() && isLoopbackHostFromOrigin(origin)) return true;

  // Empty DENIES — the inverse of automations.channels' empty-means-all. A
  // default-open allowlist would make every freshly created account reachable
  // before its owner had configured anything.
  if (allowedOrigins.length === 0) return false;

  // Exact match after normalisation: never suffix, never substring, never
  // wildcard-subdomain. `endsWith('example.com')` also admits
  // `evil-example.com`, and a `*.example.com` rule admits any subdomain an
  // attacker can get onto. The port is part of an origin and is compared as
  // such — localhost:3001 is not localhost:3000.
  return allowedOrigins.some((allowed) => {
    const normalized = normalizeOrigin(allowed);
    return normalized !== null && normalized === origin;
  });
}

/** Loopback check on an already-normalised origin. */
function isLoopbackHostFromOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Normalise and de-duplicate an allowlist on the way into the database,
 * dropping anything unparseable.
 *
 * Storing normalised values means `isOriginAllowed` compares like with
 * like even for rows written before that function existed, and the
 * settings UI can show the user exactly what will be matched rather
 * than what they typed.
 */
export function normalizeOriginList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOrigin(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}
