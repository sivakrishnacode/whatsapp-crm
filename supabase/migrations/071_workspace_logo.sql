-- ============================================================
-- 071_workspace_logo.sql — a workspace can carry its own logo.
--
-- Until now the only mark in the product was ours: the rail shows the
-- Converse360 lockup and the header shows the first letter of the
-- account name in a coloured square. A workspace had no identity of its
-- own, which reads as unfinished to a customer who has just paid for a
-- CRM their whole team logs into.
--
-- Two things here:
--
--   1. `accounts.logo_url` — nullable, and nullable on purpose. No logo
--      is the normal state, and the UI must keep rendering the initial
--      fallback rather than a broken image box.
--
--   2. A `workspace-logos` storage bucket following the account-scoped
--      path convention established by migrations 020/023:
--
--        workspace-logos/account-<account_id>/logo-<timestamp>.<ext>
--
--      The browser uploads straight to Storage (same as user avatars and
--      chat media) and then PATCHes the resulting public URL onto the
--      account, so the API never carries the bytes.
--
-- WHY WRITES ARE ADMIN+ AND READS ARE PUBLIC
--   The logo is workspace chrome, not personal chrome: it appears in
--   every teammate's header. An agent or viewer changing what the whole
--   company sees is the same class of act as renaming the workspace, and
--   `PATCH /account` already holds that at admin+. The direct-to-Storage
--   upload bypasses the API entirely, so this policy is the ONLY gate on
--   the write — it has to carry the role check itself.
--
--   Reads are public because the bucket serves <img> tags on a page the
--   browser renders before any Storage session is negotiated.
--
-- WHY SVG IS NOT IN THE MIME ALLOWLIST
--   An SVG is a document that can carry script. It is inert inside an
--   <img>, but the object URL is directly navigable, and it would then
--   execute on the Supabase project's own origin — the origin that also
--   serves auth and the REST API. PNG/JPEG/WebP cost a customer nothing
--   and close that off. Do not add 'image/svg+xml' here without a
--   sanitiser in front of the upload.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- COLUMN
-- ============================================================
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

COMMENT ON COLUMN public.accounts.logo_url IS
  'Public URL of the workspace logo in the workspace-logos bucket. NULL '
  '= no logo; the UI falls back to the first letter of accounts.name. '
  'Written only via PATCH /account (admin+), which pins the URL to the '
  'project''s own Storage prefix.';

-- ============================================================
-- BUCKET
--
-- 2 MB. A logo is rendered at 24-64 CSS px; anything above this is a
-- photo someone dragged in by mistake, and the cap is a kinder error
-- than a 4 MB payload on every page load for the whole team.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'workspace-logos',
  'workspace-logos',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- STORAGE RLS
--
-- Path convention: `account-<account_id>/...`, matched on the first
-- folder segment — the same shape migrations 020/023 use, so
-- `buildMediaPath()` in the web app needs no special case.
--
-- Drop-then-create (Postgres has no CREATE POLICY IF NOT EXISTS).
-- ============================================================
DROP POLICY IF EXISTS "Workspace logos are publicly readable" ON storage.objects;
CREATE POLICY "Workspace logos are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'workspace-logos');

DROP POLICY IF EXISTS "Admins can upload workspace logos" ON storage.objects;
CREATE POLICY "Admins can upload workspace logos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'workspace-logos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Admins can update workspace logos" ON storage.objects;
CREATE POLICY "Admins can update workspace logos"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'workspace-logos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- Deletes matter more than usual here: replacing a logo uploads the new
-- object and then removes the old one, so without this every change
-- leaves an orphan in a public bucket forever.
DROP POLICY IF EXISTS "Admins can delete workspace logos" ON storage.objects;
CREATE POLICY "Admins can delete workspace logos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'workspace-logos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
