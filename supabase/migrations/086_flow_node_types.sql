-- ============================================================
-- 086 — the flow builder's new vocabulary
-- ============================================================
--
-- Flows shipped with eleven node types and a builder that hid them
-- behind a dropdown. This migration widens `flow_nodes.node_type` for
-- the nine added in the rebuild, and gives `flow_runs` the two columns
-- a `wait` node needs to come back.
--
-- ⚠️ IT ALSO FIXES A LIVE BUG.
--   `set_segment` has been implemented end to end since migration 076 —
--   it is in the add menu, both validators and the engine — but it was
--   never added to this CHECK, which has not changed since 016. Saving a
--   flow containing a Segment node therefore failed with a constraint
--   violation, in a code path where every layer above the database
--   believed it was valid. It is in the list below.
--
-- ⚠️ `http_fetch` STAYS in the list.
--   Nothing implements it and nothing offers it, but 016 allowed it, and
--   a value that a row could theoretically already hold is not something
--   to drop in a widening migration. `http_request` is the implemented
--   name and matches the automation step type of the same shape.
--
-- WHY A CHECK AND NOT AN ENUM: a Postgres enum needs ALTER TYPE to grow
-- and cannot be narrowed at all. The node vocabulary is expected to keep
-- growing, so a CHECK that any migration can restate is the cheaper
-- shape — that is the choice 010 made and this keeps it.

-- ============================================================
-- 1. flow_nodes.node_type — the full vocabulary
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    -- flow control
    'start',
    'end',
    'condition',
    'wait',
    'handoff',
    'ai_handoff',
    'start_flow',
    -- messaging
    'send_message',
    'send_buttons',
    'send_list',
    'send_media',
    'send_template',
    'send_products',
    -- capture
    'collect_input',
    'ask_location',
    'ask_media',
    -- data
    'set_tag',
    'set_segment',
    'set_attribute',
    'http_request',
    -- superseded, never implemented; kept so no existing row can
    -- violate the constraint. See the header.
    'http_fetch'
  ));

-- ============================================================
-- 2. flow_runs — where a waiting run keeps its alarm clock
-- ============================================================
--
-- ⚠️ POSTGRES IS THE SYSTEM OF RECORD, REDIS IS THE WORK LIST.
--   A `wait` node schedules a delayed BullMQ job, but the job is only an
--   optimisation: these two columns are what make the resume
--   RECONSTRUCTIBLE. If Redis is flushed, the periodic flows-sweep pass
--   finds every run whose `resume_at` is in the past and continues it.
--   Without them a lost Redis means every waiting customer is stranded
--   mid-conversation with nothing to find them by.
--
-- The run stays `status = 'active'` while it waits. A new status value
-- would mean widening another CHECK and re-reading every consumer that
-- branches on it, to express something `resume_at IS NOT NULL` already
-- says — and it would drop the waiting run out of the partial unique
-- index that stops a contact running two flows at once, which is the
-- one guarantee that must hold hardest while a run is parked.
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_node_key TEXT;

COMMENT ON COLUMN flow_runs.resume_at IS
  'When a wait node should continue this run. NULL = not waiting. The delayed job is the fast path; the sweep reads this column as the durable one.';
COMMENT ON COLUMN flow_runs.resume_node_key IS
  'Node the run continues from when resume_at passes.';

-- Partial: only waiting runs are ever looked up this way, and they are a
-- small minority of the table.
CREATE INDEX IF NOT EXISTS idx_flow_runs_resume_due
  ON flow_runs (resume_at)
  WHERE resume_at IS NOT NULL AND status = 'active';
