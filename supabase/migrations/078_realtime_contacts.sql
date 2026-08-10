-- ============================================================
-- 078_realtime_contacts.sql — let an open inbox see a contact get a name.
--
-- WHAT WAS WRONG
--
--   An Instagram contact is created wearing its IGSID as a display name.
--   That is deliberate: Meta's profile API answers only for people who
--   already have a messaging relationship with the business, so someone
--   first seen through the echo of an outbound DM cannot be resolved yet.
--   `InstagramIdentityService.upgradePlaceholderName` retries on their
--   next inbound message and writes the real name — and the sentinel it
--   uses to know a name is still a placeholder is `name = ig_scoped_id`,
--   which is why the IGSID is written there rather than left NULL.
--
--   That upgrade was invisible. `supabase_realtime` carried `messages`
--   and `conversations` but not `contacts`, so a tab that was already
--   open kept rendering the number until someone reloaded the page.
--   Observed in production: contact 1007930302003450 was renamed to its
--   real name at 09:58 IST and the inbox was still showing the raw id at
--   10:08.
--
-- WHY THIS IS SAFE TO PUBLISH
--
--   `postgres_changes` evaluates RLS per subscriber, and `contacts` has
--   RLS enabled with an account-scoped SELECT policy (migration 017), so
--   a subscriber receives only rows they could already have read. That
--   is the same footing `messages` and `conversations` — strictly more
--   sensitive tables — have been on since the inbox was built.
--
--   Replica identity is left at DEFAULT. The inbox only reads the NEW
--   row; FULL would put every old column of every contact update on the
--   wire to buy nothing.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;
  END IF;
END $$;
