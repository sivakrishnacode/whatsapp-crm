/**
 * Validation for `accounts.logo_url` (migration 071).
 *
 * The bytes never pass through this API: the browser uploads straight to
 * the `workspace-logos` Storage bucket — gated by that bucket's
 * account-scoped, admin-only RLS policy — and then sends us the public
 * URL to persist. That split is what this file exists to make safe.
 *
 * WHY THE URL IS PINNED TO OUR OWN BUCKET RATHER THAN MERELY BEING https
 *   The logo renders in the header of every teammate's browser. An
 *   arbitrary URL would therefore be a beacon: one admin could point it
 *   at a host they control and collect an IP and a User-Agent from every
 *   colleague, on every page load, for as long as nobody noticed. It
 *   would also be a mixed-content and availability liability. Accepting
 *   only objects in this project's own public bucket removes the whole
 *   class — the field stops being "a URL we render" and becomes "a
 *   pointer to a file we already accepted".
 *
 * Fails closed: with SUPABASE_URL unset there is no prefix to check
 * against, so nothing is accepted.
 */

/** Bucket created by migration 071. */
export const WORKSPACE_LOGO_BUCKET = 'workspace-logos';

/**
 * Generous cap. A real URL here is ~120 chars (project host + bucket +
 * `account-<uuid>/logo-<ts>.<ext>`); this only stops someone stuffing
 * the column with a data: blob.
 */
export const MAX_LOGO_URL_LEN = 512;

/** Thrown with a message meant for the person in the settings form. */
export class InvalidWorkspaceLogoError extends Error {}

/**
 * `https://<project>.supabase.co/storage/v1/object/public/workspace-logos/`
 *
 * `supabaseUrl` is passed in rather than defaulted to
 * `process.env.SUPABASE_URL`: a default parameter is skipped when the
 * argument is `undefined`, so a test asserting the unset case would
 * silently exercise the ambient env instead — which is exactly how the
 * fail-closed behaviour would rot without anyone noticing.
 */
export function workspaceLogoPrefix(
  supabaseUrl: string | undefined,
): string | null {
  if (!supabaseUrl) return null;
  // Tolerate a configured trailing slash rather than producing a `//`
  // prefix that nothing would ever match.
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${WORKSPACE_LOGO_BUCKET}/`;
}

/**
 * Narrow an untrusted `logo_url` from a request body.
 *
 * Returns `null` for an explicit clear (`null` or an empty string) —
 * "remove my logo" and "set my logo" are the same field, so the caller
 * distinguishes them by whether the key was present at all, not by the
 * return value here.
 *
 * `accountId` comes from the authenticated context, never the body: the
 * object must sit under this caller's own `account-<id>/` folder. The
 * bucket is public, so pointing at a neighbour's object leaks nothing
 * they had not already published — but it would let one tenant's chrome
 * silently depend on another tenant's file, which breaks the moment they
 * replace it. Scope it and the question never arises.
 *
 * @throws InvalidWorkspaceLogoError when the value is present but not a
 *         URL we are willing to store.
 */
export function normalizeWorkspaceLogoUrl(
  value: unknown,
  accountId: string,
  supabaseUrl: string | undefined,
): string | null {
  if (value === null) return null;

  if (typeof value !== 'string') {
    throw new InvalidWorkspaceLogoError("'logo_url' must be a string or null");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_LOGO_URL_LEN) {
    throw new InvalidWorkspaceLogoError(
      `'logo_url' must be ${MAX_LOGO_URL_LEN} characters or fewer`,
    );
  }

  const prefix = workspaceLogoPrefix(supabaseUrl);
  if (!prefix) {
    throw new InvalidWorkspaceLogoError(
      'Logo uploads are not configured on this server',
    );
  }

  // Parse before comparing: a bare prefix match on a string would accept
  // `https://evil.test/?x=<prefix>` under some concatenations, and it
  // gives us a cheap reject for anything that is not a URL at all.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidWorkspaceLogoError("'logo_url' must be a valid URL");
  }

  if (parsed.protocol !== 'https:') {
    throw new InvalidWorkspaceLogoError("'logo_url' must be served over https");
  }

  // `parsed.href` rather than the raw string so percent-encoding and a
  // default port are normalised the same way on both sides.
  if (!parsed.href.startsWith(prefix)) {
    throw new InvalidWorkspaceLogoError(
      'Logo must be uploaded to this workspace before it can be saved',
    );
  }

  // The object path must open with this account's own folder — the same
  // `account-<uuid>/` segment the bucket's RLS policy matched on when it
  // allowed the upload. A trailing `/` in the test is what stops
  // `account-<id>evil/` passing as `account-<id>`.
  const objectPath = parsed.href.slice(prefix.length);
  if (!objectPath.startsWith(`account-${accountId}/`)) {
    throw new InvalidWorkspaceLogoError(
      'Logo must be uploaded to this workspace before it can be saved',
    );
  }

  // A folder is not a file.
  if (objectPath.endsWith('/')) {
    throw new InvalidWorkspaceLogoError("'logo_url' does not point to a file");
  }

  return parsed.href;
}
