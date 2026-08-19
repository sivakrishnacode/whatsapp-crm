-- ============================================================
-- 097_filter_contacts_workspace_scope.sql — the contacts list, in ONE
-- workspace
--
-- ⚠️⚠️ THE BUG CLASS THIS FIXES IS THE MAIN HAZARD OF MIGRATION 095, and
-- it is worth stating in full because it is invisible in code review.
--
-- `filter_contacts` is SECURITY INVOKER and carries no account filter at
-- all. That was correct and complete: RLS scopes `contacts` to
-- `is_account_member(account_id)`, and while `profiles.user_id` was
-- UNIQUE that resolved to exactly one workspace. The function was
-- workspace-scoped for free, by the policy, without ever naming an
-- account.
--
-- 095 makes `is_account_member` true for EVERY workspace the caller
-- belongs to. The same function, unchanged, now returns the UNION — so
-- an agency opening Contacts gets every client's contacts interleaved
-- in one list, with correct-looking pagination and a correct-looking
-- total, and nothing anywhere says why.
--
-- ⚠️ It is not a tenant leak: they are a member of each of those
-- workspaces. That is exactly what makes it dangerous — no policy is
-- violated, no error is raised, and the only symptom is a list that is
-- quietly wrong. And the first thing anyone does with a contact list is
-- broadcast to it.
--
-- THE RULE, for anything added later:
--
--   RLS decides what you MAY see. The query decides what you ARE seeing.
--
-- Every INVOKER function over an account-scoped table needs an explicit
-- `p_account_id` now, and so does every browser query — see
-- apps/web/src/lib/workspace/scope.ts for the same rule on that side.
--
-- Idempotent — safe to run multiple times.
-- ============================================================


-- ============================================================
-- filter_contacts — now takes the workspace
--
-- `p_account_id` is FIRST and has no default, deliberately: a defaulted
-- trailing parameter would let every existing call site keep compiling
-- and keep returning the union, which is the failure this migration
-- exists to make impossible. A caller that has not been updated must
-- fail loudly.
--
-- ⚠️ The id is caller-supplied, but this function is INVOKER, so RLS
-- still applies underneath: naming another tenant's account returns
-- nothing rather than their contacts. The parameter narrows; it cannot
-- widen. That is why it needs no membership check of its own — unlike
-- the DEFINER analytics RPCs, which have `analytics_guard`.
-- ============================================================
DROP FUNCTION IF EXISTS public.filter_contacts(UUID[], UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts(
  p_account_id  UUID,
  p_tag_ids     UUID[] DEFAULT NULL,
  p_segment_ids UUID[] DEFAULT NULL,
  p_search      TEXT   DEFAULT NULL,
  p_limit       INT    DEFAULT 25,
  p_offset      INT    DEFAULT 0
)
RETURNS TABLE (contact public.contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH seg_matches AS (
    SELECT DISTINCT r.contact_id
    FROM unnest(COALESCE(p_segment_ids, ARRAY[]::uuid[])) AS s(id)
    CROSS JOIN LATERAL resolve_segment_contact_ids(s.id) AS r(contact_id)
  ),
  matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE c.account_id = p_account_id
      AND (
        p_tag_ids IS NULL OR array_length(p_tag_ids, 1) IS NULL
        OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids)
        )
      )
      AND (
        p_segment_ids IS NULL OR array_length(p_segment_ids, 1) IS NULL
        OR c.id IN (SELECT sm.contact_id FROM seg_matches sm)
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
        OR c.company ILIKE '%' || p_search || '%'
        OR c.ig_username ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts(UUID, UUID[], UUID[], TEXT, INT, INT)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts(UUID, UUID[], UUID[], TEXT, INT, INT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts(UUID, UUID[], UUID[], TEXT, INT, INT)
  TO authenticated;

COMMENT ON FUNCTION public.filter_contacts(UUID, UUID[], UUID[], TEXT, INT, INT) IS
  'The contacts list query: tags AND segments, with search over name/phone/email/company/ig_username. p_account_id is REQUIRED and first (migration 097) — without it RLS scopes the result to every workspace the caller belongs to, which since 095 is a silently merged list rather than one workspace''s contacts.';


-- ============================================================
-- filter_contacts_by_tags (025) — superseded, and now dangerous
--
-- 076 replaced it and CLAUDE.md records it as unused; verified again
-- here against apps/web (no call sites). It has the identical defect and
-- no `p_account_id`, so rather than leave a loaded gun granted to
-- `authenticated`, its EXECUTE is revoked. The body is left intact: this
-- is a "nobody may call it" change, not a rewrite of something a future
-- reader might still want to consult.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'filter_contacts_by_tags'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC, anon, authenticated';
    EXECUTE $c$
      COMMENT ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) IS
        'SUPERSEDED by filter_contacts (076). EXECUTE revoked by 097: it has no p_account_id, so after 095 it would return contacts from every workspace the caller belongs to. Use filter_contacts(p_account_id, ...).'
    $c$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '097: filter_contacts_by_tags left as-is (%).', SQLERRM;
END $$;


-- ============================================================
-- Manual validation
--
--   1. The old signature is gone, so a stale caller fails loudly:
--        SELECT * FROM filter_contacts(NULL, NULL, NULL, 25, 0);
--        -- must error (no function matches), NOT return rows
--
--   2. As a member of two workspaces, the list is ONE workspace:
--        SELECT count(*) FROM filter_contacts('<ws-a>');
--        SELECT count(*) FROM filter_contacts('<ws-b>');
--        -- each must equal that workspace's contact count, and the two
--        -- must not sum to either
--
--   3. Naming a workspace you are not in returns nothing (RLS, not the
--      filter):
--        SELECT count(*) FROM filter_contacts('<foreign-ws>');  -- 0
-- ============================================================
