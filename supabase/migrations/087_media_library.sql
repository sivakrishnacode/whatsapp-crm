-- ============================================================
-- 087_media_library.sql — one place for a workspace's files.
--
-- Until now every upload was fire-and-forget: the browser pushed a file
-- into a bucket, kept the URL on whatever row it was editing, and forgot
-- it. Nothing recorded what had been uploaded, so the same logo was
-- re-uploaded for every flow node, nobody could find a file again, and
-- "how much are we storing?" had no answer short of listing every object
-- in every bucket.
--
-- `media_assets` is that record. The bytes still live in Storage — this
-- is an index over them, not a copy.
--
-- ⚠️ WHY A TABLE AND NOT JUST LISTING THE BUCKET
--   `storage.objects` can be listed, and that was the cheaper option
--   considered. It cannot answer the four things the library is FOR:
--   search by name across kinds, "recently used" (nothing in Storage
--   records a use), one total across buckets, and a delete that removes
--   the row and the object together. A listing also pages, so search
--   would only ever cover whatever page happened to be loaded.
--
-- ⚠️ THE ROW CAN OUTLIVE THE OBJECT, AND THAT IS FINE.
--   Storage deletes are a separate API call from this table's DELETE, so
--   a half-failed delete leaves one or the other behind. The library
--   tolerates a row whose object is gone (it renders a broken thumbnail
--   the user can delete) because the opposite — a bucket full of objects
--   no row mentions — is the state that is genuinely unrecoverable.
-- ============================================================

-- ============================================================
-- 1. The bucket
-- ============================================================
--
-- Its own bucket rather than a folder in flow-media or chat-media, for
-- the reason 058 spells out: the write policies match on the FIRST path
-- segment, so a `library/account-<id>/…` prefix is rejected outright.
-- A separate bucket also keeps size and retention policy independent —
-- library files are long-lived by definition, chat attachments are not.
--
-- MIME list is the union of what the four call sites need: WhatsApp
-- media (images, video, audio, PDF/Office documents) plus the voice-note
-- formats. Deliberately wider than template-media (which is narrowed to
-- what Meta accepts as a template header) because this bucket also feeds
-- the inbox composer.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media-library',
  'media-library',
  TRUE,
  16777216, -- 16 MB — matches flow-media/chat-media and Meta's video cap
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/3gpp',
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/amr', 'audio/webm',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read: these URLs are what Meta fetches at send time, and an
-- authenticated URL is unreachable to it. Same call as 016/023/058.
DROP POLICY IF EXISTS "Library media is publicly readable" ON storage.objects;
CREATE POLICY "Library media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'media-library');

DROP POLICY IF EXISTS "Members can upload library media" ON storage.objects;
CREATE POLICY "Members can upload library media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'media-library'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update library media" ON storage.objects;
CREATE POLICY "Members can update library media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'media-library'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete library media" ON storage.objects;
CREATE POLICY "Members can delete library media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'media-library'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 2. media_assets — the index
-- ============================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Who uploaded it. NULL-able and ON DELETE SET NULL: a departed
  -- teammate's files belong to the workspace, not to their user row.
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Which bucket the object is in. Recorded rather than assumed, so a
  -- future migration can index the older buckets into the same library
  -- without a second table.
  bucket TEXT NOT NULL DEFAULT 'media-library',
  -- Object path inside the bucket (`account-<id>/<ts>-<name>.<ext>`).
  path TEXT NOT NULL,
  -- Public URL. Denormalised on purpose: every consumer needs it, and
  -- rebuilding it means knowing the Supabase project URL in SQL.
  url TEXT NOT NULL,

  -- Display name. Editable, unlike `path` — renaming a file must not
  -- move the object out from under every row already pointing at it.
  filename TEXT NOT NULL,
  -- The four tabs in the picker. Derived from mime_type at upload.
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,

  -- Drives the "Recently used" row. Distinct from created_at: the point
  -- of the section is what you reach for often, not what you uploaded
  -- last.
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per object. Makes the "upload, then record" pair idempotent:
  -- a retried write updates instead of creating a duplicate entry for a
  -- file the user only uploaded once.
  UNIQUE (bucket, path)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_account_created
  ON public.media_assets (account_id, created_at DESC);
-- Partial: only rows that have actually been used are read this way.
CREATE INDEX IF NOT EXISTS idx_media_assets_account_used
  ON public.media_assets (account_id, last_used_at DESC)
  WHERE last_used_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_account_kind
  ON public.media_assets (account_id, kind);

COMMENT ON TABLE public.media_assets IS
  'Index over uploaded files (bytes live in Storage). Written from the browser under RLS, like the buckets it describes.';

-- ============================================================
-- 3. RLS — account-scoped, browser-written
-- ============================================================
--
-- ⚠️ UNLIKE app_connections, THIS TABLE *WANTS* BROWSER POLICIES.
--   It holds no credential — a filename, a size and a URL that is
--   already public — and the library reads and writes it directly from
--   the browser through PostgREST, the same way the buckets it indexes
--   are written. A row is only ever as sensitive as the object it names.
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their account's media" ON public.media_assets;
CREATE POLICY "Members read their account's media"
  ON public.media_assets FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.account_id = media_assets.account_id
    )
  );

DROP POLICY IF EXISTS "Members add media to their account" ON public.media_assets;
CREATE POLICY "Members add media to their account"
  ON public.media_assets FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.account_id = media_assets.account_id
    )
  );

-- UPDATE covers the rename and the last_used_at touch.
DROP POLICY IF EXISTS "Members update their account's media" ON public.media_assets;
CREATE POLICY "Members update their account's media"
  ON public.media_assets FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.account_id = media_assets.account_id
    )
  );

DROP POLICY IF EXISTS "Members delete their account's media" ON public.media_assets;
CREATE POLICY "Members delete their account's media"
  ON public.media_assets FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.account_id = media_assets.account_id
    )
  );
