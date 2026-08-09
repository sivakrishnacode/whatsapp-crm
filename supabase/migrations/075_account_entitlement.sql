-- ============================================================
-- 075_account_entitlement.sql — one place that answers "what may this
-- workspace do right now?", and somewhere to count what it has done.
--
-- WHAT WAS WRONG
--
--   Plan limits were not enforced anywhere. `check_subscription_limit`
--   (044) and `increment_usage` exist, and `SubscriptionService` wraps
--   both, and NOTHING CALLS EITHER. Nothing wrote `usage_tracking`, so
--   its counters were zero for every account and the admin panel's usage
--   meters were empty by construction. Nothing branched on subscription
--   status, so a cancelled or expired account kept the whole product.
--
--   The 044 function could not have been used as-is even if it had been
--   called, for two reasons that this migration exists to fix:
--
--   1. IT IS KEYED BY USER. `check_subscription_limit(p_user_id)` reads
--      `get_user_subscription`, and a plan belongs to the WORKSPACE — the
--      subscription row is written for `accounts.owner_user_id`. An
--      invited teammate has no row of their own, so they resolved to
--      "No subscription found" and would have been blocked while the
--      owner sailed through. Everything here takes an account_id.
--
--   2. IT IGNORES TIME. It read the plan's limits off the subscription
--      without ever looking at `status` or `current_period_end`, so an
--      expired trial reported exactly the same entitlement as a paid
--      subscription.
--
-- THE TWO KINDS OF METRIC, AND WHY THEY ARE STORED DIFFERENTLY
--
--   `usage_tracking` conflates them, which is why the admin panel has to
--   warn that its counters "can drift from the account activity counted
--   above". They are not the same sort of number:
--
--   * MONTHLY FLOW — messages sent, broadcasts sent. Events. There is no
--     way to recount them after the fact, so they need a counter, and
--     that counter is `account_usage_monthly` below.
--   * CURRENT STATE — contacts, active flows, team members. These are
--     just `count(*)` on a table that is already the truth. Storing a
--     second copy invents a drift that then has to be documented.
--     `check_account_limit` counts them live.
--
--   Storage is deliberately absent from both: nothing measures it, and a
--   limit checked against a number nobody maintains is theatre.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. account_usage_monthly — the flow counters, per workspace.
--
-- Composite primary key rather than a surrogate id: (account_id,
-- period_start) IS the identity of a row, and making it the key is what
-- lets the increment below be a single conflict-target upsert instead of
-- a read, a branch and a race.
--
-- `period_start` is a DATE at the first of the month, UTC. A date rather
-- than a timestamptz because "which month" must not depend on where the
-- server is standing when it asks.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_usage_monthly (
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start    date NOT NULL,
  messages_sent   integer NOT NULL DEFAULT 0 CHECK (messages_sent >= 0),
  broadcasts_sent integer NOT NULL DEFAULT 0 CHECK (broadcasts_sent >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period_start)
);

COMMENT ON TABLE account_usage_monthly IS
  'Per-workspace monthly counters for metrics that cannot be recounted (messages, broadcasts). Current-state metrics — contacts, flows, team members — are counted live by check_account_limit and deliberately NOT stored here.';

ALTER TABLE account_usage_monthly ENABLE ROW LEVEL SECURITY;

-- The browser may read its own usage so a "4,812 of 5,000 messages" bar
-- needs no round trip. Nothing may write it except the function below,
-- so there is no insert/update policy at all.
DROP POLICY IF EXISTS account_usage_monthly_select ON account_usage_monthly;
CREATE POLICY account_usage_monthly_select ON account_usage_monthly
  FOR SELECT USING (is_account_member(account_id));

-- ============================================================
-- 2. increment_account_usage — the only writer of those counters.
--
-- One statement, so two concurrent sends on the same workspace cannot
-- both read the same count and each write it back. The metric name is an
-- allowlist rather than dynamic SQL: a typo'd metric must fail loudly
-- rather than silently increment nothing, which would look exactly like
-- an account that is under its limit.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_account_usage(
  p_account_id uuid,
  p_metric     text,
  p_delta      integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_delta = 0 THEN
    RETURN;
  END IF;

  IF p_metric NOT IN ('messages', 'broadcasts') THEN
    RAISE EXCEPTION 'increment_account_usage: unknown metric %', p_metric
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO account_usage_monthly AS u (
    account_id, period_start, messages_sent, broadcasts_sent
  )
  VALUES (
    p_account_id,
    date_trunc('month', now() AT TIME ZONE 'UTC')::date,
    CASE WHEN p_metric = 'messages' THEN GREATEST(p_delta, 0) ELSE 0 END,
    CASE WHEN p_metric = 'broadcasts' THEN GREATEST(p_delta, 0) ELSE 0 END
  )
  ON CONFLICT (account_id, period_start) DO UPDATE
     SET messages_sent = GREATEST(
           u.messages_sent
             + CASE WHEN p_metric = 'messages' THEN p_delta ELSE 0 END, 0),
         broadcasts_sent = GREATEST(
           u.broadcasts_sent
             + CASE WHEN p_metric = 'broadcasts' THEN p_delta ELSE 0 END, 0),
         updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.increment_account_usage(uuid, text, integer)
  FROM PUBLIC;

-- ============================================================
-- 3. get_account_entitlement — the single resolver.
--
-- Account in, plan limits and a STANDING out. Every gate in the api asks
-- this and nothing else, so "is this workspace in good standing" has one
-- answer rather than one per call site.
--
-- The standings, and why there are three rather than two:
--
--   good   — trial inside its window, or an active subscription inside
--            its period.
--   grace  — `past_due`, or `active` past its period end. Writes still
--            work. This is dunning, not a lockout: a renewal webhook
--            arriving late must not stop a paying customer from
--            answering their own customers, and an account we are
--            chasing for payment is more likely to pay if the product
--            still works. It shows up as at-risk MRR in the admin panel,
--            which is where a human decides what to do about it.
--   lapsed — cancelled, expired, no subscription at all, or a trial
--            whose end date has passed. Reads stay; writes stop.
--
-- A trial past `trial_end_at` reads as lapsed here even if the sweep job
-- has not run yet. The sweep makes the stored status honest; this makes
-- the entitlement honest regardless. Neither depends on the other.
--
-- SECURITY INVOKER with EXECUTE revoked from PUBLIC, per the house rule:
-- apps/api connects as the database owner and needs no elevation, and a
-- DEFINER function granted to `authenticated` would let any signed-in
-- user read any workspace's plan by passing its id (the trap migration
-- 032 had to undo, and 067 had to guard around). The browser reaches
-- this through the api, never through PostgREST.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_account_entitlement(p_account_id uuid)
RETURNS TABLE (
  account_id             uuid,
  owner_user_id          uuid,
  subscription_id        uuid,
  plan_id                uuid,
  plan_name              text,
  plan_display_name      text,
  status                 subscription_status_enum,
  trial_end_at           timestamptz,
  current_period_end     timestamptz,
  standing               text,
  writes_allowed         boolean,
  max_contacts           integer,
  max_messages_monthly   integer,
  max_broadcasts_monthly integer,
  max_flows              integer,
  max_team_members       integer,
  max_storage_mb         integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH resolved AS (
    SELECT
      a.id            AS account_id,
      a.owner_user_id AS owner_user_id,
      s.id            AS subscription_id,
      p.id            AS plan_id,
      p.name          AS plan_name,
      p.display_name  AS plan_display_name,
      s.status        AS status,
      s.trial_end_at  AS trial_end_at,
      s.current_period_end AS current_period_end,
      p.max_contacts,
      p.max_messages_monthly,
      p.max_broadcasts_monthly,
      p.max_flows,
      p.max_team_members,
      p.max_storage_mb
    FROM accounts a
    -- The subscription hangs off the OWNER: a plan belongs to the
    -- workspace, and OnboardingService always writes it there.
    LEFT JOIN user_subscriptions s ON s.user_id = a.owner_user_id
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    WHERE a.id = p_account_id
  ), graded AS (
    SELECT r.*,
      CASE
        WHEN r.status IS NULL THEN 'lapsed'
        WHEN r.status = 'trial' THEN
          -- A NULL end date on a trial is a data anomaly, not a signal to
          -- lock someone out. Fail open, same as the dashboard's own gate.
          CASE WHEN r.trial_end_at IS NULL OR r.trial_end_at > now()
               THEN 'good' ELSE 'lapsed' END
        WHEN r.status = 'active' THEN
          CASE WHEN r.current_period_end IS NULL
                 OR r.current_period_end > now()
               THEN 'good' ELSE 'grace' END
        WHEN r.status = 'past_due' THEN 'grace'
        ELSE 'lapsed'
      END AS standing
    FROM resolved r
  )
  SELECT
    g.account_id, g.owner_user_id, g.subscription_id, g.plan_id,
    g.plan_name, g.plan_display_name, g.status, g.trial_end_at,
    g.current_period_end,
    g.standing,
    g.standing <> 'lapsed' AS writes_allowed,
    g.max_contacts, g.max_messages_monthly, g.max_broadcasts_monthly,
    g.max_flows, g.max_team_members, g.max_storage_mb
  FROM graded g;
$$;

REVOKE ALL ON FUNCTION public.get_account_entitlement(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.get_account_entitlement(uuid) IS
  'Plan limits plus a standing (good/grace/lapsed) for one workspace, resolved through accounts.owner_user_id. The single source for every entitlement gate in apps/api. Account-scoped on purpose: the per-user get_user_subscription() resolves to nothing for an invited teammate.';

-- ============================================================
-- 4. check_account_limit — one metric, checked before it is spent.
--
-- Returns a row rather than a boolean so the caller can tell a customer
-- WHICH limit they hit and how close they were, which is the difference
-- between an upgrade prompt and a mystery.
--
-- `p_increment` is checked, not assumed to be 1: a broadcast to 4,000
-- recipients has to be refused before the fan-out enqueues 4,000 jobs,
-- not on recipient 101.
--
-- A NULL limit is unlimited (that is how `max_flows` encodes it on the
-- Growth and Enterprise rows). A lapsed standing short-circuits before
-- any counting: nothing about the numbers matters if the subscription
-- has stopped.
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_account_limit(
  p_account_id uuid,
  p_limit_type text,
  p_increment  integer DEFAULT 1
)
RETURNS TABLE (
  allowed       boolean,
  current_usage integer,
  limit_value   integer,
  standing      text,
  reason        text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ent   record;
  v_limit integer;
  v_used  integer;
  v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO v_ent FROM get_account_entitlement(p_account_id);

  IF NOT FOUND THEN
    -- No such account. Fail closed: an unknown workspace is not one to
    -- extend credit to.
    RETURN QUERY SELECT false, 0, 0, 'lapsed'::text, 'unknown_account'::text;
    RETURN;
  END IF;

  IF NOT v_ent.writes_allowed THEN
    RETURN QUERY
      SELECT false, 0, 0, v_ent.standing, 'subscription_lapsed'::text;
    RETURN;
  END IF;

  CASE p_limit_type
    WHEN 'messages' THEN
      v_limit := v_ent.max_messages_monthly;
      SELECT COALESCE(u.messages_sent, 0) INTO v_used
        FROM account_usage_monthly u
       WHERE u.account_id = p_account_id AND u.period_start = v_month;
    WHEN 'broadcasts' THEN
      v_limit := v_ent.max_broadcasts_monthly;
      SELECT COALESCE(u.broadcasts_sent, 0) INTO v_used
        FROM account_usage_monthly u
       WHERE u.account_id = p_account_id AND u.period_start = v_month;
    -- The three below are current state, counted from the tables that
    -- already hold the truth. No counter, so no drift to document.
    WHEN 'contacts' THEN
      v_limit := v_ent.max_contacts;
      SELECT count(*) INTO v_used FROM contacts c
       WHERE c.account_id = p_account_id;
    WHEN 'flows' THEN
      v_limit := v_ent.max_flows;
      SELECT count(*) INTO v_used FROM flows f
       WHERE f.account_id = p_account_id AND f.status = 'active';
    WHEN 'team_members' THEN
      v_limit := v_ent.max_team_members;
      SELECT count(*) INTO v_used FROM profiles pr
       WHERE pr.account_id = p_account_id;
    WHEN 'storage' THEN
      -- Nothing measures storage. Saying so is honest; enforcing a limit
      -- against a number nobody maintains is not.
      RETURN QUERY
        SELECT true, 0, v_ent.max_storage_mb, v_ent.standing,
               'not_metered'::text;
      RETURN;
    ELSE
      RAISE EXCEPTION 'check_account_limit: unknown limit type %', p_limit_type
        USING ERRCODE = '22023';
  END CASE;

  v_used := COALESCE(v_used, 0);

  IF v_limit IS NULL THEN
    RETURN QUERY
      SELECT true, v_used, NULL::integer, v_ent.standing, 'unlimited'::text;
    RETURN;
  END IF;

  IF v_used + GREATEST(p_increment, 0) > v_limit THEN
    RETURN QUERY
      SELECT false, v_used, v_limit, v_ent.standing, 'limit_reached'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_used, v_limit, v_ent.standing, 'ok'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.check_account_limit(uuid, text, integer)
  FROM PUBLIC;

-- ============================================================
-- 5. Backfill this month's counters from what already happened.
--
-- Without this, enforcement starts every workspace at zero for the
-- current month — so the month enforcement is switched on is the one
-- month nobody can exceed. Outbound messages are counted from
-- `messages`, and broadcasts from rows that actually reached a sending
-- state.
--
-- `messages` has no direction column: `sender_type` is
-- 'customer' | 'agent' | 'bot', so anything that is not from the customer
-- is something we sent. A bot reply costs the same as a human one.
-- ============================================================
INSERT INTO account_usage_monthly (
  account_id, period_start, messages_sent, broadcasts_sent
)
SELECT
  a.id,
  date_trunc('month', now() AT TIME ZONE 'UTC')::date,
  COALESCE((
    SELECT count(*) FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = a.id
      AND m.sender_type <> 'customer'
      AND m.created_at >= date_trunc('month', now())
  ), 0),
  COALESCE((
    SELECT count(*) FROM broadcasts b
    WHERE b.account_id = a.id
      AND b.status IN ('sending', 'sent', 'failed')
      AND b.created_at >= date_trunc('month', now())
  ), 0)
FROM accounts a
ON CONFLICT (account_id, period_start) DO NOTHING;
