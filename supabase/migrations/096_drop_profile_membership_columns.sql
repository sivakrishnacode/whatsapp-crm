-- ============================================================
-- 096_drop_profile_membership_columns.sql — the contract half
--
-- ⚠️ RUN THIS AFTER THE PHASE-1 CODE IS DEPLOYED, NOT BEFORE.
--
-- Order for the whole change is: 095 → deploy → 096. Migration 095
-- added `account_members` and repointed `is_account_member` at it while
-- deliberately leaving `profiles.account_id` / `profiles.account_role`
-- in place, so the then-running code kept working. This migration
-- removes them.
--
-- If you run 096 before the deploy, every dashboard request 500s:
-- apps/api's Supabase guard resolves the caller's workspace with
-- `profile.findUnique({ where: { userId } })` and reads `accountId`
-- off the result.
--
-- HOW TO KNOW IT IS SAFE TO RUN
--
--   Nothing should be reading either column. Before running, confirm
--   the deployed api and web are the phase-1 build, and that the
--   backfill check in 095's validation block is still empty. There is
--   no automated gate on this — the columns are the gate, which is why
--   this is a separate file rather than a tail section of 095.
--
-- WHY DROP THEM AT ALL, RATHER THAN LEAVE THEM
--
--   Because they would be a second answer to "which workspace is this
--   person in", and a stale one. The first time somebody debugging a
--   permissions problem reads `profiles.account_role` and believes it,
--   they will be looking at the role that person held in one workspace
--   in 2026 while wondering why a different workspace behaves
--   differently. A column that is right often enough to be trusted and
--   wrong often enough to mislead is worse than no column.
--
-- Idempotent — safe to run multiple times.
-- ============================================================


-- ============================================================
-- 1. profiles_select — off the column, onto the membership
--
-- It said `auth.uid() = user_id OR is_account_member(account_id)`,
-- which read "you may see a profile if you are in the workspace that
-- profile names". A profile names no workspace now, so the question
-- becomes "do we have a workspace in common" —
-- `shares_account_with(user_id)`, created in 095.
--
-- Rewritten BEFORE the drop below: Postgres refuses to drop a column a
-- policy depends on, and that refusal is the safety net (see the
-- no-CASCADE note in section 3).
-- ============================================================
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT
  USING (auth.uid() = user_id OR shares_account_with(user_id));

-- Unchanged (self only), restated so this migration leaves the table's
-- full policy set in one readable place.
DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);


-- ============================================================
-- 2. Migration 033's privilege-column trigger is now moot
--
-- It existed to stop `PATCH /rest/v1/profiles { "account_role":
-- "owner" }` from a browser — a real self-promotion hole while those
-- columns were both present and browser-writable.
--
-- Their replacement closes it by construction instead: 095 gave
-- `account_members` a SELECT policy and NO insert, update or delete
-- policy at all, so there is no client write path left to intercept.
-- That is strictly stronger than catching a write on the way through.
--
-- Dropped rather than left in place as a no-op, because a guard that
-- guards nothing reads as protection that is not there.
-- ============================================================
DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
DROP FUNCTION IF EXISTS public.enforce_profile_privilege_columns();


-- ============================================================
-- 3. Drop the single-membership columns
--
-- ⚠️ NO CASCADE, deliberately. If anything still depends on these
-- columns — a policy, a view, a trigger, an index — this statement must
-- FAIL and name it. CASCADE would drop that object silently, and if it
-- were a policy the failure would resurface later as an authorization
-- check that quietly is not running.
--
-- If it does fail: fix the named dependency, do not reach for CASCADE.
-- ============================================================
DROP INDEX IF EXISTS public.idx_profiles_account_role;

ALTER TABLE public.profiles DROP COLUMN IF EXISTS account_role;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS account_id;

COMMENT ON TABLE public.profiles IS
  'One row per PERSON: name, email, avatar, beta flags, and the workspace they last had open. Membership and role live in account_members (migration 095) — this row makes somebody a member of nothing.';


-- ============================================================
-- Manual validation
--
--   1. The columns are gone and nothing broke:
--        \d public.profiles          -- no account_id / account_role
--        SELECT count(*) FROM profiles;   -- unchanged
--
--   2. A member JWT can still read teammates but not strangers:
--        GET /rest/v1/profiles       -- self + everyone sharing a
--                                    -- workspace, nobody else
--
--   3. Self-promotion is still refused, now by the absence of a
--      write path rather than by a trigger:
--        POST  /rest/v1/account_members {"role":"owner",...}  -- 42501
--        PATCH /rest/v1/account_members?...  {"role":"owner"} -- 42501
--
--   4. The product still works end to end for a single-workspace
--      user: inbox loads, a contact saves, a media upload succeeds,
--      the members tab renders.
-- ============================================================
