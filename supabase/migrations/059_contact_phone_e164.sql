-- ============================================================
-- 059_contact_phone_e164.sql — part 1 of 2.
--
-- Canonicalize `contacts.phone` to E.164 (`+<country><subscriber>`).
--
-- THE PROBLEM
--   The same person was stored three different ways depending on which
--   channel first saw them:
--     +919791766444   contact form / import (whatever was typed)
--      919791766444   WhatsApp webhook (Meta's inbound `from` is digits
--                     only) and the public v1 API (which validated
--                     E.164 and then stored the Meta-sanitized form,
--                     dropping the `+` it had just checked for)
--        9791766444   web widget / form submission (a bare national
--                     number, no country code at all)
--   De-duplication was never affected — `phone_normalized`
--   (migration 022) strips non-digits, so all three collapse to one
--   key. What broke is everything that reads `phone` back: the
--   contacts list showed a mixed jumble, and any consumer treating
--   the value as dialable had to re-guess the format.
--
-- WHY THIS SPLITS INTO TWO MIGRATIONS
--   Canonicalizing `9791766444` requires knowing a country, and
--   deciding *which* country from a digit string is exactly the
--   ambiguity libphonenumber exists to resolve — it is not
--   expressible in plpgsql without reimplementing that metadata.
--   So the rewrite happens in the app layer:
--
--     059 (this file)  schema + remove seeded test rows
--     060              merge_contacts_into(), because canonicalizing
--                      can make two rows collide — see that file
--     scripts/backfill-contact-phones.ts   rewrites the data using
--                                          the same toE164() the app
--                                          writes through, merging
--                                          any pair that collides
--     061              adds the CHECK constraint, and refuses to
--                      apply if the backfill has not run
--
--   Running them out of order fails loudly rather than silently
--   leaving mixed formats — see the RAISE in 061.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1) Per-account default country
-- ============================================================

-- A bare national number carries no country code, so canonicalizing
-- it means assuming one. That assumption cannot be global in a
-- multi-tenant app: an Indian account's 10-digit numbers are +91,
-- a US account's are +1, and getting it wrong writes an
-- undeliverable number that looks perfectly well-formed.
--
-- ISO 3166-1 alpha-2 (not the calling code) because that is what
-- libphonenumber's parser takes, and because several countries share
-- a calling code — +1 alone cannot tell US from CA, and their
-- national formats differ.
--
-- Mirrors accounts.default_currency (migration 021): TEXT, NOT NULL,
-- app-wide default, CHECK for shape only.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_country TEXT NOT NULL DEFAULT 'IN';

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_default_country_chk;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_default_country_chk
  CHECK (default_country ~ '^[A-Z]{2}$');

COMMENT ON COLUMN accounts.default_country IS
  'ISO 3166-1 alpha-2 country assumed for phone numbers entered without a country code, e.g. ''IN''. Read by toE164() on every contact write path; see apps/api/src/common/phone/phone.util.ts. Shape-checked only (accounts_default_country_chk) — the authoritative list of parseable countries is libphonenumber''s, surfaced in the picker via apps/web/src/lib/phone/countries.ts.';


-- ============================================================
-- 2) Remove seeded load-test contacts
-- ============================================================

-- 500 rows named "Contact 1".."Contact 500" on +1555000xxxx, all
-- created in one second on 2026-07-13. +1-555-01xx is the reserved
-- fictional range — these are seed data, not customers, and they made
-- up 97% of the contacts table.
--
-- The predicate is deliberately over-specified (reserved range AND
-- generated name AND no conversation history) so it cannot match a
-- real contact who happens to hold a 555 number. Anything with a
-- single message is left alone.
--
-- broadcast_recipients and contact_tags cascade from contacts; the
-- only rows affected are 250 recipients of one broadcast that had
-- already failed, and 250 assignments of the "customer" tag. The tag
-- itself, and every real contact, are untouched.
DELETE FROM contacts c
  WHERE c.phone ~ '^\+1555000[0-9]{4}$'
    AND c.name ~ '^Contact [0-9]+$'
    AND NOT EXISTS (
      SELECT 1 FROM conversations cv WHERE cv.contact_id = c.id
    );
