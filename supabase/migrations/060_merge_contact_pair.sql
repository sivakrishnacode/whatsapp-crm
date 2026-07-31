-- ============================================================
-- 060_merge_contact_pair.sql — part 2 of 3 (see 059).
--
-- `public.merge_contacts_into(survivor, loser)` — fold one contact
-- into another, losing nothing.
--
-- WHY IT IS NEEDED NOW
--   Canonicalizing phone numbers (059 → backfill → 061) can make two
--   rows that were distinct become the same number. That is not an
--   edge case, it IS the reported bug at its worst: this database
--   holds "Pradeep" (+91 97917 66444 arriving from WhatsApp as
--   `919791766444`) and "Pradeep Kumar" (the same person typing
--   `9791766444` into the web widget) as two contacts with separate
--   conversations, precisely because the two channels stored the
--   number differently. Canonicalizing makes them equal, and the
--   partial unique index on (account_id, phone_normalized) then
--   rejects the second write. Merging is the resolution, not a
--   workaround.
--
-- WHY NOT REUSE merge_duplicate_contacts() FROM 022
--   Two reasons.
--
--   1. It groups by *current* phone_normalized. The pair above does
--      not match on that today — `9791766444` and `919791766444` are
--      different keys — which is exactly why both rows exist. It only
--      becomes findable after canonicalization, which is the step
--      that cannot complete without the merge.
--   2. It re-points 9 child tables. `contacts` now has 17 children:
--      notifications, ctwa_clicks, ecommerce_orders, whatsapp_orders,
--      instagram_comments, form_submissions, web_sessions and
--      form_bookings all arrived later. Every one of those FKs is
--      ON DELETE SET NULL, so running the old function today does not
--      error — it silently orphans a customer's orders and bookings.
--      That is the worst possible failure mode for a merge helper, and
--      it is why this one enumerates the children explicitly and is
--      commented with the obligation to extend it.
--
--   ⚠️ ADDING A TABLE THAT REFERENCES contacts? Add it here too.
--      Verify the list with:
--        SELECT conrelid::regclass FROM pg_constraint
--         WHERE contype='f' AND confrelid='public.contacts'::regclass;
--
-- SAFETY
--   Refuses to merge across accounts, or a contact into itself. Runs
--   in the caller's transaction so a failure part-way leaves nothing
--   half-merged. Identity columns move to the survivor only where the
--   survivor has none — a merge never overwrites known-good data.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_contacts_into(
  p_survivor UUID,
  p_loser    UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_survivor RECORD;
  v_loser    RECORD;
BEGIN
  IF p_survivor = p_loser THEN
    RAISE EXCEPTION 'merge_contacts_into: survivor and loser are the same contact (%)', p_survivor;
  END IF;

  SELECT * INTO v_survivor FROM contacts WHERE id = p_survivor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_contacts_into: survivor % not found', p_survivor;
  END IF;

  SELECT * INTO v_loser FROM contacts WHERE id = p_loser;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_contacts_into: loser % not found', p_loser;
  END IF;

  -- Tenancy is this function's responsibility: it is SECURITY DEFINER
  -- specifically so it can re-point rows past RLS, which means it must
  -- not be usable to drag one tenant's history into another's.
  IF v_survivor.account_id <> v_loser.account_id THEN
    RAISE EXCEPTION 'merge_contacts_into: refusing to merge across accounts (% vs %)',
      v_survivor.account_id, v_loser.account_id;
  END IF;

  -- ----------------------------------------------------------
  -- 1) Plain re-point — no contact-scoped unique constraint.
  --    `conversations` is ON DELETE CASCADE, so this re-point is
  --    what saves its rows (and their messages) from being deleted
  --    along with the loser.
  -- ----------------------------------------------------------
  UPDATE conversations                 SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE contact_notes                 SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE deals                         SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE broadcast_recipients          SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE automation_logs               SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE automation_pending_executions SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE notifications                 SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE ctwa_clicks                   SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE ecommerce_orders              SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE whatsapp_orders               SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE instagram_comments            SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE form_submissions              SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE form_bookings                 SET contact_id = p_survivor WHERE contact_id = p_loser;
  UPDATE web_sessions                  SET contact_id = p_survivor WHERE contact_id = p_loser;

  -- ----------------------------------------------------------
  -- 2) Conflict-guarded re-point for UNIQUE(contact_id, tag_id):
  --    move only tags the survivor lacks, drop the rest.
  -- ----------------------------------------------------------
  UPDATE contact_tags ct SET contact_id = p_survivor
    WHERE ct.contact_id = p_loser
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags s
        WHERE s.contact_id = p_survivor AND s.tag_id = ct.tag_id
      );
  DELETE FROM contact_tags WHERE contact_id = p_loser;

  -- Same guard for UNIQUE(contact_id, custom_field_id). The
  -- survivor's own value wins on conflict — it is the older record,
  -- and an agent may have curated it.
  UPDATE contact_custom_values cv SET contact_id = p_survivor
    WHERE cv.contact_id = p_loser
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values s
        WHERE s.contact_id = p_survivor AND s.custom_field_id = cv.custom_field_id
      );
  DELETE FROM contact_custom_values WHERE contact_id = p_loser;

  -- flow_runs carries a partial UNIQUE on active runs per contact.
  -- Re-point only NON-active runs to preserve history; an active
  -- loser run is left for its FK's ON DELETE SET NULL, which avoids
  -- colliding with the survivor's own active run.
  UPDATE flow_runs SET contact_id = p_survivor
    WHERE contact_id = p_loser AND status <> 'active';

  -- ----------------------------------------------------------
  -- 3) Identity and profile columns.
  --
  --    `web_visitor_id` and `ig_scoped_id` are how a returning
  --    browser or an Instagram DM finds its contact again. If the
  --    loser holds one and the survivor does not, it MUST move —
  --    dropping it strands that channel on a contact that no longer
  --    exists. Each has a partial unique index per account, so the
  --    loser has to release the value before the survivor can take
  --    it; both statements are in this one transaction.
  --
  --    Fill-only-if-empty for everything else: the survivor is the
  --    older record, and a merge is not an occasion to overwrite what
  --    an agent has already curated.
  -- ----------------------------------------------------------
  UPDATE contacts SET web_visitor_id = NULL, ig_scoped_id = NULL
    WHERE id = p_loser;

  UPDATE contacts SET
      web_visitor_id = COALESCE(web_visitor_id, v_loser.web_visitor_id),
      ig_scoped_id   = COALESCE(ig_scoped_id,   v_loser.ig_scoped_id),
      ig_username    = COALESCE(ig_username,    v_loser.ig_username),
      name           = COALESCE(NULLIF(name, ''),       NULLIF(v_loser.name, '')),
      email          = COALESCE(NULLIF(email, ''),      NULLIF(v_loser.email, '')),
      company        = COALESCE(NULLIF(company, ''),    NULLIF(v_loser.company, '')),
      avatar_url     = COALESCE(NULLIF(avatar_url, ''), NULLIF(v_loser.avatar_url, '')),
      updated_at     = now()
    WHERE id = p_survivor;

  DELETE FROM contacts WHERE id = p_loser;
END;
$$;

ALTER FUNCTION public.merge_contacts_into(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contacts_into(UUID, UUID) FROM PUBLIC;

COMMENT ON FUNCTION public.merge_contacts_into(UUID, UUID) IS
  'Fold the loser contact into the survivor, re-pointing every child row first. Refuses to cross accounts. MUST be extended whenever a new table references contacts — otherwise that table''s rows are silently orphaned by the loser''s ON DELETE SET NULL.';
