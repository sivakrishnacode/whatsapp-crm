-- ============================================================
-- 073_admin_credit_adjustment_and_audit.sql — the two things the
-- internal admin panel needs before it is allowed to touch credits.
--
-- Migration 072 built the credit wallet for the CUSTOMER's paths:
-- `grant_ai_credits` (a purchase or the welcome grant) and
-- `consume_ai_credits` (a metered AI call). Neither fits an operator
-- sitting in apps/admin-panel:
--
--   - `grant_ai_credits` refuses a non-positive amount, so there is no
--     way to take credits back — a mis-keyed 25,000 has to be lived
--     with, and a refunded top-up leaves the credits behind.
--   - `consume_ai_credits` could take them, but it writes
--     reason = 'usage' and demands a `feature`, so a clawback would
--     land in the same bucket as auto-replies and quietly corrupt both
--     `lifetime_consumed` and every per-feature spend figure.
--
-- 072 anticipated this: `ai_credit_ledger.reason` already allows
-- 'admin_adjust', and nothing has ever written it. This migration is
-- the writer, plus the audit table that makes such a write
-- attributable to a person.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. admin_adjust_ai_credits — a signed manual correction.
--
-- The third and last supported writer of ai_credit_wallets.balance,
-- and it keeps both of 072's invariants: the balance moves in ONE
-- statement (concurrent auto-replies on the same workspace make
-- read-then-write in application code wrong, not merely untidy), and
-- the ledger row is written before the function returns, so a balance
-- that changed without an audit trail stays unreachable.
--
-- Three deliberate choices, each of which keeps a downstream number
-- honest:
--
--   * `feature` is left NULL. An operator's correction is not a draft,
--     an auto-reply, a playground run or an embedding, and putting it
--     in one of those buckets would make spend-by-feature lie.
--   * `lifetime_purchased` is NOT incremented. It is what the customer
--     BOUGHT; a goodwill grant is us giving something away. Adding to
--     it would show up as top-up revenue nobody paid.
--   * `lifetime_consumed` is NOT incremented on a deduction, for the
--     mirror reason — nothing was consumed, credits were taken back.
--
-- A deduction larger than the balance takes what is there and stops:
-- `balance >= 0` is a CHECK constraint, and a negative wallet would
-- mean a customer who has to clear a debt before the agent answers
-- anybody. `applied` reports what actually moved, so the panel can say
-- "deducted 40 of the 200 you asked for" rather than implying it took
-- all of it.
--
-- SECURITY INVOKER with EXECUTE revoked from PUBLIC, exactly like its
-- two siblings: apps/admin-panel connects as the database owner and
-- needs no elevation, while a SECURITY DEFINER function reachable by
-- `authenticated` would be a mint-your-own-credits endpoint.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_adjust_ai_credits(
  p_account_id uuid,
  p_delta      integer,
  p_actor      text,
  p_note       text DEFAULT NULL
)
RETURNS TABLE(new_balance integer, applied integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_applied integer;
  v_note    text;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'admin_adjust_ai_credits: delta must not be zero'
      USING ERRCODE = '22023';
  END IF;

  -- The panel's operator is an env credential, not a row in
  -- auth.users, so `ai_credit_ledger.user_id` cannot hold them (it is
  -- a FK). The actor therefore rides in `note`, composed here rather
  -- than by the caller so every admin_adjust row carries a who
  -- whichever code path wrote it. admin_audit_log below is the
  -- queryable record; this is the copy that stays next to the money.
  v_note := coalesce(nullif(btrim(p_actor), ''), 'admin')
            || coalesce(': ' || nullif(btrim(p_note), ''), '');

  IF p_delta > 0 THEN
    INSERT INTO ai_credit_wallets (account_id, balance)
    VALUES (p_account_id, p_delta)
    ON CONFLICT (account_id) DO UPDATE
      SET balance = ai_credit_wallets.balance + p_delta,
          -- Same reasoning as grant_ai_credits: putting credits back
          -- re-arms the "running low" warning for the next depletion.
          low_balance_notified_at = NULL,
          updated_at = now()
    RETURNING ai_credit_wallets.balance INTO v_balance;

    v_applied := p_delta;
  ELSE
    -- Lock, subtract and report the difference in one statement. The
    -- CTE exists because RETURNING only sees the new row and what was
    -- actually taken is old minus new — the case that matters is
    -- precisely the one being audited. Mirrors consume_ai_credits.
    WITH locked AS (
      SELECT account_id, balance
        FROM ai_credit_wallets
       WHERE account_id = p_account_id
         FOR UPDATE
    ), moved AS (
      UPDATE ai_credit_wallets w
         SET balance = w.balance - LEAST(-p_delta, w.balance),
             updated_at = now()
        FROM locked l
       WHERE w.account_id = l.account_id
      RETURNING w.balance AS remaining, l.balance - w.balance AS taken
    )
    SELECT -m.taken, m.remaining INTO v_applied, v_balance FROM moved m;

    -- No wallet at all, or an empty one: there is nothing to take.
    -- Reported as applied = 0 with no ledger row, rather than a
    -- zero-delta entry that reads like something happened.
    IF v_applied IS NULL THEN
      RETURN QUERY SELECT 0, 0;
      RETURN;
    END IF;

    IF v_applied = 0 THEN
      RETURN QUERY SELECT v_balance, 0;
      RETURN;
    END IF;
  END IF;

  INSERT INTO ai_credit_ledger (
    account_id, delta, balance_after, reason, note
  ) VALUES (
    p_account_id, v_applied, v_balance, 'admin_adjust', v_note
  );

  RETURN QUERY SELECT v_balance, v_applied;
END;
$$;

REVOKE ALL ON FUNCTION
  public.admin_adjust_ai_credits(uuid, integer, text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.admin_adjust_ai_credits(uuid, integer, text, text) IS
  'Signed manual credit correction from the internal admin panel. Writes reason=admin_adjust with feature NULL and leaves lifetime_purchased/lifetime_consumed alone. Returns (new_balance, applied) — applied is smaller than requested when a deduction hits zero.';

-- ============================================================
-- 2. admin_audit_log — who changed what, from the admin panel.
--
-- Until now the panel could reprice a plan, move someone between plans
-- and cancel a subscription with no record of it anywhere:
-- `user_subscriptions.manually_assigned_by` is a FK to auth.users and
-- the panel's administrator is an env credential, so there was no
-- honest value to write. That was tolerable while the panel only
-- edited billing rows a customer could see the effect of. It stops
-- being tolerable now that it can grant and revoke credits.
--
-- Deliberately NO foreign keys. An audit row has to outlive the thing
-- it describes — "who deleted this workspace" is the question you ask
-- after the workspace is gone, and ON DELETE CASCADE would have
-- removed the answer along with it. The ids are recorded as plain
-- uuids and may dangle; that is the point.
--
-- Append-only by convention: nothing in the panel updates or deletes
-- these rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ADMIN_USERNAME that was signed in. Not a uuid, on purpose.
  actor       text NOT NULL,
  -- Machine-readable verb, e.g. 'credits.adjust', 'member.role',
  -- 'subscription.update'. Grouped on, so keep it stable.
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   uuid,
  account_id  uuid,
  user_id     uuid,
  -- One human sentence, written at the time. Stored rather than
  -- re-derived because the rows it described may since have changed.
  summary     text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_audit_log IS
  'Append-only record of writes made from apps/admin-panel. No FKs on purpose: a row must survive deletion of the account, user or plan it refers to.';

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_recent
  ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_account
  ON admin_audit_log(account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON admin_audit_log(action, created_at DESC);

-- ============================================================
-- 3. Nobody but the panel may read this.
--
-- The panel connects as the database owner, which RLS does not apply
-- to, so enabling RLS with zero policies is exactly right: it closes
-- PostgREST completely. The REVOKE is the belt — a policy added in
-- error later still cannot be reached without a GRANT.
--
-- This log names customers and what was done to their billing. It is
-- an internal operations record, not tenant data.
-- ============================================================
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin_audit_log FROM anon, authenticated;
