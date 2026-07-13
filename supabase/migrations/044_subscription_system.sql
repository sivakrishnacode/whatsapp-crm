-- ============================================================
-- 044_subscription_system.sql — Subscription & Billing System
--
-- Implements per-user subscription model with FREE, STARTER, and GROWTH
-- plans. Includes usage tracking, payment gateway integration hooks,
-- and limit enforcement infrastructure.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TYPES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status_enum') THEN
    CREATE TYPE subscription_status_enum AS ENUM ('active', 'trial', 'past_due', 'cancelled', 'expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_cycle_enum') THEN
    CREATE TYPE billing_cycle_enum AS ENUM ('monthly', 'yearly');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method_enum') THEN
    CREATE TYPE payment_method_enum AS ENUM ('stripe', 'razorpay', 'manual');
  END IF;
END $$;

-- ============================================================
-- SUBSCRIPTION_PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  price_monthly NUMERIC(10,2) DEFAULT 0,
  price_yearly NUMERIC(10,2) DEFAULT 0,
  stripe_price_id_monthly TEXT,
  stripe_price_id_yearly TEXT,
  razorpay_plan_id TEXT,
  max_contacts INTEGER NOT NULL DEFAULT 0,
  max_messages_monthly INTEGER NOT NULL DEFAULT 0,
  max_broadcasts_monthly INTEGER NOT NULL DEFAULT 0,
  max_flows INTEGER, -- NULL represents unlimited
  max_team_members INTEGER NOT NULL DEFAULT 0,
  max_storage_mb INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER,
  features JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_name ON subscription_plans(name);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_active ON subscription_plans(is_active);

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscription_plans_select ON subscription_plans;
DROP POLICY IF EXISTS subscription_plans_insert ON subscription_plans;
DROP POLICY IF EXISTS subscription_plans_update ON subscription_plans;
DROP POLICY IF EXISTS subscription_plans_delete ON subscription_plans;
DROP POLICY IF EXISTS subscription_plans_manage ON subscription_plans;

-- Everyone can read active plans (for pricing page)
CREATE POLICY subscription_plans_select ON subscription_plans FOR SELECT USING (is_active = true);
-- Service role can manage plans
CREATE POLICY subscription_plans_manage ON subscription_plans FOR ALL USING (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS set_updated_at ON subscription_plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscription_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- USER_SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  status subscription_status_enum NOT NULL DEFAULT 'active',
  billing_cycle billing_cycle_enum,
  trial_start_at TIMESTAMPTZ,
  trial_end_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  stripe_subscription_id TEXT,
  razorpay_subscription_id TEXT,
  payment_method payment_method_enum DEFAULT 'manual',
  manually_assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan_id ON user_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_trial_end ON user_subscriptions(trial_end_at) WHERE trial_end_at IS NOT NULL;

ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_subscriptions_select_own ON user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_select_admin ON user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_insert ON user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_update_own ON user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_update_admin ON user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_delete ON user_subscriptions;

-- Users can read their own subscription
CREATE POLICY user_subscriptions_select_own ON user_subscriptions FOR SELECT
  USING (auth.uid() = user_id);
-- Service role can read all subscriptions
CREATE POLICY user_subscriptions_select_admin ON user_subscriptions FOR SELECT
  USING (auth.role() = 'service_role');
-- Service role can insert subscriptions
CREATE POLICY user_subscriptions_insert ON user_subscriptions FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
-- Users can update limited fields (cancel_at_period_end)
CREATE POLICY user_subscriptions_update_own ON user_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
-- Service role can update all
CREATE POLICY user_subscriptions_update_admin ON user_subscriptions FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
-- Service role can delete
CREATE POLICY user_subscriptions_delete ON user_subscriptions FOR DELETE
  USING (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS set_updated_at ON user_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- USAGE_TRACKING
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  contacts_count INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  broadcasts_sent INTEGER DEFAULT 0,
  flows_active INTEGER DEFAULT 0,
  storage_used_mb INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_tracking_user_period ON usage_tracking(user_id, period_start);
CREATE INDEX IF NOT EXISTS idx_usage_tracking_period ON usage_tracking(period_end);

ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_tracking_select_own ON usage_tracking;
DROP POLICY IF EXISTS usage_tracking_insert_service ON usage_tracking;
DROP POLICY IF EXISTS usage_tracking_update_service ON usage_tracking;
DROP POLICY IF EXISTS usage_tracking_delete_service ON usage_tracking;

-- Users can read their own usage
CREATE POLICY usage_tracking_select_own ON usage_tracking FOR SELECT
  USING (auth.uid() = user_id);
-- Service role can manage usage
CREATE POLICY usage_tracking_insert_service ON usage_tracking FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY usage_tracking_update_service ON usage_tracking FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY usage_tracking_delete_service ON usage_tracking FOR DELETE
  USING (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS set_updated_at ON usage_tracking;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON usage_tracking
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- INSERT DEFAULT PLANS
-- ============================================================
DO $$
BEGIN
  -- FREE Plan
  INSERT INTO subscription_plans (
    name, display_name, description,
    price_monthly, price_yearly,
    max_contacts, max_messages_monthly, max_broadcasts_monthly,
    max_flows, max_team_members, max_storage_mb,
    trial_days, features, is_active
  ) VALUES (
    'FREE',
    'Free',
    'Perfect for getting started with WhatsApp CRM',
    0, 0,
    100, 500, 5,
    3, 1, 100,
    NULL,
    '["100 contacts", "500 messages/month", "5 broadcasts/month", "3 flows", "1 team member", "100MB storage"]'::jsonb,
    true
  ) ON CONFLICT (name) DO NOTHING;

  -- STARTER Plan
  INSERT INTO subscription_plans (
    name, display_name, description,
    price_monthly, price_yearly,
    max_contacts, max_messages_monthly, max_broadcasts_monthly,
    max_flows, max_team_members, max_storage_mb,
    trial_days, features, is_active
  ) VALUES (
    'STARTER',
    'Starter',
    'For growing businesses with more automation needs',
    300.00, 3000.00,
    1000, 5000, 25,
    10, 3, 1024,
    15,
    '["1,000 contacts", "5,000 messages/month", "25 broadcasts/month", "10 flows", "3 team members", "1GB storage", "Priority support"]'::jsonb,
    true
  ) ON CONFLICT (name) DO NOTHING;

  -- GROWTH Plan
  INSERT INTO subscription_plans (
    name, display_name, description,
    price_monthly, price_yearly,
    max_contacts, max_messages_monthly, max_broadcasts_monthly,
    max_flows, max_team_members, max_storage_mb,
    trial_days, features, is_active
  ) VALUES (
    'GROWTH',
    'Growth',
    'For scaling teams with advanced automation',
    500.00, 5000.00,
    10000, 50000, 100,
    NULL, 10, 10240,
    15,
    '["10,000 contacts", "50,000 messages/month", "100 broadcasts/month", "Unlimited flows", "10 team members", "10GB storage", "Priority support", "Advanced analytics"]'::jsonb,
    true
  ) ON CONFLICT (name) DO NOTHING;
END $$;

-- ============================================================
-- BACKFILL EXISTING USERS WITH FREE PLAN
-- ============================================================
DO $$
DECLARE
  v_free_plan_id UUID;
BEGIN
  -- Get the FREE plan ID
  SELECT id INTO v_free_plan_id
  FROM subscription_plans
  WHERE name = 'FREE'
  LIMIT 1;

  IF v_free_plan_id IS NOT NULL THEN
    -- Insert subscriptions for users who don't have one
    INSERT INTO user_subscriptions (user_id, plan_id, status, payment_method)
    SELECT u.id, v_free_plan_id, 'active', 'manual'
    FROM auth.users u
    WHERE NOT EXISTS (
      SELECT 1 FROM user_subscriptions us WHERE us.user_id = u.id
    );
  END IF;
END $$;

-- ============================================================
-- BACKFILL USAGE TRACKING FOR CURRENT MONTH
-- ============================================================
DO $$
DECLARE
  v_period_start TIMESTAMPTZ := date_trunc('month', NOW());
  v_period_end TIMESTAMPTZ := date_trunc('month', NOW() + INTERVAL '1 month');
BEGIN
  INSERT INTO usage_tracking (user_id, period_start, period_end, contacts_count, messages_sent, broadcasts_sent, flows_active, storage_used_mb)
  SELECT 
    u.id,
    v_period_start,
    v_period_end,
    (SELECT COUNT(*) FROM contacts WHERE user_id = u.id),
    0, -- Messages would need to be counted from messages table via conversations
    0, -- Broadcasts would need to be counted
    (SELECT COUNT(*) FROM flows WHERE user_id = u.id),
    0 -- Storage would need to be calculated from storage buckets
  FROM auth.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM usage_tracking ut 
    WHERE ut.user_id = u.id 
      AND ut.period_start = v_period_start
  );
END $$;

-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

-- Get user's current subscription with plan details
CREATE OR REPLACE FUNCTION get_user_subscription(p_user_id UUID)
RETURNS TABLE (
  subscription_id UUID,
  plan_id UUID,
  plan_name TEXT,
  plan_display_name TEXT,
  status subscription_status_enum,
  billing_cycle billing_cycle_enum,
  trial_start_at TIMESTAMPTZ,
  trial_end_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN,
  payment_method payment_method_enum,
  max_contacts INTEGER,
  max_messages_monthly INTEGER,
  max_broadcasts_monthly INTEGER,
  max_flows INTEGER,
  max_team_members INTEGER,
  max_storage_mb INTEGER,
  trial_days INTEGER,
  features JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    us.id as subscription_id,
    us.plan_id,
    sp.name as plan_name,
    sp.display_name as plan_display_name,
    us.status,
    us.billing_cycle,
    us.trial_start_at,
    us.trial_end_at,
    us.current_period_start,
    us.current_period_end,
    us.cancel_at_period_end,
    us.payment_method,
    sp.max_contacts,
    sp.max_messages_monthly,
    sp.max_broadcasts_monthly,
    sp.max_flows,
    sp.max_team_members,
    sp.max_storage_mb,
    sp.trial_days,
    sp.features
  FROM user_subscriptions us
  JOIN subscription_plans sp ON us.plan_id = sp.id
  WHERE us.user_id = p_user_id;
$$;

ALTER FUNCTION get_user_subscription(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION get_user_subscription(UUID) TO authenticated, service_role;

-- Check if user can perform an action based on limits
CREATE OR REPLACE FUNCTION check_subscription_limit(
  p_user_id UUID,
  p_limit_type TEXT,
  p_increment INTEGER DEFAULT 1
)
RETURNS TABLE (
  allowed BOOLEAN,
  current_usage INTEGER,
  limit_value INTEGER,
  reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subscription RECORD;
  v_usage RECORD;
  v_current_month_start TIMESTAMPTZ := date_trunc('month', NOW());
  v_limit_value INTEGER;
  v_current_usage INTEGER;
BEGIN
  -- Get subscription
  SELECT * INTO v_subscription
  FROM get_user_subscription(p_user_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0, 'No subscription found'::TEXT;
    RETURN;
  END IF;

  -- Get current usage
  SELECT * INTO v_usage
  FROM usage_tracking
  WHERE user_id = p_user_id
    AND period_start = v_current_month_start
  LIMIT 1;

  IF NOT FOUND THEN
    v_usage.contacts_count := 0;
    v_usage.messages_sent := 0;
    v_usage.broadcasts_sent := 0;
    v_usage.flows_active := 0;
    v_usage.storage_used_mb := 0;
  END IF;

  -- Determine limit based on type
  CASE p_limit_type
    WHEN 'contacts' THEN
      v_limit_value := v_subscription.max_contacts;
      v_current_usage := v_usage.contacts_count;
    WHEN 'messages' THEN
      v_limit_value := v_subscription.max_messages_monthly;
      v_current_usage := v_usage.messages_sent;
    WHEN 'broadcasts' THEN
      v_limit_value := v_subscription.max_broadcasts_monthly;
      v_current_usage := v_usage.broadcasts_sent;
    WHEN 'flows' THEN
      v_limit_value := v_subscription.max_flows;
      v_current_usage := v_usage.flows_active;
    WHEN 'team_members' THEN
      v_limit_value := v_subscription.max_team_members;
      -- Count team members from profiles with same account_id
      SELECT COUNT(*) INTO v_current_usage
      FROM profiles p
      WHERE p.account_id = (SELECT account_id FROM profiles WHERE user_id = p_user_id);
    WHEN 'storage' THEN
      v_limit_value := v_subscription.max_storage_mb;
      v_current_usage := v_usage.storage_used_mb;
    ELSE
      RETURN QUERY SELECT false, 0, 0, 'Unknown limit type'::TEXT;
      RETURN;
  END CASE;

  -- Check if unlimited (NULL means unlimited)
  IF v_limit_value IS NULL THEN
    RETURN QUERY SELECT true, v_current_usage, NULL, 'Unlimited'::TEXT;
    RETURN;
  END IF;

  -- Check if within limit
  IF v_current_usage + p_increment <= v_limit_value THEN
    RETURN QUERY SELECT true, v_current_usage, v_limit_value, 'Within limit'::TEXT;
  ELSE
    RETURN QUERY SELECT false, v_current_usage, v_limit_value, 
      'Limit exceeded: ' || v_current_usage || ' + ' || p_increment || ' > ' || v_limit_value::TEXT;
  END IF;
END;
$$;

ALTER FUNCTION check_subscription_limit(UUID, TEXT, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION check_subscription_limit(UUID, TEXT, INTEGER) TO authenticated, service_role;

-- Increment usage counter
CREATE OR REPLACE FUNCTION increment_usage(
  p_user_id UUID,
  p_type TEXT,
  p_increment INTEGER DEFAULT 1
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_month_start TIMESTAMPTZ := date_trunc('month', NOW());
  v_current_month_end TIMESTAMPTZ := date_trunc('month', NOW() + INTERVAL '1 month');
BEGIN
  INSERT INTO usage_tracking (user_id, period_start, period_end)
  VALUES (p_user_id, v_current_month_start, v_current_month_end)
  ON CONFLICT (user_id, period_start) DO NOTHING;

  CASE p_type
    WHEN 'contacts' THEN
      UPDATE usage_tracking
      SET contacts_count = contacts_count + p_increment
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'messages' THEN
      UPDATE usage_tracking
      SET messages_sent = messages_sent + p_increment
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'broadcasts' THEN
      UPDATE usage_tracking
      SET broadcasts_sent = broadcasts_sent + p_increment
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'flows' THEN
      UPDATE usage_tracking
      SET flows_active = flows_active + p_increment
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'storage' THEN
      UPDATE usage_tracking
      SET storage_used_mb = storage_used_mb + p_increment
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    ELSE
      RETURN false;
  END CASE;

  RETURN true;
END;
$$;

ALTER FUNCTION increment_usage(UUID, TEXT, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION increment_usage(UUID, TEXT, INTEGER) TO authenticated, service_role;

-- Decrement usage counter
CREATE OR REPLACE FUNCTION decrement_usage(
  p_user_id UUID,
  p_type TEXT,
  p_decrement INTEGER DEFAULT 1
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_month_start TIMESTAMPTZ := date_trunc('month', NOW());
BEGIN
  CASE p_type
    WHEN 'contacts' THEN
      UPDATE usage_tracking
      SET contacts_count = GREATEST(0, contacts_count - p_decrement)
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'messages' THEN
      UPDATE usage_tracking
      SET messages_sent = GREATEST(0, messages_sent - p_decrement)
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'broadcasts' THEN
      UPDATE usage_tracking
      SET broadcasts_sent = GREATEST(0, broadcasts_sent - p_decrement)
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'flows' THEN
      UPDATE usage_tracking
      SET flows_active = GREATEST(0, flows_active - p_decrement)
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    WHEN 'storage' THEN
      UPDATE usage_tracking
      SET storage_used_mb = GREATEST(0, storage_used_mb - p_decrement)
      WHERE user_id = p_user_id AND period_start = v_current_month_start;
    ELSE
      RETURN false;
  END CASE;

  RETURN true;
END;
$$;

ALTER FUNCTION decrement_usage(UUID, TEXT, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION decrement_usage(UUID, TEXT, INTEGER) TO authenticated, service_role;

-- Reset monthly counters (called by cron)
CREATE OR REPLACE FUNCTION reset_monthly_usage()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Reset message and broadcast counters for the new month
  UPDATE usage_tracking
  SET 
    messages_sent = 0,
    broadcasts_sent = 0
  WHERE period_start = date_trunc('month', NOW());
END;
$$;

ALTER FUNCTION reset_monthly_usage() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION reset_monthly_usage() TO service_role;
