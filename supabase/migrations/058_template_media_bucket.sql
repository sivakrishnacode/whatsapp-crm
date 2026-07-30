-- ============================================================
-- 058_template_media_bucket.sql — dedicated storage for message-template
-- header and carousel-card media.
--
-- WHY NOT A FOLDER INSIDE chat-media
--   That was the first instinct, and it does not work: the chat-media
--   write policy (023) matches `(storage.foldername(name))[1]` against
--   `account-<account_id>`, so the FIRST path segment is load-bearing.
--   A `templates/account-<id>/…` prefix is rejected by RLS, and an
--   `account-<id>/templates/…` prefix would satisfy RLS but leaves
--   template media inside the same bucket as customer chat attachments —
--   which is the thing worth separating.
--
--   A separate bucket is also the pattern this codebase already follows
--   (016 flow-media, 023 chat-media, 051 instagram-media), and 023's own
--   header gives the reason: distinct buckets let size and retention
--   policy diverge later without touching the other callers.
--
-- WHY IT MATTERS HERE SPECIFICALLY
--   Template media has a different lifecycle from a chat attachment. A
--   chat attachment is sent once and is immediately meaningful. Template
--   media has to stay reachable for as long as the template exists,
--   because Meta re-fetches it during review and the send path uses the
--   same URL on every delivery. Mixing the two makes "is this object
--   still referenced?" unanswerable, so neither can ever be swept.
--
-- TIGHTER MIME LIST THAN chat-media
--   Only the three header formats Meta accepts for templates: JPEG/PNG
--   images, MP4/3GPP video, PDF documents. chat-media additionally
--   allows Office documents, text/plain and the voice-note audio types,
--   none of which are valid template headers — allowing them here would
--   only let a user upload something Meta will reject.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-media',
  'template-media',
  TRUE,
  16777216, -- 16 MB, Meta's video cap; images are capped tighter client-side (5 MB)
  ARRAY[
    'image/png', 'image/jpeg',
    'video/mp4', 'video/3gpp',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- Storage RLS — account-scoped writes, public reads.
--
-- Same predicate shape as 020 (flow-media) and 023 (chat-media): the
-- path's first segment must be `account-<account_id>` for an account the
-- caller belongs to. Public read because the bucket URL is what Meta
-- fetches during template review and on every send — an authenticated
-- URL would be unreachable to Meta.
--
-- Drop-then-create (Postgres has no CREATE POLICY IF NOT EXISTS).
-- ============================================================

DROP POLICY IF EXISTS "Template media is publicly readable" ON storage.objects;
CREATE POLICY "Template media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template-media');

DROP POLICY IF EXISTS "Members can upload template media" ON storage.objects;
CREATE POLICY "Members can upload template media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update template media" ON storage.objects;
CREATE POLICY "Members can update template media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- DELETE matters more here than in chat-media: it is how the builder
-- rolls back media it uploaded moments before a failed Meta submit,
-- which is the orphan path this migration's companion change removes.
DROP POLICY IF EXISTS "Members can delete template media" ON storage.objects;
CREATE POLICY "Members can delete template media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
