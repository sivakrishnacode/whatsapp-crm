-- ============================================================
-- 067_scope_subscription_rpc_to_caller.sql — stop one signed-in user
-- reading another's subscription.
--
-- THE HOLE
--   get_user_subscription(p_user_id uuid) is SECURITY DEFINER — it
--   bypasses RLS by design, so the app can read a subscription row
--   whose own policy is `auth.uid() = user_id`. But EXECUTE is granted
--   to `authenticated` and the body never checks who is calling. Any
--   logged-in user could pass any uuid and get back that person's plan,
--   status, trial dates and limits.
--
--   Not theoretical: `profiles_select` lets a workspace member read
--   their teammates' rows, so an invited agent already has the owner's
--   user_id to hand. Billing is owner-only in the UI; without this the
--   underlying data was one rpc() call away from anyone.
--
-- THE FIX
--   `auth.uid() IS NULL OR auth.uid() = p_user_id`.
--
--   The NULL branch is what keeps the server working: apps/api connects
--   over DATABASE_URL as the database owner, not as a Supabase JWT
--   role, so auth.uid() is NULL there. Trusted server code keeps its
--   arbitrary-user access; a browser session gets itself only.
--
--   Kept as a WHERE clause rather than an IF so the function stays
--   `LANGUAGE sql STABLE` and remains inlinable.
--
-- check_subscription_limit() needs no change: its first act is to
-- SELECT from get_user_subscription(), so a cross-user call now finds
-- nothing and takes its existing "No subscription found" branch, which
-- denies. It fails closed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

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
  WHERE us.user_id = p_user_id
    -- The guard. NULL = trusted server connection; otherwise self only.
    AND (auth.uid() IS NULL OR auth.uid() = p_user_id);
$$;

ALTER FUNCTION get_user_subscription(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION get_user_subscription(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION get_user_subscription(UUID) IS
  'Subscription + plan limits for one user. SECURITY DEFINER, so it carries its own authorization: a JWT caller may only read itself; a server connection (auth.uid() IS NULL) may read anyone.';
