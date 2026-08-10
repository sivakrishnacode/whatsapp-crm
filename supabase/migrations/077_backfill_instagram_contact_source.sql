-- ============================================================
-- 077_backfill_instagram_contact_source.sql — finish 056's backfill.
--
-- WHAT WAS WRONG
--
--   Migration 056 added `contacts.source` and backfilled the two cases
--   that can be proven rather than guessed:
--
--     web_visitor_id IS NOT NULL  → 'web'
--     ig_scoped_id   IS NOT NULL  → 'instagram'
--
--   Both are proof, not inference: each column is written in exactly one
--   place (web-session.service.ts and instagram-identity.service.ts), so
--   its presence identifies the creation path with certainty.
--
--   On the production database the second UPDATE did not take effect —
--   five Instagram-only contacts, created 28 July, still read 'unknown'
--   while contacts created after 056 shipped on 30 July carry a correct
--   source. The `web` half had nothing to do, so it is indistinguishable
--   from having run.
--
--   Whatever the cause, the fix is the same statement, and it is worth
--   its own migration rather than a one-off psql session: an environment
--   that also missed it should converge on the same state.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   Contacts with a phone and no ig_scoped_id stay 'unknown', even
--   though most of them will in fact have arrived over WhatsApp. That is
--   056's decision, not an oversight, and it is restated here because
--   this migration is exactly where someone will be tempted to reverse
--   it: "has a WhatsApp conversation, so source = whatsapp" cannot tell
--   an inbound contact from an imported one who happened to message
--   first. A lead-origin column that is quietly wrong is worse than one
--   that admits it does not know, because the wrong version still gets
--   used to decide where the ad budget goes.
--
--   `source` is write-once — a fact about a past event — so this only
--   ever touches rows still sitting at the 'unknown' default. A contact
--   whose source was recorded at creation is never rewritten.
--
-- Idempotent — safe to re-run.
-- ============================================================

UPDATE contacts
  SET source = 'instagram'
  WHERE source = 'unknown'
    AND ig_scoped_id IS NOT NULL;

UPDATE contacts
  SET source = 'web'
  WHERE source = 'unknown'
    AND web_visitor_id IS NOT NULL;
