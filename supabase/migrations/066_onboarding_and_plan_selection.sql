-- ============================================================
-- 066_onboarding_and_plan_selection.sql — guided signup: workspace
-- setup, qualification answers, and a mandatory plan choice.
--
-- WHAT CHANGES
--   1. handle_new_user learns about OAuth identities (Google puts the
--      display name under `name`, not `full_name`, and carries an
--      avatar we were throwing away).
--   2. account_onboarding — the wizard's answers and its completion
--      marker. One row per account.
--   3. plan_enquiries — Enterprise "talk to sales" submissions. There
--      is no custom-price column anywhere in this database, so an
--      Enterprise deal lives here until a human sets it up.
--   4. ENTERPRISE plan row.
--   5. FREE is deactivated. Every account now picks a paid tier
--      (trialled) at signup; there is no free landing spot.
--
-- WHY FREE GOES AWAY RATHER THAN GETTING DELETED
--   Existing rows reference it by FK (ON DELETE RESTRICT), and the
--   admin panel's historical views join through plan_id. Flipping
--   is_active hides it from `subscription_plans_select` (whose RLS
--   predicate is literally `is_active = true`), which is all the
--   product needs, without rewriting history.
--
-- NOT IN HERE: the one-off wipe of existing user_subscriptions rows.
--   That lives in scripts/sql/reset-subscriptions.sql precisely because
--   migrations in this repo are re-runnable — a DELETE here would clear
--   every subscription again on every replay.
--
-- Idempotent — safe to run multiple times.
-- ============================================================


-- ============================================================
-- 1) Signup trigger — carry OAuth profile data across
--
-- The Google provider populates raw_user_meta_data with `name`,
-- `full_name`, `avatar_url` and `picture` (which of them appear
-- depends on the scopes granted). The previous version read only
-- `full_name`, so a Google signup produced an account named after
-- the user's email address and a profile with a blank name.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name  TEXT;
  v_avatar_url TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'name', ''),
    ''
  );

  v_avatar_url := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'avatar_url', ''),
    NULLIF(NEW.raw_user_meta_data->>'picture', '')
  );

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, avatar_url, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_avatar_url, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- Recreate defensively: CREATE OR REPLACE above keeps the existing
-- trigger binding, but a database restored from before 017 may not
-- have the trigger at all.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- 2) account_onboarding — wizard answers + completion marker
--
-- Keyed by account, not user: the wizard configures the workspace,
-- and an invited member joining an already-onboarded account must
-- not be asked to name it again.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_onboarding (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,

  -- Which parts of the product they came for. Free-form keys owned by
  -- the web app (see ONBOARDING_GOALS in lib/onboarding/questions.ts);
  -- deliberately not an enum, because the list will churn faster than
  -- migrations should.
  goals            TEXT[] NOT NULL DEFAULT '{}',

  -- Bucketed rather than numeric: nobody types an accurate headcount,
  -- and buckets are what sales actually filters on.
  team_size        TEXT,

  referral_source  TEXT,
  -- Populated only when referral_source = 'other'.
  referral_other   TEXT,

  -- NULL until the last step is submitted. This is the flag the hard
  -- gate reads; a half-finished wizard must not let anyone through.
  completed_at     TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE account_onboarding IS
  'One row per account. Answers from the /welcome wizard plus the completion marker the dashboard gate reads.';
COMMENT ON COLUMN account_onboarding.completed_at IS
  'NULL = wizard unfinished. Set only when the plan step succeeds, so an abandoned wizard replays from the start.';

CREATE INDEX IF NOT EXISTS idx_account_onboarding_completed
  ON account_onboarding(completed_at);

ALTER TABLE account_onboarding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_onboarding_select ON account_onboarding;
CREATE POLICY account_onboarding_select ON account_onboarding FOR SELECT
  USING (is_account_member(account_id));

-- Admin+ to write: naming the workspace and choosing the plan are
-- account-wide acts, same bar as the rest of account settings.
DROP POLICY IF EXISTS account_onboarding_write ON account_onboarding;
CREATE POLICY account_onboarding_write ON account_onboarding FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON account_onboarding;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_onboarding
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 3) plan_enquiries — Enterprise "talk to sales"
--
-- user_subscriptions has no amount column and no history (see the
-- admin panel's lib/queries/sql.ts), so a negotiated Enterprise price
-- has nowhere to live. Until that changes, the enquiry is the record:
-- sales reads it here and provisions by hand.
-- ============================================================
CREATE TABLE IF NOT EXISTS plan_enquiries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  full_name    TEXT NOT NULL,
  work_email   TEXT NOT NULL,
  phone        TEXT,
  company_size TEXT,
  message      TEXT,

  -- pending → contacted → closed. TEXT + CHECK rather than an enum so
  -- sales can gain a stage without a migration on the hot path.
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'contacted', 'closed')),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE plan_enquiries IS
  'Enterprise pricing enquiries from the onboarding wizard and the pricing page. The only place a custom-price conversation is recorded — there is no amount column on user_subscriptions.';

CREATE INDEX IF NOT EXISTS idx_plan_enquiries_account ON plan_enquiries(account_id);
CREATE INDEX IF NOT EXISTS idx_plan_enquiries_status ON plan_enquiries(status, created_at DESC);

ALTER TABLE plan_enquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_enquiries_select ON plan_enquiries;
CREATE POLICY plan_enquiries_select ON plan_enquiries FOR SELECT
  USING (is_account_member(account_id));

-- No client INSERT policy: every row is written server-side by the
-- Nest onboarding controller, which stamps account_id and user_id from
-- the verified session rather than trusting the request body.
DROP POLICY IF EXISTS plan_enquiries_write ON plan_enquiries;
CREATE POLICY plan_enquiries_write ON plan_enquiries FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS set_updated_at ON plan_enquiries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plan_enquiries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 4) ENTERPRISE plan
--
-- price_monthly stays 0 and means "not priced here", NOT "free". The
-- admin panel derives MRR as plan price × subscription, so an
-- Enterprise account contributes nothing to that figure — the panel
-- reports the headcount separately instead of inventing a number.
--
-- Limits are set to the sentinel used elsewhere for unlimited:
-- max_flows NULL. The integer limits have no NULL convention
-- (check_subscription_limit compares them numerically), so they get a
-- deliberately unreachable ceiling rather than a fake infinity.
-- ============================================================
INSERT INTO subscription_plans (
  name, display_name, description,
  price_monthly, price_yearly,
  max_contacts, max_messages_monthly, max_broadcasts_monthly,
  max_flows, max_team_members, max_storage_mb,
  trial_days, features, is_active
) VALUES (
  'ENTERPRISE',
  'Enterprise',
  'Custom limits, onboarding support and an SLA for larger teams',
  0, 0,
  1000000, 5000000, 10000,
  NULL, 500, 1048576,
  15,
  '["Unlimited contacts", "Unlimited messages", "Unlimited broadcasts", "Unlimited flows", "Unlimited team members", "1TB storage", "Dedicated account manager", "Custom SLA", "Onboarding & migration support"]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description  = EXCLUDED.description,
  max_flows    = EXCLUDED.max_flows,
  features     = EXCLUDED.features,
  is_active    = true;


-- ============================================================
-- 5) Retire the free tier
--
-- is_active = false removes it from `subscription_plans_select`
-- (RLS: USING (is_active = true)), so the pricing page and the wizard
-- stop offering it. Rows already pointing at it keep working — the
-- FK and get_user_subscription() don't filter on is_active.
-- ============================================================
UPDATE subscription_plans
   SET is_active = false
 WHERE name = 'FREE'
   AND is_active IS DISTINCT FROM false;
