-- ============================================================
-- 088 — meter "Build a flow with AI" as its own feature
-- ============================================================
--
-- WHAT CHANGES
--   `ai_credit_ledger.feature` gains one value: 'flow_draft'.
--
-- WHY NOT REUSE 'automation_draft'
--   Same reasoning 083 gives for not reusing 'draft'. These are two
--   different surfaces a workspace can spend on — the automation builder
--   and the flow builder — and the ledger IS the record of where the
--   money went. Folding one into the other would hide a spending surface
--   inside an existing line on the admin panel's /credits chart, and
--   nothing downstream could ever separate them again.
--
-- WHY THE CHECK IS REPLACED RATHER THAN DROPPED
--   It is the only gate on this column: `consume_ai_credits` takes
--   `p_feature text` straight from its caller, so without the constraint
--   a typo'd feature name persists happily and falls out of every report
--   that groups by it.
--
-- Existing rows are untouched and all satisfy the new constraint.

ALTER TABLE ai_credit_ledger
  DROP CONSTRAINT IF EXISTS ai_credit_ledger_feature_check;

ALTER TABLE ai_credit_ledger
  ADD CONSTRAINT ai_credit_ledger_feature_check
  CHECK (feature IN (
    'draft',
    'auto_reply',
    'playground',
    'embedding',
    'automation_draft',
    -- Generating a chatbot flow from a sentence, in the flow editor's
    -- prompt bar or from /flows. Charged from real token usage like
    -- every other generation; see `creditsForGeneration()`.
    'flow_draft'
  ));

COMMENT ON COLUMN ai_credit_ledger.feature IS
  'Which part of the product spent the credit. NULL on grants. '
  '''draft'' is the inbox reply suggester (carries conversation_id); '
  '''automation_draft'' is the AI automation builder; '
  '''flow_draft'' is the AI flow builder (neither carries a conversation).';
