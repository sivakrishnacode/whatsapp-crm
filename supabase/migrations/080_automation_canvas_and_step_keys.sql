-- ------------------------------------------------------------
-- 080: automation steps get a stable reference key and a canvas position.
--
-- WHY A KEY, WHEN EVERY ROW ALREADY HAS AN ID
--   Saving an automation is delete-then-reinsert (see
--   AutomationStepsTreeService.replaceSteps), so a step's UUID changes on
--   every save. That is fine while nothing refers to a step — and fatal the
--   moment one step wants to read another's output
--   (`{{ steps.lookup_order.body.id }}`). The key is author-facing, stable
--   across saves, and unique per automation, so a token written on Monday
--   still resolves after Friday's edit.
--
--   It is also the canvas node id: React Flow needs an identity that
--   survives a re-render, and the row id is not available for a step that
--   has never been saved.
--
-- POSITIONS
--   Nullable, NOT defaulted to 0. "Never laid out" and "deliberately placed
--   at the origin" are different facts: the editor auto-lays-out the first
--   kind with dagre and leaves the second alone. A NOT NULL DEFAULT 0 would
--   make every pre-canvas automation look like a deliberate pile at (0,0).
-- ------------------------------------------------------------

ALTER TABLE public.automation_steps
  ADD COLUMN IF NOT EXISTS key text,
  ADD COLUMN IF NOT EXISTS position_x double precision,
  ADD COLUMN IF NOT EXISTS position_y double precision;

-- Backfill existing rows with a deterministic key so tokens can address
-- steps that predate this migration. `<step_type>_<n>` matches what the
-- editor generates for new steps, numbered by document order within the
-- automation (root order first, then branch children — the same order
-- loadStepsTree returns).
WITH numbered AS (
  SELECT
    id,
    step_type || '_' || ROW_NUMBER() OVER (
      PARTITION BY automation_id, step_type
      ORDER BY parent_step_id NULLS FIRST, branch NULLS FIRST, position, created_at
    ) AS generated_key
  FROM public.automation_steps
  WHERE key IS NULL
)
UPDATE public.automation_steps AS s
SET key = n.generated_key
FROM numbered AS n
WHERE s.id = n.id;

-- Unique per automation, not globally: keys are short and human-chosen
-- ("notify_sales"), so two automations will absolutely both want one.
-- Partial, because a row is allowed to have no key (a client that has not
-- been updated yet must still be able to save).
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_steps_key
  ON public.automation_steps (automation_id, key)
  WHERE key IS NOT NULL;

COMMENT ON COLUMN public.automation_steps.key IS
  'Author-facing, save-stable reference for this step. Addressed by other steps as {{ steps.<key>.… }} and used as the canvas node id. Unique within an automation.';
COMMENT ON COLUMN public.automation_steps.position_x IS
  'Canvas x. NULL means never laid out — the editor runs auto-layout instead of stacking everything at the origin.';
COMMENT ON COLUMN public.automation_steps.position_y IS
  'Canvas y. NULL means never laid out. See position_x.';
