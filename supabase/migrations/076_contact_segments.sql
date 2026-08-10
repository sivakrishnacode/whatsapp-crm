-- ============================================================
-- 076_contact_segments.sql — named, reusable audiences.
--
-- WHY THIS EXISTS
--
--   The audience of a broadcast was rebuilt from scratch every time.
--   `broadcasts.audience_filter` records what a given send resolved to,
--   but only as a post-hoc snapshot on that one row — there was no way
--   to name a group of people, reuse it next week, or point an
--   automation at it. Tags are the closest thing, and they are the wrong
--   shape for it: a tag is a fact about ONE contact ("vip", "refunded"),
--   while an audience is a set with a purpose ("March webinar
--   attendees"). Overloading tags for both is how a tag list becomes 60
--   entries nobody dares delete.
--
-- THE TWO KINDS, AND WHY BOTH
--
--   * STATIC (`kind = 'static'`) — an explicit membership list. Rows in
--     contact_segment_members. This is the kind an automation, a flow, a
--     bulk action or the public API can ADD somebody to, and it is the
--     only kind that can be added to, because "add someone to a saved
--     filter" is not a meaningful instruction.
--   * DYNAMIC (`kind = 'dynamic'`) — a saved filter. Membership is
--     computed from `filter` at read time and is never stored, so it
--     cannot go stale. Nothing writes members for these; the RLS policy
--     and the RPCs below both refuse.
--
--   One table rather than two because everything downstream — the
--   broadcast audience picker, the contacts filter, the automation
--   condition — wants "pick a segment" and should not care which kind it
--   got. `resolve_segment_contact_ids()` is the seam that hides it.
--
-- WHY MEMBERSHIP IS NOT DERIVED FOR STATIC SEGMENTS
--
--   A static segment records a DECISION someone made ("this person
--   belongs in the March webinar list"), which is not recoverable from
--   the contact's own columns. That is the same reasoning as
--   `contacts.source`: if the write path does not record it, it is gone.
--   `contact_segment_members.source` and `added_by` therefore say who
--   put them there and which surface did it — an automation adding
--   10,000 people is a very different fact from an operator ticking a
--   box, and the difference matters when someone asks why their
--   broadcast went to a stranger.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. contact_segments
--
-- account_id + user_id mirrors `tags` and `custom_fields`: the account
-- owns the row, the user column records who made it. Deleting the
-- creator must not delete the workspace's segments, so user_id is
-- nullable here (tags predates that lesson and is not being changed).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contact_segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  kind         TEXT NOT NULL DEFAULT 'static',
  -- Only meaningful when kind = 'dynamic'. Shape:
  --   { "match": "all" | "any", "rules": [ {field, op, value}, ... ] }
  -- See contact_matches_segment_rule() for the vocabulary.
  filter       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_segments_kind_chk'
  ) THEN
    ALTER TABLE public.contact_segments
      ADD CONSTRAINT contact_segments_kind_chk
      CHECK (kind IN ('static', 'dynamic'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_segments_name_chk'
  ) THEN
    ALTER TABLE public.contact_segments
      ADD CONSTRAINT contact_segments_name_chk
      CHECK (length(btrim(name)) BETWEEN 1 AND 80);
  END IF;
END $$;

-- Case-insensitive uniqueness per workspace. "VIP" and "vip" as two
-- separate segments is always a mistake, never an intention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_segments_account_name
  ON public.contact_segments (account_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_contact_segments_account
  ON public.contact_segments (account_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON public.contact_segments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.contact_segments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. contact_segment_members
--
-- No account_id column: the segment has one and the contact has one,
-- and storing a third copy invents the possibility of them disagreeing.
-- Every policy and RPC below joins to the parent instead — the same
-- shape contact_tags uses.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contact_segment_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id  UUID NOT NULL REFERENCES public.contact_segments(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- Which surface put them here. Never inferred after the fact.
  source      TEXT NOT NULL DEFAULT 'manual',
  -- NULL means a machine did it (automation, flow, API key) — there is
  -- no user to name, and inventing one would be a lie in an audit trail.
  added_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_segment_members_source_chk'
  ) THEN
    ALTER TABLE public.contact_segment_members
      ADD CONSTRAINT contact_segment_members_source_chk
      CHECK (source IN ('manual', 'import', 'automation', 'flow', 'api', 'broadcast'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_segment_members_unique
  ON public.contact_segment_members (segment_id, contact_id);

-- "Who is in this segment", newest first — the membership list view.
CREATE INDEX IF NOT EXISTS idx_contact_segment_members_segment
  ON public.contact_segment_members (segment_id, added_at DESC);

-- "Which segments is this contact in" — the contact detail drawer and
-- the inbox sidebar both ask this per contact.
CREATE INDEX IF NOT EXISTS idx_contact_segment_members_contact
  ON public.contact_segment_members (contact_id);

-- ============================================================
-- 3. RLS
--
-- Mirrors tags / contact_tags from migration 017: any member reads,
-- 'agent' and above writes. The member table has no account_id, so
-- both policies reach the account through the segment.
--
-- The INSERT check additionally pins kind = 'static'. That is the only
-- enforcement that survives a direct PostgREST write from the browser,
-- which is how the contacts page will add members — the RPCs below
-- restate it for apps/api, which connects as owner and bypasses all of
-- this.
-- ============================================================
ALTER TABLE public.contact_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_segment_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_segments_select ON public.contact_segments;
CREATE POLICY contact_segments_select ON public.contact_segments
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS contact_segments_insert ON public.contact_segments;
CREATE POLICY contact_segments_insert ON public.contact_segments
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS contact_segments_update ON public.contact_segments;
CREATE POLICY contact_segments_update ON public.contact_segments
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS contact_segments_delete ON public.contact_segments;
CREATE POLICY contact_segments_delete ON public.contact_segments
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS contact_segment_members_select ON public.contact_segment_members;
CREATE POLICY contact_segment_members_select ON public.contact_segment_members
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.contact_segments s
      WHERE s.id = contact_segment_members.segment_id
        AND is_account_member(s.account_id)
    )
  );

DROP POLICY IF EXISTS contact_segment_members_insert ON public.contact_segment_members;
CREATE POLICY contact_segment_members_insert ON public.contact_segment_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contact_segments s
      WHERE s.id = contact_segment_members.segment_id
        AND s.kind = 'static'
        AND is_account_member(s.account_id, 'agent')
    )
    -- The contact must belong to the same workspace as the segment.
    -- Without this a member of account A could file account B's contact
    -- into their own segment and then read the contact back through the
    -- join, which is a cross-tenant read dressed up as a write.
    AND EXISTS (
      SELECT 1
      FROM public.contacts c
      JOIN public.contact_segments s ON s.id = contact_segment_members.segment_id
      WHERE c.id = contact_segment_members.contact_id
        AND c.account_id = s.account_id
    )
  );

DROP POLICY IF EXISTS contact_segment_members_delete ON public.contact_segment_members;
CREATE POLICY contact_segment_members_delete ON public.contact_segment_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.contact_segments s
      WHERE s.id = contact_segment_members.segment_id
        AND is_account_member(s.account_id, 'agent')
    )
  );

-- ============================================================
-- 4. contact_matches_segment_rule(contact, rule)
--
-- One rule, one contact, one boolean. The whole vocabulary of a dynamic
-- segment lives here, and it is deliberately small: everything below is
-- either a column on `contacts` or a join this schema already indexes.
--
--   field                op                              value
--   -----------------    ----------------------------    -------------
--   tag                  has | not_has                   tag UUID
--   source               is | is_not                     contacts.source
--   has_phone            is                              "true" | "false"
--   name|email|company   contains | is | is_set |
--                        is_not_set                      text
--   created_at           before | after                   ISO timestamp
--   custom:<field_uuid>  contains | is | is_not |
--                        is_set | is_not_set             text
--
-- NO DYNAMIC SQL. Every branch is a fixed query with the rule's value
-- bound as a parameter, because this function's arguments come from a
-- JSONB blob a user typed into a form.
--
-- An unrecognised field or operator returns FALSE rather than TRUE.
-- With match = 'any' a permissive default would silently mean "everyone
-- in the workspace", and the first thing that happens to a segment is
-- that somebody broadcasts to it.
--
-- The only EXCEPTION block is the one wrapped around the timestamp
-- parse, and it is scoped as tightly as it is on purpose: entering a
-- plpgsql block that has an exception handler opens a subtransaction,
-- and this function runs once per contact per rule. UUID inputs are
-- shape-checked with a regex instead, which costs nothing.
-- ============================================================
CREATE OR REPLACE FUNCTION public.contact_matches_segment_rule(
  c    public.contacts,
  rule JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_field    TEXT := COALESCE(rule->>'field', '');
  v_op       TEXT := COALESCE(rule->>'op', '');
  v_value    TEXT := rule->>'value';
  v_col      TEXT;
  v_ts       TIMESTAMPTZ;
  v_field_id TEXT;
  v_cv       TEXT;
  c_uuid     CONSTANT TEXT :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  -- ---- tag ------------------------------------------------
  IF v_field = 'tag' THEN
    IF v_value IS NULL OR v_value !~ c_uuid THEN
      RETURN FALSE;
    END IF;
    IF v_op = 'has' THEN
      RETURN EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.id AND ct.tag_id = v_value::uuid
      );
    ELSIF v_op = 'not_has' THEN
      RETURN NOT EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.id AND ct.tag_id = v_value::uuid
      );
    END IF;
    RETURN FALSE;
  END IF;

  -- ---- source ---------------------------------------------
  IF v_field = 'source' THEN
    IF v_op = 'is'     THEN RETURN c.source IS NOT DISTINCT FROM v_value; END IF;
    IF v_op = 'is_not' THEN RETURN c.source IS DISTINCT FROM v_value; END IF;
    RETURN FALSE;
  END IF;

  -- ---- has_phone ------------------------------------------
  -- An Instagram-only or web-only contact has no phone (migration 050),
  -- so this is how a WhatsApp-reachable audience is expressed.
  IF v_field = 'has_phone' THEN
    IF v_op <> 'is' THEN RETURN FALSE; END IF;
    IF lower(COALESCE(v_value, '')) = 'true' THEN
      RETURN c.phone IS NOT NULL AND btrim(c.phone) <> '';
    ELSE
      RETURN c.phone IS NULL OR btrim(c.phone) = '';
    END IF;
  END IF;

  -- ---- plain text columns ---------------------------------
  IF v_field IN ('name', 'email', 'company') THEN
    v_col := CASE v_field
               WHEN 'name'    THEN c.name
               WHEN 'email'   THEN c.email
               WHEN 'company' THEN c.company
             END;
    IF v_op = 'is_set'     THEN RETURN v_col IS NOT NULL AND btrim(v_col) <> ''; END IF;
    IF v_op = 'is_not_set' THEN RETURN v_col IS NULL OR btrim(v_col) = ''; END IF;
    IF v_col IS NULL THEN RETURN FALSE; END IF;
    IF v_op = 'is'       THEN RETURN lower(btrim(v_col)) = lower(btrim(COALESCE(v_value, ''))); END IF;
    IF v_op = 'is_not'   THEN RETURN lower(btrim(v_col)) <> lower(btrim(COALESCE(v_value, ''))); END IF;
    IF v_op = 'contains' THEN RETURN v_col ILIKE '%' || COALESCE(v_value, '') || '%'; END IF;
    RETURN FALSE;
  END IF;

  -- ---- created_at -----------------------------------------
  IF v_field = 'created_at' THEN
    IF c.created_at IS NULL THEN RETURN FALSE; END IF;
    BEGIN
      v_ts := v_value::timestamptz;
    EXCEPTION WHEN others THEN
      -- A date the user has not finished typing is not an error worth
      -- failing the whole segment over; it just matches nobody.
      RETURN FALSE;
    END;
    IF v_op = 'before' THEN RETURN c.created_at < v_ts; END IF;
    IF v_op = 'after'  THEN RETURN c.created_at > v_ts; END IF;
    RETURN FALSE;
  END IF;

  -- ---- custom:<field_uuid> --------------------------------
  IF v_field LIKE 'custom:%' THEN
    v_field_id := substring(v_field FROM 8);
    IF v_field_id !~ c_uuid THEN
      RETURN FALSE;
    END IF;

    SELECT ccv.value INTO v_cv
    FROM contact_custom_values ccv
    WHERE ccv.contact_id = c.id
      AND ccv.custom_field_id = v_field_id::uuid;

    IF v_op = 'is_set'     THEN RETURN v_cv IS NOT NULL AND btrim(v_cv) <> ''; END IF;
    IF v_op = 'is_not_set' THEN RETURN v_cv IS NULL OR btrim(v_cv) = ''; END IF;
    IF v_cv IS NULL THEN RETURN FALSE; END IF;
    IF v_op = 'is'       THEN RETURN lower(btrim(v_cv)) = lower(btrim(COALESCE(v_value, ''))); END IF;
    IF v_op = 'is_not'   THEN RETURN lower(btrim(v_cv)) <> lower(btrim(COALESCE(v_value, ''))); END IF;
    IF v_op = 'contains' THEN RETURN v_cv ILIKE '%' || COALESCE(v_value, '') || '%'; END IF;
    RETURN FALSE;
  END IF;

  RETURN FALSE;
END;
$$;

ALTER FUNCTION public.contact_matches_segment_rule(public.contacts, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_matches_segment_rule(public.contacts, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contact_matches_segment_rule(public.contacts, JSONB)
  TO authenticated, service_role;

-- ============================================================
-- 5. segment_complete_rules(filter) — drop the half-built ones.
--
-- A rule the user has started but not finished (no field, no operator,
-- or an operator that needs a value and hasn't got one) is removed
-- before evaluation rather than evaluated to a default.
--
-- The alternative — treating an incomplete rule as TRUE so it "doesn't
-- narrow anything" — is correct under match = 'all' and catastrophic
-- under match = 'any', where it resolves to the entire contact list.
-- Dropping is the only reading that is safe under both.
--
-- If nothing survives, the caller treats the segment as EMPTY, not as
-- everybody. Same reason.
-- ============================================================
CREATE OR REPLACE FUNCTION public.segment_complete_rules(filter JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
  FROM jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(COALESCE(filter->'rules', '[]'::jsonb)) = 'array'
             THEN filter->'rules'
           ELSE '[]'::jsonb
         END
       ) AS r
  WHERE COALESCE(r->>'field', '') <> ''
    AND COALESCE(r->>'op', '') <> ''
    AND (
      -- These two operators are complete on their own; everything else
      -- needs a value to compare against.
      r->>'op' IN ('is_set', 'is_not_set')
      OR COALESCE(r->>'value', '') <> ''
    );
$$;

ALTER FUNCTION public.segment_complete_rules(JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.segment_complete_rules(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.segment_complete_rules(JSONB) TO authenticated, service_role;

-- ============================================================
-- 6. resolve_segment_contact_ids(segment_id)
--
-- THE seam. Every consumer — the broadcast audience resolver, the
-- contacts list filter, the member count, the automation condition —
-- goes through this and none of them needs to know whether they were
-- handed a list or a filter.
--
-- SECURITY INVOKER, so a browser caller sees only their own segments
-- and their own contacts through RLS. apps/api connects as the database
-- owner and bypasses RLS entirely, which is why the dynamic branch
-- pins `c.account_id = seg.account_id` explicitly rather than trusting
-- the policy: an unscoped scan here would return every tenant's
-- contacts to whoever asked.
--
-- COST: the dynamic branch is O(contacts x rules) with a subquery per
-- tag/custom-field rule. That is nothing at a few thousand contacts and
-- will need a materialised path long before it is a million. Static
-- segments are a single indexed read and do not share the problem.
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_segment_contact_ids(p_segment_id UUID)
RETURNS TABLE (contact_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  seg     public.contact_segments;
  v_rules JSONB;
  v_match TEXT;
BEGIN
  SELECT * INTO seg FROM contact_segments s WHERE s.id = p_segment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF seg.kind = 'static' THEN
    RETURN QUERY
      SELECT m.contact_id
      FROM contact_segment_members m
      WHERE m.segment_id = p_segment_id;
    RETURN;
  END IF;

  v_rules := segment_complete_rules(seg.filter);
  IF jsonb_array_length(v_rules) = 0 THEN
    RETURN;  -- no usable rules => nobody, never everybody
  END IF;

  v_match := lower(COALESCE(seg.filter->>'match', 'all'));

  RETURN QUERY
    SELECT c.id
    FROM contacts c
    WHERE c.account_id = seg.account_id
      AND CASE
            WHEN v_match = 'any' THEN EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_rules) AS r
              WHERE contact_matches_segment_rule(c, r.value)
            )
            ELSE NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_rules) AS r
              WHERE NOT contact_matches_segment_rule(c, r.value)
            )
          END;
END;
$$;

ALTER FUNCTION public.resolve_segment_contact_ids(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_segment_contact_ids(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_segment_contact_ids(UUID) TO authenticated, service_role;

-- ============================================================
-- 7. list_contact_segments(account_id) — segments plus their size.
--
-- The count is the expensive part for dynamic segments (see above), so
-- it lives in one function the UI calls once rather than N+1 calls from
-- a list render.
--
-- INVOKER + RLS on contact_segments is what scopes this: a caller
-- passing somebody else's account_id gets zero rows because the policy
-- filters them, not because we trusted the argument.
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_contact_segments(p_account_id UUID)
RETURNS TABLE (segment public.contact_segments, member_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    s AS segment,
    (SELECT count(*) FROM resolve_segment_contact_ids(s.id)) AS member_count
  FROM contact_segments s
  WHERE s.account_id = p_account_id
  ORDER BY lower(btrim(s.name));
$$;

ALTER FUNCTION public.list_contact_segments(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_contact_segments(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_contact_segments(UUID) TO authenticated, service_role;

-- ============================================================
-- 8. add_contacts_to_segment / remove_contacts_from_segment
--
-- Bulk, set-based, and idempotent. Every surface that can put somebody
-- in a segment funnels through these two: the contacts page bulk
-- action, the contact drawer, the inbox sidebar, CSV import, the
-- automation step, the flow node, and the public API.
--
-- ⚠ AUTHORIZATION IS IN THE BODY, NOT THE POLICY. These are INVOKER, so
-- a browser caller is additionally constrained by RLS — but apps/api
-- calls them over an owner connection where RLS does not apply, and the
-- automation step's contact id ultimately originates from a webhook
-- payload. `c.account_id = seg.account_id` on the insert SELECT is what
-- makes a foreign contact id a no-op instead of a cross-tenant write.
--
-- Returns the number of rows actually added/removed, so a caller can
-- tell "already in the segment" from "did something".
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_contacts_to_segment(
  p_segment_id  UUID,
  p_contact_ids UUID[],
  p_source      TEXT DEFAULT 'manual'
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  seg      public.contact_segments;
  v_source TEXT;
  v_added  INTEGER;
BEGIN
  IF p_contact_ids IS NULL OR array_length(p_contact_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO seg FROM contact_segments s WHERE s.id = p_segment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Segment not found';
  END IF;

  IF seg.kind <> 'static' THEN
    -- Not a permissions failure — a category error. Saying so plainly
    -- beats a constraint violation the caller has to decode.
    RAISE EXCEPTION 'Cannot add contacts to a dynamic segment; its membership comes from its filter';
  END IF;

  v_source := CASE
                WHEN p_source IN ('manual','import','automation','flow','api','broadcast')
                  THEN p_source
                ELSE 'manual'
              END;

  WITH inserted AS (
    INSERT INTO contact_segment_members (segment_id, contact_id, source, added_by)
    SELECT seg.id, c.id, v_source, auth.uid()
    FROM contacts c
    WHERE c.id = ANY(p_contact_ids)
      AND c.account_id = seg.account_id
    ON CONFLICT (segment_id, contact_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM inserted;

  RETURN COALESCE(v_added, 0);
END;
$$;

ALTER FUNCTION public.add_contacts_to_segment(UUID, UUID[], TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_contacts_to_segment(UUID, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_contacts_to_segment(UUID, UUID[], TEXT)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.remove_contacts_from_segment(
  p_segment_id  UUID,
  p_contact_ids UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  seg       public.contact_segments;
  v_removed INTEGER;
BEGIN
  IF p_contact_ids IS NULL OR array_length(p_contact_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO seg FROM contact_segments s WHERE s.id = p_segment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Segment not found';
  END IF;

  WITH deleted AS (
    DELETE FROM contact_segment_members m
    USING contacts c
    WHERE m.segment_id = seg.id
      AND m.contact_id = c.id
      AND c.id = ANY(p_contact_ids)
      AND c.account_id = seg.account_id
    RETURNING 1
  )
  SELECT count(*) INTO v_removed FROM deleted;

  RETURN COALESCE(v_removed, 0);
END;
$$;

ALTER FUNCTION public.remove_contacts_from_segment(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_contacts_from_segment(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_contacts_from_segment(UUID, UUID[])
  TO authenticated, service_role;

-- ============================================================
-- 9. filter_contacts(tags, segments, search) — the list page query.
--
-- 025's filter_contacts_by_tags is left exactly as it is; this is its
-- superset, and the page moves over to it. Tags and segments intersect
-- (AND) because that is what stacking two filter chips looks like it
-- should do; multiple values WITHIN either one union (OR), matching
-- 025's existing behaviour for tags.
--
-- Search also covers ig_username and company, which 025 does not — an
-- Instagram contact whose name is still their numeric scoped id was
-- previously unfindable by handle.
-- ============================================================
CREATE OR REPLACE FUNCTION public.filter_contacts(
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
    WHERE (
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

ALTER FUNCTION public.filter_contacts(UUID[], UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts(UUID[], UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts(UUID[], UUID[], TEXT, INT, INT) TO authenticated;

-- ============================================================
-- 10. segments_for_contacts(contact_ids) — the reverse lookup.
--
-- One round trip for "which segments is each of these people in",
-- which the contacts table needs per page and the drawer needs per
-- contact. Static membership only: a dynamic segment has no rows to
-- join, and resolving every dynamic segment for every listed contact
-- is exactly the N+1 this function exists to avoid.
-- ============================================================
CREATE OR REPLACE FUNCTION public.segments_for_contacts(p_contact_ids UUID[])
RETURNS TABLE (contact_id UUID, segment_id UUID)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT m.contact_id, m.segment_id
  FROM contact_segment_members m
  WHERE m.contact_id = ANY(COALESCE(p_contact_ids, ARRAY[]::uuid[]));
$$;

ALTER FUNCTION public.segments_for_contacts(UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.segments_for_contacts(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.segments_for_contacts(UUID[]) TO authenticated;

-- ============================================================
-- 11. Grants on the tables themselves.
-- RLS decides which rows; these decide whether the role may ask at all.
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_segments TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.contact_segment_members TO authenticated;
