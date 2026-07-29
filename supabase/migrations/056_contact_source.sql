-- ============================================================
-- 056_contact_source.sql — record where each contact came from.
--
-- WHY A STORED COLUMN AND NOT A DERIVED ONE
--   The obvious cheap version is to infer origin at read time from the
--   identity columns: `ig_scoped_id` → Instagram, `web_visitor_id` →
--   web widget, otherwise WhatsApp. That covers three of ten paths and
--   silently lies about the rest. A phone-only contact may have arrived
--   by any of: hand-entry in the dashboard, CSV import, an inbound
--   WhatsApp message, the public v1 API, a Facebook lead-gen form, a
--   form submission, or being minted while resolving a broadcast
--   audience. Nothing on the row distinguishes them, and nothing ever
--   will — the distinction only exists at the moment of creation, so it
--   has to be written then.
--
--   Origin is also immutable in a way almost nothing else on `contacts`
--   is. It is a fact about an event in the past, so it is safe to store
--   once and never reconcile.
--
-- TEXT + CHECK, NOT AN ENUM
--   Same posture as `conversations.channel` (050/053): adding a source
--   is one ALTER of a CHECK constraint rather than an enum migration,
--   and the TypeScript half of the contract lives in
--   apps/api/src/common/contacts/contact-source.ts — keep the two in
--   step.
--
-- THE BACKFILL IS DELIBERATELY INCOMPLETE
--   Rows predating this column have no ground truth. Two cases are
--   certain and are backfilled; the rest stay 'unknown' rather than
--   being guessed at.
--
--   The tempting heuristic — "first message is inbound, so it came from
--   WhatsApp" — is wrong often enough to matter: an imported contact
--   who messages first before anyone messages them looks identical. A
--   CRM column that quietly mislabels lead origin is worse than one
--   that admits it does not know, because the wrong version still gets
--   used to decide where to spend money.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown';

-- The default is 'unknown', not 'manual'. Every creation path sets this
-- explicitly, so the default is only ever reached by a path that forgot
-- to — and a gap should be visible in the UI as "Unknown" rather than
-- disguised as a hand-entered contact.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_source_chk;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_source_chk
  CHECK (source IN (
    'manual',         -- typed into the dashboard contact form
    'import',         -- CSV import
    'whatsapp',       -- inbound WhatsApp message (includes click-to-WhatsApp ads,
                      -- which reach us through the same webhook)
    'instagram',      -- Instagram DM
    'web',            -- website chat widget
    'form',           -- form / booking submission
    'facebook_lead',  -- Facebook lead-gen form
    'api',            -- public v1 API (contact create, or send-message auto-create)
    'broadcast',      -- minted while resolving a broadcast audience
    'unknown'         -- predates this column, or a path that did not set it
  ));

COMMENT ON COLUMN contacts.source IS
  'How this contact first entered the account. Written once at creation and never updated — it describes a past event, not current state. Guarded by contacts_source_chk; the TypeScript counterpart is apps/api/src/common/contacts/contact-source.ts. Rows created before migration 056 are ''unknown'' unless their identity columns proved otherwise (see the migration for why nothing else was guessed).';


-- ============================================================
-- Backfill: only the two provable cases
-- ============================================================

-- A web_visitor_id is minted in exactly one place
-- (web/services/web-session.service.ts) and never set anywhere else,
-- so its presence is proof of origin.
UPDATE contacts
  SET source = 'web'
  WHERE source = 'unknown'
    AND web_visitor_id IS NOT NULL;

-- Likewise an IGSID: only instagram-identity.service.ts writes it.
UPDATE contacts
  SET source = 'instagram'
  WHERE source = 'unknown'
    AND ig_scoped_id IS NOT NULL;


-- ============================================================
-- Index
-- ============================================================

-- Supports "where did our contacts come from" grouping and the
-- source filter on the contacts list. Account-leading because every
-- query on this table is tenant-scoped (see 046).
CREATE INDEX IF NOT EXISTS idx_contacts_account_source
  ON contacts (account_id, source);
