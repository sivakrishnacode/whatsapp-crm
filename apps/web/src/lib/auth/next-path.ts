/** Where a sign-in lands when no destination was requested. */
export const DEFAULT_POST_AUTH_PATH = '/dashboard'

/**
 * Narrow an untrusted `?next=` value to a same-origin path.
 *
 * The OAuth callback reads this straight out of the query string, so it
 * is attacker-controlled: a phishing link of the form
 * `/login?next=https://evil.example` would otherwise hand someone a
 * genuine sign-in followed by a redirect off-site, with our domain in
 * the referrer.
 *
 * Rejected:
 *   - absolute URLs (`https://evil.example`)
 *   - protocol-relative URLs (`//evil.example`) — these are the ones a
 *     naive `startsWith('/')` check waves through
 *   - backslash variants (`/\evil.example`), which some browsers
 *     normalise to `//`
 *   - anything not starting with `/`
 */
export function sanitizeNextPath(
  next: string | null | undefined,
  fallback: string = DEFAULT_POST_AUTH_PATH,
): string {
  if (!next) return fallback
  if (!next.startsWith('/')) return fallback
  // Second character decides: `//host` and `/\host` both escape the origin.
  if (next[1] === '/' || next[1] === '\\') return fallback
  return next
}
