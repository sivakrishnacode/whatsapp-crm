-- ============================================================
-- 093_fix_google_script_connections_created_by_fk.sql
--   Repair the `created_by` foreign key of 092.
--
-- 092 declared `created_by uuid REFERENCES public.profiles(id)`.
-- But the API never stores a profiles.id. The dashboard guard
-- (supabase-auth.guard.ts) sets `userId` from the verified JWT `sub`,
-- which is the Supabase auth user id — the same value that fills
-- `users.id` (auth.users mirror) and `profiles.user_id`. `profiles.id`
-- is a separate gen_random_uuid, so no profiles row ever matches the
-- value being written, and every provision upsert died with:
--
--   Foreign key constraint violated on the constraint:
--   google_script_connections_created_by_fkey
--
-- Realign the constraint to the table the value actually denotes.
--
--   auth.users(id)  ←── google_script_connections(created_by)  ON DELETE SET NULL
--
-- `users` is the Supabase auth.users mirror (the same target profile's
-- own `user_id` FK uses); a row there outlives a profile the same way,
-- so ON DELETE SET NULL keeps the "who pasted it" semantics of 092.
-- Resolved `created_by` values are exactly auth user ids, so every live
-- row remains valid once the dev's test row is reconciled below.
--
-- Existing rows: 092 never succeeded in writing *any* row via the API —
-- provision died on this FK from day one — so the column is empty or
-- NULL everywhere and there is nothing to backfill.
-- ============================================================

ALTER TABLE public.google_script_connections
  DROP CONSTRAINT IF EXISTS google_script_connections_created_by_fkey;

ALTER TABLE public.google_script_connections
  ADD CONSTRAINT google_script_connections_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;