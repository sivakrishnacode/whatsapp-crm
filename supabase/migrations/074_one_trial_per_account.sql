-- ============================================================
-- 074_one_trial_per_account.sql — a trial is something an account gets
-- once, not something a plan hands out every time it is chosen.
--
-- THE BUG THIS CLOSES
--
--   `OnboardingService.startSubscription` upserts `user_subscriptions`
--   keyed on user_id and writes `trial_start_at = now()` every time. Both
--   of its callers — POST /onboarding/plan and POST /onboarding/enquiry —
--   therefore restart the clock, so clicking between Starter, Growth and
--   Enterprise grants a fresh 15 days on each pass. The product was free
--   for as long as somebody kept changing their mind.
--
--   The trial window itself stays on `user_subscriptions`, which is where
--   every consumer already reads it — duplicating it here would create
--   two sources of truth that drift. What this migration adds is a
--   LATCH: the fact that this account has ever been given a trial.
--
-- WHY ON account_onboarding
--
--   Because the rule is per workspace, and `user_subscriptions` is keyed
--   by user. A workspace that transfers ownership, or whose subscription
--   row is rebuilt after a cancellation, must not thereby earn a second
--   trial. `account_onboarding` is already the one-row-per-account record
--   of how this workspace was signed up, so the fact belongs with it.
--
-- WHAT STILL GRANTS TIME
--
--   Only an operator, from apps/admin-panel: "Start trial" and "Extend
--   the period by" on the subscriber page. Those write the subscription
--   row directly and deliberately ignore this latch — an extension is a
--   decision a human is making, and it is recorded in admin_audit_log.
--   Self-service can never grant itself a second trial again.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE account_onboarding
  ADD COLUMN IF NOT EXISTS trial_granted_at timestamptz;

COMMENT ON COLUMN account_onboarding.trial_granted_at IS
  'When this workspace was first given a trial. A latch, not a window — the dates live on user_subscriptions. Non-null means self-service may never start another trial; only an admin-panel operator can extend one.';

-- ============================================================
-- Backfill.
--
-- Every account whose owner already carries a trial start has had its
-- one trial. Without this the first plan switch after deploying would
-- hand each of them a fresh 15 days — the exact bug being closed.
--
-- Joined through `accounts.owner_user_id` rather than any member,
-- because that is the user the subscription is written for.
-- ============================================================
UPDATE account_onboarding ob
   SET trial_granted_at = s.trial_start_at
  FROM accounts a
  JOIN user_subscriptions s ON s.user_id = a.owner_user_id
 WHERE ob.account_id = a.id
   AND ob.trial_granted_at IS NULL
   AND s.trial_start_at IS NOT NULL;

-- An account that reached a subscription without a trial_start_at (a
-- plan with no trial days, or a manual assignment) has still consumed
-- its onboarding. Recorded as granted at the subscription's creation so
-- it cannot later claim a first trial it never asked for.
UPDATE account_onboarding ob
   SET trial_granted_at = COALESCE(s.created_at, ob.completed_at, now())
  FROM accounts a
  JOIN user_subscriptions s ON s.user_id = a.owner_user_id
 WHERE ob.account_id = a.id
   AND ob.trial_granted_at IS NULL
   AND s.status = 'active';
