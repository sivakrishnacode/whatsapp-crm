'use client';

/**
 * The media library's data layer — `media_assets` (migration 087) plus
 * the `media-library` bucket.
 *
 * Reads and writes go straight to PostgREST/Storage from the browser,
 * scoped by RLS, exactly like every other bucket in this app. There is
 * no API endpoint for this and there should not be: the table holds a
 * filename, a size and a URL that is already public, so an API hop would
 * add a round trip and no authorization the policies don't already do.
 *
 * ⚠️ UPLOAD IS TWO WRITES, AND THEY CAN HALF-FAIL.
 *   The object goes to Storage, then a row records it. If the row fails
 *   the object is orphaned — invisible in the library but still costing
 *   space — so `uploadToLibrary` deletes the object it just wrote when
 *   the row fails. The reverse (a row whose object is gone) is left
 *   alone deliberately: the library renders it as broken and the user
 *   can delete it, whereas an object nothing references is unfindable.
 */

import { createClient } from '@/lib/supabase/client';
import { buildMediaPath } from '@/lib/storage/upload-media';

export const LIBRARY_BUCKET = 'media-library';

/** 16 MB — the bucket's own `file_size_limit` (migration 087). */
export const LIBRARY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The meter's ceiling. Advisory only — nothing enforces it, and the
 * bucket does not know about it. When a real per-plan cap arrives it
 * belongs in `subscription_plans` behind `check_account_limit`, not
 * here. Until then this is honestly just "a generous number to measure
 * against", which is why the UI phrases it as "of 1 GB" and never
 * blocks an upload.
 */
export const LIBRARY_SOFT_QUOTA_BYTES = 1024 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaAsset {
  id: string;
  account_id: string;
  bucket: string;
  path: string;
  url: string;
  filename: string;
  kind: MediaKind;
  mime_type: string | null;
  size_bytes: number;
  last_used_at: string | null;
  created_at: string;
}

/**
 * Map a MIME type to one of the picker's four tabs.
 *
 * Everything that is not audio/video/image is a "file" — including the
 * types we have no icon for. A fifth "other" bucket would be a tab
 * nobody clicks.
 */
export function kindForMime(mime: string | null | undefined): MediaKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Human-readable size. Bytes are unhelpful past about a kilobyte. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, i);
  // One decimal below 10, none above — "1.4 MB", "240 KB".
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * ⚠️ REMOVED, deliberately. This resolved the caller's workspace from
 * `profiles.account_id`, a column migration 096 dropped — and, more to the
 * point, a question that no longer has one answer. The active workspace is
 * resolved server-side (apps/api's active-workspace.ts) and reaches components
 * as `useAuth().accountId`; this module takes it as a parameter rather than
 * inventing a second resolver that could disagree. See lib/workspace/scope.ts.
 */

/** Every asset for one workspace, newest first. */
export async function listLibrary(accountId: string): Promise<MediaAsset[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('media_assets')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    ...(row as MediaAsset),
    // BIGINT arrives as a string through PostgREST; every consumer of
    // this does arithmetic on it.
    size_bytes: Number((row as { size_bytes: unknown }).size_bytes ?? 0),
  }));
}

/**
 * Upload a file and record it. Returns the new asset.
 *
 * `upsert: false` on the object plus the table's UNIQUE (bucket, path)
 * make this safe to retry: the path carries a timestamp, so a genuine
 * retry writes a new object rather than silently overwriting one another
 * row already points at.
 */
export async function uploadToLibrary(
  accountId: string,
  file: File
): Promise<MediaAsset> {
  if (file.size > LIBRARY_MAX_BYTES) {
    throw new Error(
      `${file.name} is larger than the ${formatBytes(LIBRARY_MAX_BYTES)} limit.`
    );
  }

  const supabase = createClient();
  const path = buildMediaPath(accountId, file.name);

  const { error: upErr } = await supabase.storage
    .from(LIBRARY_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    });
  if (upErr) throw new Error(upErr.message);

  const {
    data: { publicUrl },
  } = supabase.storage.from(LIBRARY_BUCKET).getPublicUrl(path);

  const { data, error } = await supabase
    .from('media_assets')
    .insert({
      account_id: accountId,
      bucket: LIBRARY_BUCKET,
      path,
      url: publicUrl,
      filename: file.name,
      kind: kindForMime(file.type),
      mime_type: file.type || null,
      size_bytes: file.size,
    })
    .select()
    .single();

  if (error) {
    // Don't leave an object nothing points at — see the header.
    await supabase.storage
      .from(LIBRARY_BUCKET)
      .remove([path])
      .catch(() => undefined);
    throw new Error(error.message);
  }

  return { ...(data as MediaAsset), size_bytes: file.size };
}

/**
 * Remove an asset: the row first, then the object.
 *
 * Row first because it is the thing the user sees. If the object delete
 * then fails, the result is an orphaned object (invisible, costs space)
 * rather than a library entry that renders forever and refuses to die.
 */
export async function deleteAsset(asset: MediaAsset): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase
    .from('media_assets')
    .delete()
    .eq('id', asset.id);
  if (error) throw new Error(error.message);

  await supabase.storage
    .from(asset.bucket)
    .remove([asset.path])
    .catch(() => undefined);
}

/**
 * Record that an asset was just used, which is what "Recently used"
 * reads.
 *
 * Fire-and-forget: picking a file must not fail because a bookkeeping
 * write did, and the value is a nicety rather than something anything
 * depends on.
 */
export function touchAsset(assetId: string): void {
  const supabase = createClient();
  void supabase
    .from('media_assets')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', assetId)
    .then(() => undefined);
}

/** Rename. `path` is untouched — see the column comment in 087. */
export async function renameAsset(
  assetId: string,
  filename: string
): Promise<void> {
  const supabase = createClient();
  const clean = filename.trim();
  if (!clean) throw new Error('Name cannot be empty.');
  const { error } = await supabase
    .from('media_assets')
    .update({ filename: clean })
    .eq('id', assetId);
  if (error) throw new Error(error.message);
}
