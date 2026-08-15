-- ============================================================
-- 084_multi_agent.sql — a workspace may run SEVERAL agents.
--
-- WHAT WAS WRONG
--
--   `ai_configs.account_id` was UNIQUE, so a workspace had exactly one
--   agent, and that one row carried two unrelated kinds of setting:
--
--     * WORKSPACE things — the provider key, the credit mode, the
--       embeddings key/model. One per workspace by nature: the credit
--       wallet is per workspace, and `ai_knowledge_chunks.embedding` is
--       vector(1536) written by ONE model, so a second embeddings model
--       in the same workspace fragments retrieval (see 069).
--     * AGENT things — who it is, how it speaks, what it knows, when it
--       hands off. There is no reason a business may have only one of
--       these, and every reason to want a sales agent on WhatsApp and a
--       support agent on the web widget.
--
-- WHAT THIS DOES
--
--   `ai_configs` KEEPS the workspace things and LOSES the agent things.
--   The new `ai_agents` table holds the agent things, many per account.
--   Every existing row becomes one agent, so nothing changes for an
--   account that never opens the new screen.
--
--   The agent columns are DROPPED from `ai_configs` at the end rather
--   than left behind, because two copies of `tone` in one schema is a
--   question ("which one wins?") that costs more than the rollback
--   convenience is worth. The backfill runs first, in the same file.
--
-- ROUTING — HOW AN INBOUND MESSAGE PICKS AN AGENT
--
--   `channels` + `priority`, first match wins:
--
--     1. If the conversation already has `ai_agent_id`, that agent keeps
--        it. A thread must not change personality halfway through
--        because somebody reordered the list.
--     2. Otherwise the active agents whose `channels` contains this
--        conversation's channel — or whose `channels` is EMPTY, meaning
--        "any channel" — in `priority` order, first one wins.
--
--   Empty `channels` is deliberately permissive here, unlike
--   `automations.channels`, and for the same reason it is there: every
--   agent that predates this migration has an empty array and must keep
--   answering everybody.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ai_agents — one row per agent.
--
-- No key column of any kind. The provider credential stays on
-- `ai_configs` (workspace) and is resolved at call time, so an agent row
-- is safe to read, copy and duplicate; `model` is NULL when the agent
-- has no opinion and follows the workspace default.
--
-- `UNIQUE (id, account_id)` looks redundant next to the primary key and
-- is not: it is what lets the two link tables below carry a composite
-- foreign key, which makes a cross-tenant link impossible in the
-- database rather than merely unlikely in the service. Prisma bypasses
-- RLS here (apps/api connects as the owner), so this is the only layer
-- that cannot be forgotten.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The label in the list ("Sales"). Distinct from `agent_name`, which
  -- is what the agent calls ITSELF to a customer ("Nila").
  name                            text NOT NULL
                                    CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),

  -- Routing.
  channels                        text[] NOT NULL DEFAULT '{}'
                                    CHECK (channels <@ ARRAY['whatsapp', 'instagram', 'web']::text[]),
  priority                        integer NOT NULL DEFAULT 1 CHECK (priority >= 0),
  is_active                       boolean NOT NULL DEFAULT false,

  -- Model only. The provider and the key belong to the workspace.
  model                           text,

  -- Persona.
  agent_name                      text,
  greeting_message                text,
  business_website                text,
  business_description            text,
  ground_rules                    text,
  store_currency                  text,
  tone                            text NOT NULL DEFAULT 'friendly'
                                    CHECK (tone IN ('friendly', 'professional', 'concise', 'playful')),
  response_length                 text NOT NULL DEFAULT 'medium'
                                    CHECK (response_length IN ('short', 'medium', 'long')),
  tone_instructions               text,
  -- Pre-069 free-text business context. Carried across per agent so a
  -- migrated account keeps everything it had written.
  system_prompt                   text,

  -- Escalation.
  fallback_message                text,
  handoff_enabled                 boolean NOT NULL DEFAULT false,
  handoff_trigger_phrases         text[] NOT NULL DEFAULT '{}',
  handoff_message                 text,

  -- Behaviour.
  auto_reply_enabled              boolean NOT NULL DEFAULT false,
  auto_reply_max_per_conversation integer NOT NULL DEFAULT 3
                                    CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 20),
  test_mode                       boolean NOT NULL DEFAULT false,
  test_numbers                    text[] NOT NULL DEFAULT '{}',

  -- Per-skill state, keyed by the registry id in src/ai/lib/skills.ts.
  skills                          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Library scoping. TRUE means "everything in the workspace library",
  -- which is what a new agent gets and what every migrated agent keeps.
  --
  -- ⚠️ The booleans exist so that an EMPTY link table is never ambiguous.
  -- If "no rows" had to mean "all documents", then unticking the last
  -- document would silently re-grant the whole library — the same trap
  -- migration 076 documents for segment rules, where an unusable filter
  -- had to mean nobody rather than everybody.
  uses_all_knowledge              boolean NOT NULL DEFAULT true,
  uses_all_actions                boolean NOT NULL DEFAULT true,

  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, account_id)
);

COMMENT ON TABLE ai_agents IS
  'One AI agent. Many per workspace, routed by channels + priority. Holds no credential: the provider key, credit mode and embeddings settings stay on ai_configs, which is the workspace-level row.';

COMMENT ON COLUMN ai_agents.channels IS
  'Which conversation channels this agent answers. EMPTY MEANS ANY — every agent migrated from ai_configs has an empty array and must keep answering everybody.';

COMMENT ON COLUMN ai_agents.model IS
  'Model override. NULL follows ai_configs.model (or the platform model when running on our key). The provider is never per-agent: there is one stored key per workspace and it belongs to one provider.';

CREATE INDEX IF NOT EXISTS ai_agents_account_idx
  ON ai_agents (account_id, priority, created_at);

-- Routing reads this on every inbound message that reaches the bot.
CREATE INDEX IF NOT EXISTS ai_agents_active_idx
  ON ai_agents (account_id, priority)
  WHERE is_active;

-- Two agents called "Sales" in one workspace is a support ticket, not a
-- feature. Case-insensitive, because "sales" and "Sales" are the same
-- name to the person reading the list.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_account_name_key
  ON ai_agents (account_id, lower(btrim(name)));

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

-- Members may read their own workspace's agents (the inbox shows which
-- agent is on a thread). Every write goes through apps/api, which owns
-- the entitlement check and the routing invariants, so there is
-- deliberately no INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION public.update_ai_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_agents_updated_at ON ai_agents;
CREATE TRIGGER ai_agents_updated_at
  BEFORE UPDATE ON ai_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_agents_updated_at();

-- ============================================================
-- 2. The library links.
--
-- Knowledge documents and custom actions stay workspace-level: one
-- upload, one embedding cost, one reindex. An agent SELECTS from that
-- library rather than owning a copy — uploading the same price list per
-- agent would bill the account's credit wallet once per copy.
--
-- `account_id` is carried on the link rows only so the composite foreign
-- keys can exist. It is redundant data that buys a guarantee: with them,
-- linking one tenant's agent to another tenant's document is rejected by
-- Postgres, not by remembering to write a WHERE clause.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_knowledge_documents_id_account_key'
  ) THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_id_account_key UNIQUE (id, account_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_agent_actions_id_account_key'
  ) THEN
    ALTER TABLE ai_agent_actions
      ADD CONSTRAINT ai_agent_actions_id_account_key UNIQUE (id, account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_agent_knowledge (
  agent_id    uuid NOT NULL,
  document_id uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, document_id),
  FOREIGN KEY (agent_id, account_id)
    REFERENCES ai_agents (id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, account_id)
    REFERENCES ai_knowledge_documents (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_agent_knowledge_document_idx
  ON ai_agent_knowledge (document_id);

CREATE TABLE IF NOT EXISTS ai_agent_action_links (
  agent_id   uuid NOT NULL,
  action_id  uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, action_id),
  FOREIGN KEY (agent_id, account_id)
    REFERENCES ai_agents (id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (action_id, account_id)
    REFERENCES ai_agent_actions (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_agent_action_links_action_idx
  ON ai_agent_action_links (action_id);

ALTER TABLE ai_agent_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_action_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_knowledge_select ON ai_agent_knowledge;
CREATE POLICY ai_agent_knowledge_select ON ai_agent_knowledge FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_agent_action_links_select ON ai_agent_action_links;
CREATE POLICY ai_agent_action_links_select ON ai_agent_action_links FOR SELECT
  USING (is_account_member(account_id));

-- ============================================================
-- 3. Attribution — which agent answered.
--
-- `conversations.ai_agent_id` is BOTH the stickiness latch (step 1 of
-- routing) and the per-thread record. `messages.ai_agent_id` is what
-- makes "412 replies in the last 30 days" answerable per agent without
-- a counter that can drift.
--
-- ON DELETE SET NULL on both: deleting an agent must not delete the
-- conversation it once answered, and an orphaned reply is still a reply.
-- The stat simply stops attributing it, which is the truth.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;

-- When the bot gave up on this thread. `ai_autoreply_disabled` (029)
-- says THAT it stopped; this says when, which is what a 30-day handoff
-- rate needs.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_at timestamptz;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_ai_agent_idx
  ON conversations (ai_agent_id)
  WHERE ai_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_ai_agent_idx
  ON messages (ai_agent_id, created_at DESC)
  WHERE ai_agent_id IS NOT NULL;

-- ============================================================
-- 4. Backfill — every existing config becomes one agent.
--
-- Guarded by NOT EXISTS rather than ON CONFLICT: re-running this file
-- must not resurrect an agent somebody has since deleted, and must not
-- overwrite the one they have since edited.
-- ============================================================
INSERT INTO ai_agents (
  account_id, created_by, name, channels, priority, is_active, model,
  agent_name, greeting_message, business_website, business_description,
  ground_rules, store_currency, tone, response_length, tone_instructions,
  system_prompt, fallback_message, handoff_enabled, handoff_trigger_phrases,
  handoff_message, auto_reply_enabled, auto_reply_max_per_conversation,
  test_mode, test_numbers, skills, created_at
)
SELECT
  c.account_id,
  c.created_by,
  -- What they already called it, else a name that reads correctly in a
  -- list of one.
  COALESCE(NULLIF(btrim(c.agent_name), ''), 'AI agent'),
  '{}'::text[],            -- answers every channel, exactly as before
  1,
  c.is_active,
  c.model,
  c.agent_name,
  c.greeting_message,
  c.business_website,
  c.business_description,
  c.ground_rules,
  c.store_currency,
  COALESCE(c.tone, 'friendly'),
  COALESCE(c.response_length, 'medium'),
  c.tone_instructions,
  c.system_prompt,
  c.fallback_message,
  COALESCE(c.handoff_enabled, false),
  COALESCE(c.handoff_trigger_phrases, '{}'::text[]),
  c.handoff_message,
  COALESCE(c.auto_reply_enabled, false),
  COALESCE(c.auto_reply_max_per_conversation, 3),
  COALESCE(c.test_mode, false),
  COALESCE(c.test_numbers, '{}'::text[]),
  COALESCE(c.skills, '{}'::jsonb),
  c.created_at
FROM ai_configs c
WHERE NOT EXISTS (
  SELECT 1 FROM ai_agents a WHERE a.account_id = c.account_id
);

-- Threads the bot has already answered belong to that one agent. Done
-- while the mapping is still unambiguous — one agent per account — so
-- the new stats and the stickiness latch start out true rather than
-- empty.
UPDATE conversations c
   SET ai_agent_id = a.id
  FROM ai_agents a
 WHERE a.account_id = c.account_id
   AND c.ai_agent_id IS NULL
   AND c.ai_reply_count > 0;

-- Same for the replies themselves, bounded to 90 days: the stat windows
-- are 30 days, and rewriting the whole message history to answer a
-- 30-day question is work nobody asked for.
UPDATE messages m
   SET ai_agent_id = a.id
  FROM conversations c
  JOIN ai_agents a ON a.account_id = c.account_id
 WHERE m.conversation_id = c.id
   AND m.ai_agent_id IS NULL
   AND m.sender_type = 'bot'
   AND m.created_at > now() - interval '90 days';

-- ============================================================
-- 5. The plan cap.
--
-- Agent count is CURRENT STATE, so it is counted live from the table
-- that already holds the truth — no counter, no drift (the distinction
-- migration 075 draws between flow metrics and state metrics).
--
-- NULL is unlimited, exactly as `max_flows` encodes it. Starter keeps
-- the single agent it has today, so nobody loses anything they had.
-- ============================================================
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS max_ai_agents integer;

UPDATE subscription_plans SET max_ai_agents = 1    WHERE name = 'STARTER';
UPDATE subscription_plans SET max_ai_agents = 5    WHERE name = 'GROWTH';
UPDATE subscription_plans SET max_ai_agents = NULL WHERE name = 'ENTERPRISE';
-- FREE is retired (066) but historical rows still resolve their plan_id
-- through it, so it needs a number rather than accidental unlimited.
UPDATE subscription_plans SET max_ai_agents = 1    WHERE name = 'FREE';

-- The return type changes, so this is a DROP and CREATE rather than a
-- REPLACE. `check_account_limit` is plpgsql and resolves it by name at
-- run time, so it needs no change of its own to see the new column.
DROP FUNCTION IF EXISTS public.get_account_entitlement(uuid);

CREATE FUNCTION public.get_account_entitlement(p_account_id uuid)
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
  max_storage_mb         integer,
  max_ai_agents          integer
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
      p.max_storage_mb,
      p.max_ai_agents
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
    g.max_flows, g.max_team_members, g.max_storage_mb, g.max_ai_agents
  FROM graded g;
$$;

REVOKE ALL ON FUNCTION public.get_account_entitlement(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.get_account_entitlement(uuid) IS
  'Plan limits plus a standing (good/grace/lapsed) for one workspace, resolved through accounts.owner_user_id. The single source for every entitlement gate in apps/api. Account-scoped on purpose: the per-user get_user_subscription() resolves to nothing for an invited teammate.';

-- `ai_agents` joins the current-state metrics. Everything else in this
-- function is unchanged from 075.
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
    -- The four below are current state, counted from the tables that
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
    WHEN 'ai_agents' THEN
      v_limit := v_ent.max_ai_agents;
      -- Every agent counts, active or not: a paused agent still occupies
      -- a slot, and a cap you can dodge by pausing is not a cap.
      SELECT count(*) INTO v_used FROM ai_agents ag
       WHERE ag.account_id = p_account_id;
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
-- 6. Retrieval, scoped to the agent's selection.
--
-- Both match functions gain an optional document-id filter. NULL keeps
-- the old behaviour exactly (the whole workspace corpus), which is what
-- `uses_all_knowledge` resolves to — so the common case does not pay for
-- an array it does not need.
--
-- Filtering here rather than in TypeScript matters: post-filtering a
-- top-5 result set would return nothing whenever the best five chunks
-- happen to belong to documents this agent is not allowed to read, and
-- "the agent has no knowledge" is indistinguishable from "the agent
-- found nothing relevant".
-- ============================================================
DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer, text);

CREATE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id       uuid,
  p_query_embedding  text,
  p_match_count      integer,
  p_embedding_model  text DEFAULT NULL,
  p_document_ids     uuid[] DEFAULT NULL
)
RETURNS TABLE (id uuid, document_id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.document_id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    -- NULL means "don't care" (a caller that has not adopted the
    -- argument yet); pre-069 rows were backfilled in 069, so a real
    -- model name never silently excludes an entire legacy corpus.
    AND (p_embedding_model IS NULL OR c.embedding_model = p_embedding_model)
    AND (p_document_ids IS NULL OR c.document_id = ANY (p_document_ids))
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);

CREATE FUNCTION public.match_ai_knowledge_fts(
  p_account_id   uuid,
  p_query        text,
  p_match_count  integer,
  p_document_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (id uuid, document_id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.document_id,
         c.content,
         ts_rank(c.fts, websearch_to_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    -- websearch_to_tsquery, not plainto_: this string is a customer's
    -- raw WhatsApp message, and websearch_ is the variant designed to
    -- swallow arbitrary punctuation and quoting without raising.
    AND c.fts @@ websearch_to_tsquery('simple', p_query)
    AND (p_document_ids IS NULL OR c.document_id = ANY (p_document_ids))
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- Same grants as 032/069: SECURITY INVOKER, so the browser's own RLS
-- still applies when it calls these through PostgREST.
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, text, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid[]) TO authenticated, service_role;

-- ============================================================
-- 7. ai_configs becomes the workspace row.
--
-- Everything dropped here was copied into ai_agents in step 4. The
-- columns that stay are the ones that are genuinely one-per-workspace:
-- the provider and its key, the credit mode, and the embeddings
-- settings that the stored vectors are bound to.
--
-- `is_active` goes with them: "is the AI on" is now a property of each
-- agent, and a workspace-level copy would immediately disagree with the
-- three agents underneath it.
-- ============================================================
ALTER TABLE ai_configs
  DROP COLUMN IF EXISTS system_prompt,
  DROP COLUMN IF EXISTS is_active,
  DROP COLUMN IF EXISTS auto_reply_enabled,
  DROP COLUMN IF EXISTS auto_reply_max_per_conversation,
  DROP COLUMN IF EXISTS agent_name,
  DROP COLUMN IF EXISTS greeting_message,
  DROP COLUMN IF EXISTS business_website,
  DROP COLUMN IF EXISTS business_description,
  DROP COLUMN IF EXISTS ground_rules,
  DROP COLUMN IF EXISTS store_currency,
  DROP COLUMN IF EXISTS tone,
  DROP COLUMN IF EXISTS response_length,
  DROP COLUMN IF EXISTS tone_instructions,
  DROP COLUMN IF EXISTS fallback_message,
  DROP COLUMN IF EXISTS handoff_enabled,
  DROP COLUMN IF EXISTS handoff_trigger_phrases,
  DROP COLUMN IF EXISTS handoff_message,
  DROP COLUMN IF EXISTS skills,
  DROP COLUMN IF EXISTS test_mode,
  DROP COLUMN IF EXISTS test_numbers;

COMMENT ON TABLE ai_configs IS
  'WORKSPACE-level AI settings: the provider and its encrypted key, the credit mode (platform vs byok) and the embeddings provider/model the stored vectors belong to. One row per account. Everything about an AGENT — persona, tone, skills, escalation, test mode — lives in ai_agents, many per account (migration 084).';
