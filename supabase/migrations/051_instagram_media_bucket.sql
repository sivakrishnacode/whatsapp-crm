-- ============================================================
-- 051_instagram_media_bucket.sql — storage for mirrored Instagram DM
-- attachments.
--
-- WHY MIRROR AT ALL
--   WhatsApp hands us a permanent media *id* that the media proxy
--   re-resolves to a fresh CDN URL on every request. Instagram hands us
--   a signed CDN URL in the webhook and nothing else — that URL expires
--   and there is no id to re-resolve. If we do not copy the bytes at
--   ingest, every image in the inbox turns into a broken thumbnail
--   within hours.
--
-- PUBLIC BUCKET, UNGUESSABLE PATHS
--   Matches the existing `flow-media` bucket. Objects are keyed
--   `<account_id>/<kind>/<sha256-of-source-url>` — a 128-bit random
--   account UUID plus a 128-bit hash. Enumeration is not feasible, and
--   a public bucket means <img src> works without minting signed URLs
--   on every inbox render.
--
--   Note this is the same exposure the WhatsApp media proxy has (any
--   authenticated member of any account can request any media id it
--   knows). If that is ever tightened, tighten both together.
--
-- WRITES ARE SERVICE-ROLE ONLY
--   Unlike flow-media, nothing in the browser uploads here — only the
--   webhook ingest path does, on the server, with the service-role key
--   (which bypasses RLS). So there is deliberately no INSERT/UPDATE
--   policy for `authenticated`: there is no legitimate client write.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'instagram-media',
  'instagram-media',
  TRUE,
  31457280, -- 30 MB, matching MAX_MIRROR_BYTES in instagram-media-mirror.service.ts
  ARRAY[
    -- Images and GIFs (DM photos, stickers, story mentions)
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic',
    -- Video (DM clips, reel shares)
    'video/mp4', 'video/quicktime', 'video/3gpp',
    -- Voice notes
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/webm',
    -- Files
    'application/pdf',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read: the inbox renders these straight from an <img>/<video>
-- tag. Same posture as flow-media.
DROP POLICY IF EXISTS "Instagram media is publicly readable" ON storage.objects;
CREATE POLICY "Instagram media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'instagram-media');

-- Deliberately no INSERT / UPDATE / DELETE policies: every write comes
-- from the server-side ingest path using the service-role key, which
-- bypasses RLS. Adding a client-write policy here would create an
-- upload surface with no caller.
