-- ============================================================
-- reset-subscriptions.sql — ONE-OFF. Not a migration.
--
-- Clears every subscription and every onboarding record so all
-- existing accounts are pushed back through the /welcome wizard and
-- must choose a plan again. Run once, after 066.
--
-- WHY THIS IS NOT IN supabase/migrations/
--   Migrations in this repo are written to be re-runnable, and
--   scripts/deploy.sh may replay them. A DELETE living there would
--   silently wipe live subscriptions on every future deploy.
--
-- DESTRUCTIVE. There is no payments/invoices table in this database
-- (see apps/admin-panel/lib/queries/sql.ts) — deleting a subscription
-- row destroys the only record that the account ever had a plan.
--
--   psql "$DATABASE_URL" -f scripts/sql/reset-subscriptions.sql
-- ============================================================

BEGIN;

-- Shown before the deletes so the operator can see what is about to go.
SELECT sp.name AS plan, us.status, count(*) AS subscriptions
  FROM user_subscriptions us
  JOIN subscription_plans sp ON sp.id = us.plan_id
 GROUP BY 1, 2
 ORDER BY 1, 2;

DELETE FROM user_subscriptions;

-- Onboarding answers go too: a workspace with no plan has not
-- completed onboarding, and leaving completed_at set would let the
-- gate wave them straight past the plan step they now have to redo.
DELETE FROM account_onboarding;

COMMIT;
