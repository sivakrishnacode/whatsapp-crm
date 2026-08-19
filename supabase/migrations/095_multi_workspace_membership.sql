-- ============================================================
-- 095_multi_workspace_membership.sql — one user, many workspaces
--
-- Migration 017 wrote its own constraint down in a comment:
--
--     -- One account per user (the locked design decision — single
--     -- membership). Drops automatically if we ever relax to many-to-many.
--
-- This is that relaxation. A user may now hold a membership in any
-- number of workspaces with a different role in each, and switch
-- between them without signing out — the agency case, where one login
-- administers a dozen clients.
--
-- WHAT PHASE 1 IS
--
--   Membership. `account_members` becomes the source of truth, the
--   invite flow stops destroying the joiner's own workspace, and the
--   RPCs that used to infer "the caller's account" from a single
--   profile row now take an explicit account id.
--
-- THIS IS THE EXPAND HALF OF A TWO-STEP DEPLOY
--
--   Everything here is additive or behaviour-preserving, so it can be
--   applied to a live database with the CURRENT code still running.
--   `profiles.account_id` / `profiles.account_role` survive untouched;
--   096_drop_profile_membership_columns.sql removes them once the new
--   code is out. Run order: 095 → deploy → 096.
--
--   Applying 095 and 096 together would 500 the whole product between
--   the migration and the end of the deploy, because apps/api resolves
--   every dashboard request's workspace through
--   `profile.findUnique({ where: { userId } })`.
--
-- WHAT PHASE 1 IS DELIBERATELY NOT
--
--   ⚠️ `idx_accounts_one_per_owner` STAYS. It is what keeps billing
--   correct while the money is still keyed by user: a plan is resolved
--   as `user_subscriptions.user_id = accounts.owner_user_id`, and the
--   moment one user can own two workspaces that join matches the same
--   subscription row twice and the second workspace is silently free.
--   So in phase 1 nobody can CREATE a workspace — you get extra
--   memberships by being invited into somebody else's, or by an
--   operator attaching you in the admin panel. Self-serve creation
--   arrives in phase 2 together with account-scoped subscriptions
--   (`user_subscriptions.account_id` UNIQUE, `user_id` demoted to
--   payer), and that is the migration that drops this index.
--
--   Read that as a hard sequencing constraint, not a preference:
--   dropping the index without moving the subscription key is a
--   revenue hole, and moving the subscription key is a change to both
--   payment gateways, three webhook handlers and every entitlement
--   gate.
--
-- WHY THIS IS SMALLER THAN IT LOOKS
--
--   `is_account_member(account_id, min_role)` backs 227 RLS policies
--   across 30 migrations. It is SECURITY DEFINER and reads `profiles`
--   by `auth.uid()`. Rewriting that ONE body against `account_members`
--   makes all 227 policies multi-workspace-correct with no other edit.
--
--   Which yields the property the whole feature rests on: RLS
--   authorises by MEMBERSHIP, so "which workspace am I looking at" is
--   a selection, not a security boundary. A tampered workspace cookie
--   naming a foreign account fails RLS in the browser and fails the
--   membership check in the Nest guard. No JWT claim, no custom access
--   token hook, nothing to keep in sync.
--
--   What did NOT route through the helper — 22 predicates that inlined
--   `profiles p WHERE p.user_id = auth.uid()` — is rewritten below,
--   and rewritten to CALL the helper rather than to re-inline the same
--   join against the new table. Five of them are storage-bucket
--   policies, which are browser-written and therefore the only gate on
--   those uploads.
--
-- Idempotent — safe to run multiple times.
-- ============================================================


-- ============================================================
-- 1. account_members — the membership table
--
-- `(account_id, user_id)` IS the identity of a membership, so it is
-- the primary key. No surrogate id: nothing references a membership
-- row, and a surrogate would let the same person be inserted twice.
--
-- `role` moves here from `profiles.account_role`, which is the whole
-- point — a role is a property of a membership, not of a person. The
-- same user is `owner` of their own workspace and `viewer` in a
-- client's.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.account_members (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        account_role_enum NOT NULL,
  -- Who put them here. NULL means the signup trigger or the 017
  -- backfill did — i.e. nobody chose it — which is a different fact
  -- from an admin having granted access, and the admin panel shows it.
  invited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

COMMENT ON TABLE public.account_members IS
  'One row per (workspace, user) membership with the role held in THAT workspace. The source of truth for is_account_member() and therefore for every RLS policy in this database. A user may hold many rows; profiles holds none of this any more.';

-- The PK covers "who is in this workspace". This index covers the
-- other direction — "which workspaces is this user in" — which is the
-- switcher's query and runs on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_account_members_user
  ON public.account_members(user_id);

-- Role-filtered membership reads (the 'admin+' policy tier) hit this.
CREATE INDEX IF NOT EXISTS idx_account_members_account_role
  ON public.account_members(account_id, role);

-- At most one owner per workspace. `accounts.owner_user_id` is the
-- denormalised pointer and `transfer_account_ownership` keeps the two
-- in step; this index is what stops them diverging into two owners.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_members_one_owner
  ON public.account_members(account_id)
  WHERE role = 'owner';

ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.account_members;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- backfill from profiles ---------------------------------
--
-- Guarded on the column still existing so a re-run after the drop in
-- section 4 does not fail to parse. `ON CONFLICT DO NOTHING` makes the
-- copy itself re-runnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'account_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO public.account_members (account_id, user_id, role)
      SELECT p.account_id, p.user_id, p.account_role
      FROM public.profiles p
      WHERE p.account_id IS NOT NULL
        AND p.account_role IS NOT NULL
      ON CONFLICT (account_id, user_id) DO NOTHING
    $ins$;
  END IF;
END $$;

-- Heal any account whose owner never had a profile row pointing at it
-- (possible for rows created outside handle_new_user). Without this
-- the owner would have no membership and would lose access to their
-- own workspace the moment is_account_member is repointed below.
INSERT INTO public.account_members (account_id, user_id, role)
SELECT a.id, a.owner_user_id, 'owner'
FROM public.accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM public.account_members m
  WHERE m.account_id = a.id AND m.user_id = a.owner_user_id
)
ON CONFLICT (account_id, user_id) DO NOTHING;

-- An account row whose membership says 'admin' but which the accounts
-- table calls the owner is the 017 backfill's shape for a workspace
-- that had ownership transferred. Trust accounts.owner_user_id, which
-- is what billing resolves through.
UPDATE public.account_members m
SET role = 'owner'
FROM public.accounts a
WHERE a.id = m.account_id
  AND a.owner_user_id = m.user_id
  AND m.role <> 'owner';


-- ============================================================
-- 2. is_account_member — the 227-policy pivot
--
-- Body only. Same name, same signature, same SECURITY DEFINER, same
-- grants — so every policy that calls it keeps working and starts
-- honouring every membership the caller holds rather than the one row
-- `profiles` used to allow.
--
-- Still DEFINER so a policy body can read the membership table
-- without recursing into that table's own policy.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
      AND CASE m.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.is_account_member(UUID, account_role_enum) IS
  'Does auth.uid() hold a membership in target_account_id with at least min_role? Reads account_members (migration 095; read profiles before that). The authorization behind 227 RLS policies — change the body, never the signature.';


-- ============================================================
-- 3. shares_account_with — for the profiles policy
--
-- `profiles_select` used to say `is_account_member(account_id)` because
-- the profile row itself carried the workspace. Once it does not, the
-- question becomes "do this person and I have a workspace in common",
-- which is a self-join on `account_members`.
--
-- Its own function, DEFINER, for the same reason as above: inlining
-- the join into the policy would make reading `profiles` depend on
-- `account_members`'s policy, which depends on `profiles` in anyone's
-- mental model even though it no longer does in SQL. One indirection
-- is cheaper than reasoning about that every time.
-- ============================================================
CREATE OR REPLACE FUNCTION public.shares_account_with(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members mine
    JOIN account_members theirs ON theirs.account_id = mine.account_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = target_user_id
  );
$$;

ALTER FUNCTION public.shares_account_with(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.shares_account_with(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shares_account_with(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.shares_account_with(UUID) IS
  'Do auth.uid() and target_user_id hold a membership in any workspace in common? Backs profiles_select now that a profile row names no workspace of its own.';


-- ============================================================
-- 3b. RLS on account_members
--
-- Read: anyone in the workspace, so the Members tab renders — plus
-- your own rows unconditionally, which is what the switcher lists.
-- The second clause is not redundant: it is what a user reads through
-- while their memberships are being resolved for a workspace whose
-- other policies have not yet been consulted.
--
-- Write: NO POLICY AT ALL. Membership is granted and revoked by the
-- supervised DEFINER RPCs in sections 10–11 and by the server. This is
-- strictly stronger than migration 033's trigger, which had to let the
-- browser UPDATE `profiles` and then catch privilege columns on the way
-- through — here there is no write path to catch.
-- ============================================================
DROP POLICY IF EXISTS account_members_select ON public.account_members;
CREATE POLICY account_members_select ON public.account_members
  FOR SELECT USING (
    user_id = auth.uid() OR is_account_member(account_id)
  );


-- ============================================================
-- 4. profiles gains the switcher's memory
--
-- ⚠️ THIS MIGRATION IS THE EXPAND HALF. `profiles.account_id` and
-- `profiles.account_role` STAY, untouched, and 096 drops them once the
-- new code is deployed.
--
-- The reason is downtime. Every dashboard request resolves its
-- workspace through `profile.findUnique({ where: { userId } })` in
-- apps/api's Supabase guard, so a single migration that dropped those
-- columns would 500 the entire product from the moment it applied
-- until the deploy finished. Expand/contract removes that window: this
-- half is invisible to the running code, the deploy switches every
-- reader over to `account_members`, and 096 removes the columns
-- nothing reads any more.
--
-- ⚠️ NO SYNC TRIGGER, deliberately. Mirroring memberships back into a
-- single `profiles.account_id` would need a rule for which of N
-- workspaces gets mirrored, and that rule would be a fiction in every
-- multi-membership case. Instead the columns are simply LEFT as they
-- are: during the rollout window old code keeps seeing exactly the
-- workspace it saw before, which is stale-but-correct, and the worst
-- case is someone who redeems an invite mid-deploy not seeing the new
-- workspace in the old UI for a few minutes. New code ignores the
-- columns entirely.
--
-- `last_account_id` is the switcher's memory, and it is a PREFERENCE,
-- not authority: "the workspace I was last looking at", so a new
-- browser opens where the old one left off. Every consumer re-validates
-- membership before trusting it — the Nest guard checks
-- `account_members`, and RLS does not consult this column at all — so
-- a user writing a foreign account id here achieves precisely nothing.
-- That is why it is left writable by the ordinary self-update policy
-- instead of needing an RPC.
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_account_id uuid
    REFERENCES public.accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.last_account_id IS
  'The workspace this user last had open — a cross-device default for the switcher. A HINT, never authority: membership is re-checked from account_members on every request, so a forged value grants nothing.';

-- Seed it from the workspace they were in before the split, so the
-- first load after deploy lands them exactly where they were.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'account_id'
  ) THEN
    EXECUTE $upd$
      UPDATE public.profiles
      SET last_account_id = account_id
      WHERE last_account_id IS NULL AND account_id IS NOT NULL
    $upd$;
  END IF;
END $$;

-- `profiles_select` still reads `account_id`, and that column is still
-- here, so it is left alone until 096 rewrites it onto
-- `shares_account_with` in the same statement that drops the column.
-- Migration 033's privilege-column trigger likewise stays until then:
-- while `account_role` exists, the browser can still PATCH it, so the
-- guard is still load-bearing.


-- ============================================================
-- 5. Storage buckets — the five inlined policy sets
--
-- These are the ones that matter most. Uploads to these buckets go
-- BROWSER → Supabase Storage without passing through apps/api, so the
-- policy is the only gate; and each one inlined the single-profile
-- join instead of calling the helper, so each one would have kept
-- authorising exactly one workspace per user.
--
-- Rewritten to call `is_account_member` on the account id parsed out of
-- the first path segment. The path convention is `account-<uuid>/…`,
-- built in one place by buildMediaPath() in
-- apps/web/src/lib/storage/upload-media.ts.
--
-- ⚠️ The account id is NOT cast to uuid. `foldername(name)[1]` is
-- attacker-controlled, and `'account-junk'::uuid` raises 22P02 — which
-- surfaces as a 500 from Storage rather than a denial, and an error is
-- not a refusal. Comparing the membership's id cast TO text keeps a
-- malformed path a plain non-match.
-- ============================================================
CREATE OR REPLACE FUNCTION public.storage_account_folder_ok(
  p_object_name text,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    WHERE m.user_id = auth.uid()
      AND ('account-' || m.account_id::text) = (storage.foldername(p_object_name))[1]
      AND CASE m.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION public.storage_account_folder_ok(text, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.storage_account_folder_ok(text, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_account_folder_ok(text, account_role_enum)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.storage_account_folder_ok(text, account_role_enum) IS
  'Is auth.uid() a member (at min_role) of the workspace named by an object path''s leading `account-<uuid>` segment? The one place the storage path convention is matched against membership — five buckets share it. Compares uuid-as-text so a malformed path is a non-match rather than a 22P02 error.';

-- ---- flow-media (016, rescoped by 020) ---------------------
-- The legacy `auth.uid()::text = foldername[1]` arm stays: files
-- uploaded under the pre-020 per-user convention are still referenced
-- by live flow nodes, and their uploader must keep write access.
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND (
      storage_account_folder_ok(name)
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'flow-media'
    AND (
      storage_account_folder_ok(name)
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'flow-media'
    AND (
      storage_account_folder_ok(name)
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

-- ---- chat-media (023) --------------------------------------
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-media' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chat-media' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-media' AND storage_account_folder_ok(name)
  );

-- ---- template-media (058) ----------------------------------
DROP POLICY IF EXISTS "Members can upload template media" ON storage.objects;
CREATE POLICY "Members can upload template media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'template-media' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can update template media" ON storage.objects;
CREATE POLICY "Members can update template media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'template-media' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can delete template media" ON storage.objects;
CREATE POLICY "Members can delete template media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'template-media' AND storage_account_folder_ok(name)
  );

-- ---- workspace-logos (071) — admin+ ------------------------
-- The role check is part of the authorization here, not decoration:
-- this URL renders in every teammate's browser chrome.
DROP POLICY IF EXISTS "Admins can upload workspace logos" ON storage.objects;
CREATE POLICY "Admins can upload workspace logos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'workspace-logos'
    AND storage_account_folder_ok(name, 'admin')
  );

DROP POLICY IF EXISTS "Admins can update workspace logos" ON storage.objects;
CREATE POLICY "Admins can update workspace logos"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'workspace-logos'
    AND storage_account_folder_ok(name, 'admin')
  );

DROP POLICY IF EXISTS "Admins can delete workspace logos" ON storage.objects;
CREATE POLICY "Admins can delete workspace logos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'workspace-logos'
    AND storage_account_folder_ok(name, 'admin')
  );

-- ---- media-library (087) -----------------------------------
DROP POLICY IF EXISTS "Members can upload library media" ON storage.objects;
CREATE POLICY "Members can upload library media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'media-library' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can update library media" ON storage.objects;
CREATE POLICY "Members can update library media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'media-library' AND storage_account_folder_ok(name)
  );

DROP POLICY IF EXISTS "Members can delete library media" ON storage.objects;
CREATE POLICY "Members can delete library media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'media-library' AND storage_account_folder_ok(name)
  );


-- ============================================================
-- 6. media_assets (087) — the rows that index those objects
--
-- Membership-only, no role tier, exactly as 087 had it: the four call
-- sites include the inbox composer, which agents use.
-- ============================================================
DROP POLICY IF EXISTS "Members read their account's media" ON public.media_assets;
CREATE POLICY "Members read their account's media"
  ON public.media_assets FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS "Members add media to their account" ON public.media_assets;
CREATE POLICY "Members add media to their account"
  ON public.media_assets FOR INSERT
  WITH CHECK (is_account_member(account_id));

DROP POLICY IF EXISTS "Members update their account's media" ON public.media_assets;
CREATE POLICY "Members update their account's media"
  ON public.media_assets FOR UPDATE
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS "Members delete their account's media" ON public.media_assets;
CREATE POLICY "Members delete their account's media"
  ON public.media_assets FOR DELETE
  USING (is_account_member(account_id));


-- ============================================================
-- 7. check_account_limit — team_members counts memberships
--
-- Full redefinition of 084's function with one branch changed, because
-- you cannot patch a branch. `max_team_members` now counts rows in
-- `account_members` for the workspace, which is the same number it
-- always meant and no longer reachable from `profiles`.
--
-- Everything else here is byte-identical to 084. If you change this,
-- change it there too — or better, stop copying and let this be the
-- live definition.
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
      -- Migration 095: memberships, not profiles. Counts every member
      -- of THIS workspace and ignores whatever else they belong to.
      SELECT count(*) INTO v_used FROM account_members am
       WHERE am.account_id = p_account_id;
    WHEN 'ai_agents' THEN
      v_limit := v_ent.max_ai_agents;
      SELECT count(*) INTO v_used FROM ai_agents ag
       WHERE ag.account_id = p_account_id;
    WHEN 'storage' THEN
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

REVOKE ALL ON FUNCTION public.check_account_limit(uuid, text, integer) FROM PUBLIC;


-- ============================================================
-- 8. check_subscription_limit (044) — superseded, still repaired
--
-- CLAUDE.md records that this has no callers; 075 replaced it. Its
-- `team_members` branch reads `profiles.account_id`, which 096 drops,
-- so it is repointed here rather than left to fail at call time — a
-- function that raises 42703 the first time anyone tries it is a worse
-- landmine than one that is merely obsolete, and `\df` gives no hint
-- which of the two you are looking at.
--
-- Guarded on existence: 044 may not have been applied to every
-- environment, and a missing superseded function is not a problem.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'check_subscription_limit'
  ) THEN
    EXECUTE $c$
      CREATE OR REPLACE FUNCTION public.check_subscription_limit(
        p_user_id    uuid,
        p_limit_type text,
        p_increment  integer DEFAULT 1
      )
      RETURNS TABLE (
        allowed       boolean,
        current_usage integer,
        limit_value   integer,
        reason        text
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY INVOKER
      SET search_path = public
      AS $body$
      BEGIN
        -- SUPERSEDED by check_account_limit(account_id, ...) in 075.
        -- This was keyed by user, so it resolved to "no subscription
        -- found" for every invited teammate, and after 095 a user can
        -- be in several workspaces — so there is no single account for
        -- a user id to mean any more. Refusing loudly beats guessing
        -- one of them.
        RETURN QUERY SELECT false, 0, 0,
          'superseded: call check_account_limit(account_id, ...) instead'::text;
      END;
      $body$
    $c$;

    EXECUTE $c$
      COMMENT ON FUNCTION public.check_subscription_limit(uuid, text, integer) IS
        'SUPERSEDED by check_account_limit (075) and neutered by 095: a user id no longer identifies one workspace. Always returns allowed=false with a reason naming its replacement. No callers — do not add one.'
    $c$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'check_subscription_limit: left as-is (%).', SQLERRM;
END $$;


-- ============================================================
-- 9. touch_presence — presence is per workspace
--
-- The inbox heartbeat (components/presence/presence-heartbeat.tsx,
-- via `supabase.rpc`) inferred the workspace from the caller's one
-- profile row. It now takes the workspace explicitly, because someone
-- reading one client's inbox must not render as a live teammate in
-- another's.
--
-- `ON CONFLICT (user_id)` stays: you are present in the workspace you
-- are LOOKING AT, one at a time, so switching moves the row rather
-- than adding one.
--
-- Called from the BROWSER through PostgREST, so `auth.uid()` is
-- populated and no actor parameter is needed — unlike the RPCs in
-- section 10. Adding a second DEFAULTed parameter is safe here
-- precisely because the caller uses named arguments: no overload is
-- created, so there is no ambiguity for a stale browser tab still
-- sending only `p_status`.
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status     TEXT DEFAULT 'online',
  p_account_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID := p_account_id;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  -- Omitted (a browser tab loaded before this deploy): the workspace
  -- they last had open is what the old one-argument call meant.
  IF v_account_id IS NULL THEN
    SELECT last_account_id INTO v_account_id
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  -- Still nothing — a profile that has never switched. Any membership
  -- will do; presence is cosmetic, and refusing would make the inbox
  -- look broken over something nobody would think to report.
  IF v_account_id IS NULL THEN
    SELECT account_id INTO v_account_id
    FROM account_members
    WHERE user_id = auth.uid()
    ORDER BY created_at
    LIMIT 1;
  END IF;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No workspace for caller' USING ERRCODE = '22023';
  END IF;

  -- DEFINER bypasses RLS, so this check is the only thing between a
  -- caller and announcing themselves inside a workspace they are not
  -- a member of.
  IF NOT is_account_member(v_account_id) THEN
    RAISE EXCEPTION 'Not a member of workspace %', v_account_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (auth.uid(), v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;
END;
$$;

ALTER FUNCTION public.touch_presence(TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.touch_presence(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT, UUID) TO authenticated;

-- 024's one-argument definition would now be an ambiguous overload of
-- the two-argument-with-defaults form above: `touch_presence('online')`
-- matches both, and Postgres refuses the call (42725). Dropping the old
-- one is what keeps every existing heartbeat working.
DROP FUNCTION IF EXISTS public.touch_presence(TEXT);


-- ============================================================
-- 9b. resolve_rpc_actor — WHO is this RPC acting for?
--
-- ⚠️⚠️ THIS FIXES A LIVE BUG, and the bug is worth writing down because
-- the shape of it will recur.
--
-- Migration 018's RPCs open with `IF auth.uid() IS NULL THEN RAISE
-- 'Unauthorized'`, which is correct for a browser calling through
-- PostgREST. But every caller in this product is apps/api, over
-- Prisma, which connects as `postgres` — where `auth.uid()` is NULL.
-- Verified against the live database:
--
--     postgres=> select set_member_role('...'::uuid, 'agent');
--     ERROR:  Unauthorized
--
-- So `set_member_role`, `remove_account_member`,
-- `transfer_account_ownership` and `redeem_invitation` have been
-- returning 403 unconditionally: changing a teammate's role, removing
-- a teammate, transferring ownership, and ACCEPTING AN INVITATION have
-- never worked in production. Nothing surfaced it because a 403 from a
-- permissions RPC reads exactly like a permissions problem.
--
-- The fix is migration 067's rule, applied to writes: a JWT caller may
-- act only as themselves; a server connection may name the actor it is
-- acting for. One function, so five RPCs cannot drift on it.
--
-- ⚠️ The trust boundary this creates is the API's JWT verification.
-- `p_actor_user_id` is authority, so any endpoint passing it MUST have
-- verified the session first — which is why 095 ships alongside a
-- SupabaseUserGuard on the redeem endpoint, whose previous idea of
-- authentication was that the Authorization header started with
-- "Bearer ".
--
-- ⚠️ And the corollary, easy to miss: inside these RPCs, membership
-- must be checked against the ACTOR, never through
-- `is_account_member()`. That helper reads `auth.uid()`, so under a
-- server connection it answers "no" for everybody — the same NULL that
-- caused the original bug, one layer down.
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_rpc_actor(p_actor_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    -- A JWT caller. They may pass their own id or nothing; naming
    -- somebody else is an impersonation attempt, not a convenience.
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Cannot act on behalf of another user'
        USING ERRCODE = '42501';
    END IF;
    RETURN auth.uid();
  END IF;

  -- No JWT: a server connection (apps/api via Prisma). It must say who
  -- it is acting for, and it is responsible for having verified them.
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN p_actor_user_id;
END;
$$;

ALTER FUNCTION public.resolve_rpc_actor(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_rpc_actor(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_rpc_actor(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_rpc_actor(UUID) IS
  'Which user is an RPC acting for? A JWT caller gets auth.uid() and may not name anyone else; a server connection (auth.uid() IS NULL, how apps/api connects) must name the actor and is responsible for having verified them. Migration 067''s rule applied to writes.';


-- ============================================================
-- 10. The 018 member RPCs — a workspace, and an actor
--
-- All three resolved "the caller's account" from their single profile
-- row. With N memberships that question has no answer, so each takes
-- `p_account_id` and checks the actor's role IN THAT WORKSPACE.
--
-- ⚠️ The account id is now caller-supplied, which is exactly the shape
-- CLAUDE.md warns about for SECURITY DEFINER RPCs granted to
-- `authenticated`: RLS is bypassed, so the body is the only check
-- left. Every one of them therefore establishes the actor's role in
-- the NAMED workspace before touching anything, rather than trusting
-- that they had any business naming it.
--
-- Old signatures are DROPPED rather than left delegating. A two-arg
-- `set_member_role(user, role)` cannot pick a workspace, and guessing
-- one would change a role in a workspace nobody asked about.
-- ============================================================
DROP FUNCTION IF EXISTS public.set_member_role(UUID, account_role_enum);
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);
DROP FUNCTION IF EXISTS public.transfer_account_ownership(UUID);

-- ---- set_member_role ---------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_account_id    UUID,
  p_user_id       UUID,
  p_new_role      account_role_enum,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       UUID := resolve_rpc_actor(p_actor_user_id);
  v_actor_role  account_role_enum;
  v_target_role account_role_enum;
BEGIN
  -- Against the ACTOR, not is_account_member() — see section 9b.
  SELECT role INTO v_actor_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = v_actor;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of this workspace'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE account_members
  SET role = p_new_role
  WHERE account_id = p_account_id AND user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, UUID, account_role_enum, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, UUID, account_role_enum, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, account_role_enum, UUID) TO authenticated;

-- ---- remove_account_member ---------------------------------
--
-- Removing somebody no longer strands them: they keep every other
-- membership, and their profile is untouched. Before 095 this had to
-- mint them a replacement personal account so they had somewhere to
-- land — that whole dance is gone, which is the clearest sign the new
-- model is the right shape.
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_account_id    UUID,
  p_user_id       UUID,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       UUID := resolve_rpc_actor(p_actor_user_id);
  v_actor_role  account_role_enum;
  v_target_role account_role_enum;
BEGIN
  SELECT role INTO v_actor_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = v_actor;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'Use leave_account to remove yourself'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of this workspace'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Transfer ownership before removing the owner'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_members
  WHERE account_id = p_account_id AND user_id = p_user_id;

  -- Don't leave them pointed at a workspace they can no longer open;
  -- the switcher would offer it and every request would be refused.
  UPDATE profiles
  SET last_account_id = NULL
  WHERE user_id = p_user_id AND last_account_id = p_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID, UUID, UUID) TO authenticated;

-- ---- leave_account -----------------------------------------
--
-- New, and only possible now: before 095 leaving was indistinguishable
-- from deleting your account, because your membership WAS your access.
-- An owner may not leave — that is a transfer, and a workspace with no
-- owner has no subscription to resolve through.
CREATE OR REPLACE FUNCTION public.leave_account(
  p_account_id    UUID,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := resolve_rpc_actor(p_actor_user_id);
  v_role  account_role_enum;
BEGIN
  SELECT role INTO v_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = v_actor;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '22023';
  END IF;

  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'Transfer ownership before leaving this workspace'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_members
  WHERE account_id = p_account_id AND user_id = v_actor;

  UPDATE profiles
  SET last_account_id = NULL
  WHERE user_id = v_actor AND last_account_id = p_account_id;
END;
$$;

ALTER FUNCTION public.leave_account(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.leave_account(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_account(UUID, UUID) TO authenticated;

-- ---- transfer_account_ownership ----------------------------
--
-- ⚠️ Writes BOTH `account_members.role` and `accounts.owner_user_id`,
-- and must keep them agreeing: the partial unique index above allows
-- one owner row, and billing resolves the plan through
-- `accounts.owner_user_id`. Demote first, then promote, or the index
-- rejects the intermediate state.
--
-- ⚠️ In phase 1 `idx_accounts_one_per_owner` still stands, so this
-- refuses a transfer to somebody who already owns a workspace. That is
-- a real limitation with a clear message rather than a P23505 —
-- phase 2 removes it along with the index.
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_account_id    UUID,
  p_new_owner_id  UUID,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       UUID := resolve_rpc_actor(p_actor_user_id);
  v_actor_role  account_role_enum;
  v_target_role account_role_enum;
BEGIN
  SELECT role INTO v_actor_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = v_actor;

  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_id = v_actor THEN
    RAISE EXCEPTION 'You already own this workspace' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_members
  WHERE account_id = p_account_id AND user_id = p_new_owner_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'The new owner must already be a member of this workspace'
      USING ERRCODE = '22023';
  END IF;

  -- Phase 1 only. See the note above.
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE owner_user_id = p_new_owner_id AND id <> p_account_id
  ) THEN
    RAISE EXCEPTION 'That user already owns another workspace; one owned workspace per user until billing is account-scoped'
      USING ERRCODE = '23505';
  END IF;

  -- Order matters: the partial unique index permits one owner row.
  UPDATE account_members SET role = 'admin'
  WHERE account_id = p_account_id AND user_id = v_actor;

  UPDATE account_members SET role = 'owner'
  WHERE account_id = p_account_id AND user_id = p_new_owner_id;

  UPDATE accounts SET owner_user_id = p_new_owner_id
  WHERE id = p_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID, UUID, UUID) TO authenticated;


-- ============================================================
-- 11. redeem_invitation — adds a membership, destroys nothing
--
-- THE BUG THIS FIXES, in the words of the function it replaces:
--
--     -- Safety: the caller must be the SOLE OWNER of their current
--     -- account … Either way, the safe answer is "make a different
--     -- login".
--
-- Under single membership that was genuinely the safe answer: joining
-- meant MOVING your profile, so it would have orphaned your contacts,
-- your deals, your WhatsApp connection. Which is why an agency could
-- not be invited into a client's workspace at all — the invite was
-- refused with "sign up with a different email", and the workaround
-- was one login per client.
--
-- With membership in its own table joining is an INSERT. Nothing
-- moves, nothing is deleted, and both of 019's refusals — "you are
-- already in a shared account" and "your account already contains
-- data" — are simply gone. They were consequences of the old shape,
-- not policy.
--
-- Retained: the FOR UPDATE lock (two concurrent redeems of one token
-- must not both succeed), and refusing a token for a workspace the
-- caller is already in.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash    TEXT,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := resolve_rpc_actor(p_actor_user_id);
  v_inv account_invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_members
    WHERE account_id = v_inv.account_id AND user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this workspace'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO account_members (account_id, user_id, role, invited_by)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role, v_inv.created_by_user_id);

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Land them in the workspace they just accepted, not wherever they
  -- happened to be — the invite email is a "come and look at this".
  UPDATE profiles
  SET last_account_id = v_inv.account_id
  WHERE user_id = v_caller_id;

  RETURN v_inv.account_id;
END;
$$;

-- The one-argument form is dropped rather than kept: it would be an
-- ambiguous overload of the defaulted two-argument form above, and it
-- could not accept an actor — which is the entire reason redeeming an
-- invitation has never worked from apps/api (section 9b).
DROP FUNCTION IF EXISTS public.redeem_invitation(TEXT);

ALTER FUNCTION public.redeem_invitation(TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.redeem_invitation(TEXT, UUID) IS
  'Adds a membership for the acting user (migration 095). Before that it MOVED the caller''s profile and deleted their workspace, so it had to refuse anyone who already had data — which is why an agency needed one login per client.';


-- ============================================================
-- 12. What the switcher reads
--
-- `list_my_workspaces()` is one round trip for the whole switcher:
-- every workspace the caller is in, their role in it, and its billing
-- standing — which is what puts the "needs attention" dot on the right
-- row. Without the standing the switcher cannot tell a healthy
-- workspace from the lapsed one you are trying to escape, and the
-- gate that sends you to /billing has to keep the switcher reachable
-- for exactly that reason.
--
-- SECURITY DEFINER, so it carries its own authorization per the rule
-- in CLAUDE.md — and it needs DEFINER anyway to reach
-- `get_account_entitlement`, whose EXECUTE is revoked from PUBLIC.
-- The actor comes from `resolve_rpc_actor` (section 9b), so a JWT
-- caller can only ever list their own workspaces while apps/api, which
-- has no JWT, can list them for a session it has verified.
--
-- One implementation, two callers. `GET /account/workspaces` and any
-- direct `supabase.rpc('list_my_workspaces')` from the browser get the
-- same rows — rather than the API reimplementing the entitlement join
-- in Prisma and drifting from what the browser sees.
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_my_workspaces(
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  account_id        uuid,
  name              text,
  logo_url          text,
  default_currency  text,
  default_country   text,
  role              account_role_enum,
  is_owner          boolean,
  member_count      integer,
  plan_display_name text,
  status            subscription_status_enum,
  standing          text,
  trial_end_at      timestamptz,
  current_period_end timestamptz,
  onboarding_done   boolean,
  joined_at         timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    a.logo_url,
    a.default_currency,
    a.default_country,
    m.role,
    a.owner_user_id = actor.id AS is_owner,
    (SELECT count(*)::int FROM account_members m2 WHERE m2.account_id = a.id),
    e.plan_display_name,
    e.status,
    e.standing,
    e.trial_end_at,
    e.current_period_end,
    ao.completed_at IS NOT NULL AS onboarding_done,
    m.created_at
  FROM (SELECT resolve_rpc_actor(p_actor_user_id) AS id) actor
  JOIN account_members m ON m.user_id = actor.id
  JOIN accounts a ON a.id = m.account_id
  LEFT JOIN account_onboarding ao ON ao.account_id = a.id
  -- LATERAL, not a plain join: get_account_entitlement is a set-
  -- returning function of one account and must be evaluated per row.
  LEFT JOIN LATERAL get_account_entitlement(a.id) e ON true
  -- Owned first, then alphabetical. An agency's own workspace is the
  -- one they administer from, and a list that reorders as clients are
  -- renamed is a list you have to re-read every time.
  ORDER BY (a.owner_user_id = actor.id) DESC, a.name;
$$;

ALTER FUNCTION public.list_my_workspaces(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_workspaces(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_workspaces(UUID) TO authenticated;

COMMENT ON FUNCTION public.list_my_workspaces(UUID) IS
  'Every workspace the acting user is a member of, with role and billing standing — the workspace switcher''s one query. A JWT caller may only list their own (resolve_rpc_actor refuses a foreign p_actor_user_id); apps/api passes the session it verified.';

-- ---- set_active_workspace ----------------------------------
--
-- Persists the switcher's choice across devices. Validates membership
-- so the column cannot be pointed at a workspace the user cannot open
-- — not for security (nothing trusts this column) but so the fallback
-- chain in the API guard is not fed a dead end it has to discard on
-- every single request.
CREATE OR REPLACE FUNCTION public.set_active_workspace(
  p_account_id    UUID,
  p_actor_user_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := resolve_rpc_actor(p_actor_user_id);
BEGIN
  -- Membership checked against the ACTOR, not is_account_member(),
  -- which reads auth.uid() and answers "no" for everyone on a server
  -- connection. See section 9b.
  IF NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE account_id = p_account_id AND user_id = v_actor
  ) THEN
    RAISE EXCEPTION 'Not a member of workspace %', p_account_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles SET last_account_id = p_account_id
  WHERE user_id = v_actor;
END;
$$;

ALTER FUNCTION public.set_active_workspace(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_active_workspace(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_active_workspace(UUID, UUID) TO authenticated;


-- ============================================================
-- 13. handle_new_user — and the invited signup
--
-- Two changes:
--
--   1. It writes an `account_members` row instead of stamping the
--      profile.
--
--   2. ⚠️ It creates NO workspace when the signup came through an
--      invite link. `/join/<token>` puts `skip_personal_workspace` in
--      the signup metadata, and without this every invited teammate
--      would own an empty, unpaid workspace forever: 019 used to
--      delete it on redeem, and 095's redeem does not (it has nothing
--      to move out of the way). That orphan would sit in their
--      switcher and — because a workspace with no plan resolves to
--      `lapsed` — wear a "needs attention" dot for a workspace they
--      never asked for and cannot get rid of.
--
-- Still swallows its own exceptions. A failure here must not block the
-- signup: an auth user with no profile is recoverable, a signup that
-- 500s is a lost customer. 017's backfill exists because of exactly
-- this decision, and it stands.
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
  v_skip       BOOLEAN;
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

  -- Anything truthy counts. The flag is set by our own join page, and
  -- the cost of misreading it is one extra empty workspace, so a
  -- lenient parse is the right trade.
  v_skip := COALESCE(
    (NEW.raw_user_meta_data->>'skip_personal_workspace') IN ('true', 't', '1'),
    false
  );

  INSERT INTO public.profiles (user_id, full_name, email, avatar_url)
  VALUES (NEW.id, v_full_name, NEW.email, v_avatar_url);

  IF NOT v_skip THEN
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My workspace'), NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.account_members (account_id, user_id, role)
    VALUES (v_account_id, NEW.id, 'owner');

    UPDATE public.profiles
    SET last_account_id = v_account_id
    WHERE user_id = NEW.id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap workspace/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- 14. Grants
--
-- `account_members` is read by the browser through PostgREST (the
-- Members tab, the switcher's fallback) and written only by the RPCs
-- above and by the server connection. No INSERT/UPDATE/DELETE to
-- `authenticated` — the absence is the point.
-- ============================================================
GRANT SELECT ON public.account_members TO authenticated;
GRANT ALL    ON public.account_members TO service_role;


-- ============================================================
-- Manual validation (no SQL test harness in this repo)
--
--   0. THE BACKFILL IS COMPLETE — run this BEFORE deploying, because
--      after the deploy `profiles.account_id` is what nothing reads
--      and `account_members` is what everything reads. Any row the
--      backfill missed is a user locked out of their own workspace.
--        SELECT p.user_id FROM profiles p
--         WHERE p.account_id IS NOT NULL
--           AND NOT EXISTS (SELECT 1 FROM account_members m
--                            WHERE m.user_id = p.user_id
--                              AND m.account_id = p.account_id);
--        -- must be empty
--
--   1. Every pre-095 user has exactly one membership, matching what
--      their profile used to say:
--        SELECT count(*) FROM account_members;   -- = pre-095 profiles
--        SELECT count(*) FROM accounts a
--         WHERE NOT EXISTS (SELECT 1 FROM account_members m
--                            WHERE m.account_id = a.id
--                              AND m.user_id = a.owner_user_id
--                              AND m.role = 'owner');  -- must be 0
--
--   2. Every workspace has exactly one owner:
--        SELECT account_id FROM account_members WHERE role = 'owner'
--         GROUP BY 1 HAVING count(*) <> 1;       -- must be empty
--
--   3. As a member JWT, RLS still scopes reads to your workspaces:
--        GET /rest/v1/contacts        -- only your workspaces' rows
--        GET /rest/v1/account_members -- only workspaces you are in
--
--   4. Membership is unwritable from the browser:
--        POST /rest/v1/account_members {...}      -- 42501
--        PATCH /rest/v1/account_members?...       -- 42501
--
--   5. Storage still gates on the folder, at the right role:
--        upload to media-library/account-<yours>/x.png    -- ok
--        upload to media-library/account-<foreign>/x.png  -- denied
--        upload to media-library/not-an-account/x.png     -- DENIED,
--          and specifically not a 500 from a failed uuid cast
--        upload to workspace-logos/account-<yours>/x.png
--          as an agent                                   -- denied
--
--   6. The invite that used to be impossible:
--        as a user who already owns a workspace WITH DATA, redeem an
--        invitation to another workspace -- succeeds, and both appear
--        in list_my_workspaces() with their own roles.
-- ============================================================
