-- ============================================================
-- 060_contact_phone_e164_constraint.sql — part 2 of 2.
--
-- Lock `contacts.phone` to canonical E.164. Run AFTER 059/060 and after
-- scripts/backfill-contact-phones.ts; see 059 for why the rewrite
-- lives in the app layer rather than in SQL.
--
-- WHY A CONSTRAINT AND NOT A NORMALIZING TRIGGER
--   A trigger would have to re-derive the country for a bare national
--   number, which is the part plpgsql cannot do correctly (059). A
--   half-right trigger is worse than none: it would quietly write a
--   plausible-looking wrong number and mask the app-layer bug that
--   let an un-normalized value through.
--
--   A CHECK inverts that. The app decides the format — one helper,
--   `toE164`, on every write path — and the database only enforces
--   that *something* decided. Any path that forgets (a new channel, a
--   direct Supabase insert from the web app, a hand-run UPDATE) fails
--   immediately and visibly instead of re-introducing the mixed
--   formats this pair of migrations exists to remove.
--
-- NULL IS STILL ALLOWED
--   Instagram-only contacts have an IGSID and no phone, and web
--   widget stubs have neither until the visitor identifies
--   themselves. `contacts_identity_chk` already guarantees every
--   contact carries at least one identity; this constraint only says
--   that *if* there is a phone, it is canonical.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Refuse to apply on un-backfilled data. Adding the constraint would
-- fail anyway, but with Postgres's generic "violates check
-- constraint" and no indication of what to do about it.
DO $$
DECLARE
  v_bad   INTEGER;
  v_first TEXT;
BEGIN
  SELECT count(*), min(phone)
    INTO v_bad, v_first
    FROM contacts
   WHERE phone IS NOT NULL
     AND phone !~ '^\+[1-9][0-9]{6,14}$';

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'contacts.phone still has % non-E.164 row(s), e.g. %. Run the backfill first: cd apps/api && npx tsx scripts/backfill-contact-phones.ts --apply',
      v_bad, v_first;
  END IF;
END $$;

-- `+` then a non-zero country digit then 6-14 more: E.164 caps the
-- whole number at 15 digits. Matches isCanonicalE164() in
-- apps/api/src/common/phone/phone.util.ts and its web twin — keep the
-- three in step.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_e164_chk;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_phone_e164_chk
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$');

COMMENT ON COLUMN contacts.phone IS
  'Canonical E.164, e.g. ''+919791766444''. NULL for Instagram-only and unidentified web-widget contacts (see contacts_identity_chk). Enforced by contacts_phone_e164_chk — every write path must run its input through toE164() first. Meta''s Cloud API wants digits with no ''+''; that conversion belongs at send time (sanitizePhoneForMeta), never in storage.';
