-- ============================================================
-- 083 — meter "Build an automation with AI" as its own feature
-- ============================================================
--
-- WHAT CHANGES
--   `ai_credit_ledger.feature` gains one value: 'automation_draft'.
--
-- WHY IT IS NOT FOLDED INTO 'draft'
--   'draft' means "suggest a reply to this customer" and is charged
--   against a conversation — `ai_credit_ledger.conversation_id` is
--   populated for every one of those rows. An automation draft has no
--   conversation and no customer; reusing the name would make the
--   inbox's per-conversation cost reporting wrong and would hide a new
--   spending surface inside an existing line on the admin panel's
--   /credits chart. A new value is one CHECK edit; a mislabelled ledger
--   is unrecoverable, because the ledger IS the record (see the note in
--   apps/admin-panel/README.md on money being derived elsewhere).
--
-- WHY THE CHECK IS REPLACED RATHER THAN DROPPED
--   The constraint is the only gate on this column: `consume_ai_credits`
--   takes `p_feature text` straight from its caller. Dropping it would
--   let a typo'd feature name persist happily and quietly fall out of
--   every report that groups by it.
--
-- Existing rows are untouched and all satisfy the new constraint, so
-- this is a non-blocking metadata-only change (Postgres still scans the
-- table to validate; ai_credit_ledger is small and append-only).

ALTER TABLE ai_credit_ledger
  DROP CONSTRAINT IF EXISTS ai_credit_ledger_feature_check;

ALTER TABLE ai_credit_ledger
  ADD CONSTRAINT ai_credit_ledger_feature_check
  CHECK (feature IN (
    'draft',
    'auto_reply',
    'playground',
    'embedding',
    -- Generating an automation from a sentence in /automations/ai.
    -- Charged from real token usage like every other generation; see
    -- `creditsForGeneration()`.
    'automation_draft'
  ));

COMMENT ON COLUMN ai_credit_ledger.feature IS
  'Which part of the product spent the credit. NULL on grants. '
  '''draft'' is the inbox reply suggester (carries conversation_id); '
  '''automation_draft'' is the AI automation builder (no conversation).';
