import {
  deleteAccountMedia,
  uploadAccountMedia,
  type UploadAccountMediaResult,
} from '@/lib/storage/upload-media';

/**
 * Workspace-logo uploads (migration 071).
 *
 * The bytes go straight from the browser to Supabase Storage — the same
 * route user avatars, flow media and chat media already take — and only
 * the resulting public URL is sent to the API. The bucket's RLS policy
 * is what authorises the write (account-scoped folder, admin+ only), and
 * `PATCH /account` re-checks the role before persisting the URL.
 *
 * Two callers: the settings card and the signup wizard's first step.
 * They validate identically because a file the bucket rejects produces a
 * useless 400 from Storage, and a customer reading it has no idea which
 * of the two limits they hit.
 */

/** Bucket from migration 071. */
export const WORKSPACE_LOGO_BUCKET = 'workspace-logos';

/** Must match the bucket's `file_size_limit`. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Must match the bucket's `allowed_mime_types`. SVG is deliberately
 * absent — see the migration for why.
 */
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** For the file input's `accept`, so the OS picker filters too. */
export const LOGO_ACCEPT = LOGO_MIME_TYPES.join(',');

/**
 * Returns a message to show the user, or null when the file is fine.
 * Checked before upload so the error names the real limit instead of
 * Storage's generic rejection.
 */
export function validateLogoFile(file: File): string | null {
  if (!LOGO_MIME_TYPES.includes(file.type)) {
    return 'Logo must be a PNG, JPEG or WebP image.';
  }
  if (file.size > LOGO_MAX_BYTES) {
    return `Logo must be under ${Math.round(LOGO_MAX_BYTES / 1024 / 1024)} MB.`;
  }
  return null;
}

/**
 * Upload a logo and return its public URL + storage path.
 *
 * Throws with a user-facing message; callers surface it via a toast.
 */
export function uploadWorkspaceLogo(
  accountId: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  return uploadAccountMedia(WORKSPACE_LOGO_BUCKET, accountId, file);
}

/**
 * Recover the storage path from a stored public URL, so replacing a logo
 * can clean up the object it replaces. Returns null for a URL that isn't
 * one of ours (an older row, a hand-edited value) — a caller must then
 * simply skip the delete rather than guess.
 */
export function logoPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/${WORKSPACE_LOGO_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const path = url.slice(at + marker.length);
  return path.length > 0 ? decodeURIComponent(path) : null;
}

/**
 * Best-effort removal of a replaced logo. Never throws: the new logo is
 * already saved by this point, and an orphaned object is a storage nit,
 * not something to fail a save over or put in front of the user.
 */
export async function discardWorkspaceLogo(
  url: string | null | undefined,
): Promise<void> {
  const path = logoPathFromUrl(url);
  if (!path) return;
  try {
    await deleteAccountMedia(WORKSPACE_LOGO_BUCKET, path);
  } catch {
    // Intentionally swallowed — see above.
  }
}
