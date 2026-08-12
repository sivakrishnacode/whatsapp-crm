-- ============================================================
-- 079_inbox_presence_channel.sql — let agents see each other inside a
-- conversation, without letting them see into another tenant.
--
-- WHAT THIS IS FOR
--
--   The inbox is shared: several agents work one queue. Nothing today
--   tells them when they are standing on the same thread, so the
--   failure mode is two people typing a reply to the same customer and
--   both sending. Assignment (`conversations.assigned_agent_id`) does
--   not prevent it — HumanTakeoverService's own comment notes that
--   assigning is a deliberate act almost nobody performs, so in
--   practice the queue is worked unassigned.
--
--   Who-is-looking-at-what is ephemeral by nature: it is true for as
--   long as a tab is open and meaningless afterwards. So it is carried
--   on Realtime PRESENCE, not in a table. Nothing is written to
--   Postgres, there are no heartbeat rows to sweep, and a closed laptop
--   drops out on its own when the socket dies.
--
--   That is deliberately NOT how `member_presence` (migration 024)
--   works, and the two are not redundant. That one answers "is Priya at
--   work today", which has to survive her tab being closed and is
--   therefore a table with a heartbeat. This one answers "is Priya in
--   THIS thread right now", which must not.
--
-- WHY THERE IS A MIGRATION AT ALL
--
--   A Realtime channel is public by default: any authenticated user who
--   knows a topic string may join it. The topic here ends in an
--   account id, so a public channel would let a member of one workspace
--   subscribe to another's and watch their agents move between
--   conversations — names, user ids and conversation ids, live.
--
--   Marking the channel `private` moves it under RLS on
--   `realtime.messages`, and this policy is then the ONLY thing
--   deciding who may join. Same rule as everywhere else in this schema:
--   `is_account_member` (migration 017). Note the parallel to the
--   warning in CLAUDE.md about SECURITY DEFINER RPCs — the check has to
--   live where the join is authorised, because there is no second gate
--   behind it.
--
--   Read AND write are both required: presence is implemented as
--   broadcast under the hood, so an agent who may not INSERT cannot
--   announce themselves, and one who may not SELECT cannot see anyone.
--   Both are gated on the same predicate, and a `viewer` passes — a
--   read-only teammate seeing that someone is in a thread is the point,
--   and they cannot reply over anyone regardless.
--
-- SCOPE OF THE POLICY
--
--   The USING clause matches only topics shaped `inbox-presence:<uuid>`,
--   so this grants nothing on any other private channel. There are no
--   other private channels today; when there are, they add their own
--   policies and are unaffected by this one. Public channels — such as
--   the existing `inbox-realtime` postgres_changes channel — do not
--   consult `realtime.messages` RLS at all and are untouched.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Topic → account id, or NULL when the topic is not ours.
--
-- The regex spells a UUID out exactly rather than accepting
-- `[0-9a-f-]{36}`, because the looser form matches strings (36 dashes)
-- that then throw on the ::uuid cast — and a policy that raises rather
-- than returning false fails open-ended, breaking every join instead of
-- denying one. `substring` with no match returns NULL, and
-- `is_account_member(NULL)` is false, so an unmatched topic is simply
-- not authorised.
--
-- IMMUTABLE + SECURITY INVOKER: pure string work, no table access, so
-- there is nothing here to abuse. The authorization itself lives in
-- is_account_member, which is the function that reads profiles.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_presence_account_id(topic TEXT)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT substring(
    topic
    FROM '^inbox-presence:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  )::uuid;
$$;

COMMENT ON FUNCTION public.inbox_presence_account_id(TEXT) IS
  'Extracts the account id from an inbox-presence Realtime topic, or NULL if the topic is not one. Used by the realtime.messages RLS policies in migration 079.';

ALTER FUNCTION public.inbox_presence_account_id(TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.inbox_presence_account_id(TEXT)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- The policies. SELECT = receive other agents' presence, INSERT =
-- announce your own. Both on the same predicate.
-- ------------------------------------------------------------
DO $$
BEGIN
  -- `realtime.messages` is managed by Supabase and exists on every
  -- hosted project, but guard anyway so a local stack without the
  -- realtime schema can still run the migration set end to end.
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'realtime' AND tablename = 'messages'
  ) THEN
    RAISE NOTICE '079: realtime.messages not present — skipping inbox presence policies.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS inbox_presence_read ON realtime.messages;
  CREATE POLICY inbox_presence_read ON realtime.messages
    FOR SELECT TO authenticated
    USING (
      public.is_account_member(
        public.inbox_presence_account_id(realtime.topic())
      )
    );

  DROP POLICY IF EXISTS inbox_presence_write ON realtime.messages;
  CREATE POLICY inbox_presence_write ON realtime.messages
    FOR INSERT TO authenticated
    WITH CHECK (
      public.is_account_member(
        public.inbox_presence_account_id(realtime.topic())
      )
    );
END $$;
