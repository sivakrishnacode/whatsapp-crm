-- ============================================================
-- 069_ai_agent_studio.sql — the AI agent becomes a configurable agent,
-- not just a provider key + one free-text prompt.
--
-- What this adds, and why each piece is a column rather than more
-- free text in `ai_configs.system_prompt`:
--
--   1. BUSINESS PROFILE (agent_name … ground_rules)
--      `system_prompt` was one textarea doing five jobs. Splitting it
--      means the prompt builder can order the pieces deliberately
--      (identity → what the business does → hard rules), and the UI can
--      draft one field from the website without overwriting the others.
--      `system_prompt` is KEPT and still appended — every existing
--      account's configuration keeps working untouched.
--
--   2. TONE (tone, response_length, tone_instructions)
--      Enumerated, not prose, because they are the two knobs users
--      actually reach for and an enum can be rendered as a choice.
--
--   3. SKILLS (skills jsonb)
--      A registry keyed by skill id — `{"faq":{"enabled":true},...}` —
--      mirroring the ad-type registry in src/ads/services/ad-types:
--      the code owns the list, the row owns which are on and their
--      config. A skills TABLE would need a migration per new skill.
--
--   4. HANDOFF + FALLBACK (handoff_*, fallback_message)
--      Previously the model's handoff sentinel silently disabled the
--      bot and the customer got nothing back. These make the two
--      dead-ends speakable.
--
--   5. TEST-NUMBER ALLOWLIST (test_mode, test_numbers)
--      The honest version of "try before you go live": with test_mode
--      on, the bot answers ONLY these numbers. There is no message
--      quota here — this is bring-your-own-key, so the provider bills
--      the account directly and a cap would be theatre.
--
--   6. EMBEDDINGS PROVIDER (embeddings_provider/_model on ai_configs,
--      embedding_model on ai_knowledge_chunks)
--      Gemini can now embed as well as OpenAI. Vectors from two
--      different models are NOT comparable, so the chunk records which
--      model produced it and retrieval filters on the current one —
--      otherwise switching provider silently returns nonsense
--      neighbours instead of no neighbours.
--
--   7. KNOWLEDGE SOURCES (source_type … indexed_at)
--      A document can now come from a crawled URL or an uploaded file,
--      not only pasted text, and ingestion can fail — so a document
--      carries a status the UI can show instead of looking "Ready"
--      while being invisible to retrieval.
--
--   8. ai_agent_actions — user-defined HTTP tools the model may call.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ai_configs — provider list, business profile, tone, skills,
--    handoff, fallback, test mode.
-- ============================================================

-- Gemini joins OpenAI and Anthropic. The CHECK is named implicitly by
-- Postgres (ai_configs_provider_check) since 029 declared it inline.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS agent_name           text,
  ADD COLUMN IF NOT EXISTS greeting_message     text,
  ADD COLUMN IF NOT EXISTS business_website     text,
  ADD COLUMN IF NOT EXISTS business_description text,
  ADD COLUMN IF NOT EXISTS ground_rules         text,
  ADD COLUMN IF NOT EXISTS store_currency       text,
  ADD COLUMN IF NOT EXISTS tone                 text NOT NULL DEFAULT 'friendly',
  ADD COLUMN IF NOT EXISTS response_length      text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS tone_instructions    text,
  ADD COLUMN IF NOT EXISTS fallback_message     text,
  ADD COLUMN IF NOT EXISTS handoff_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS handoff_trigger_phrases text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS handoff_message      text,
  ADD COLUMN IF NOT EXISTS skills               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS test_mode            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_numbers         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS embeddings_provider  text,
  ADD COLUMN IF NOT EXISTS embeddings_model     text;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_tone_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_tone_check
  CHECK (tone IN ('friendly', 'professional', 'concise', 'playful'));

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_response_length_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_response_length_check
  CHECK (response_length IN ('short', 'medium', 'long'));

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_embeddings_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_embeddings_provider_check
  CHECK (embeddings_provider IS NULL OR embeddings_provider IN ('openai', 'gemini'));

-- Three test numbers is the product limit, enforced here too so a
-- direct DB write can't produce a state the UI cannot render.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_test_numbers_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_test_numbers_check
  CHECK (array_length(test_numbers, 1) IS NULL OR array_length(test_numbers, 1) <= 3);

COMMENT ON COLUMN ai_configs.system_prompt IS
  'Legacy free-text business context. Still appended to the composed prompt after the structured profile fields — do not drop it, pre-069 accounts have everything in here.';
COMMENT ON COLUMN ai_configs.skills IS
  'Per-skill state keyed by the registry id in src/ai/lib/skills.ts: {"<id>":{"enabled":bool,"config":{...}}}. The code owns the skill list; this row owns which are on.';
COMMENT ON COLUMN ai_configs.test_numbers IS
  'E.164 allowlist. When test_mode is true the auto-reply bot answers ONLY these numbers — everything else is left for a human.';
COMMENT ON COLUMN ai_configs.embeddings_model IS
  'Model that produced the vectors currently in ai_knowledge_chunks. Changing it makes existing vectors unusable, so retrieval filters chunks on it and the UI asks for a reindex.';

-- ============================================================
-- 2. ai_knowledge_documents — where a document came from, and whether
--    it actually made it into the index.
-- ============================================================
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS source_url  text,
  ADD COLUMN IF NOT EXISTS file_name   text,
  ADD COLUMN IF NOT EXISTS byte_size   integer,
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS error       text,
  ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS indexed_at  timestamptz;

ALTER TABLE ai_knowledge_documents DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_type_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_type_check
  CHECK (source_type IN ('text', 'url', 'file'));

-- 'ready'    — chunked and retrievable (semantically if embedded, else lexically).
-- 'indexing' — chunks are being written; retrieval may be partial.
-- 'lexical'  — stored and keyword-searchable, but embedding failed or no key.
-- 'failed'   — nothing usable was extracted; `error` says why.
-- 'stale'    — embedded with a different model than the account now uses.
ALTER TABLE ai_knowledge_documents DROP CONSTRAINT IF EXISTS ai_knowledge_documents_status_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_status_check
  CHECK (status IN ('ready', 'indexing', 'lexical', 'failed', 'stale'));

-- ============================================================
-- 3. ai_knowledge_chunks.embedding_model — see note 6 above.
--    Backfilled to the only model that could have written the existing
--    vectors, so pre-069 corpora keep being retrieved semantically
--    instead of going dark on the first query after this migration.
-- ============================================================
ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model text;

UPDATE ai_knowledge_chunks
   SET embedding_model = 'text-embedding-3-small'
 WHERE embedding IS NOT NULL
   AND embedding_model IS NULL;

UPDATE ai_configs
   SET embeddings_provider = 'openai',
       embeddings_model    = 'text-embedding-3-small'
 WHERE embeddings_api_key IS NOT NULL
   AND embeddings_provider IS NULL;

-- ============================================================
-- 4. Semantic match RPC — filter on the embedding model.
--
-- Same signature plus one argument, so it is additive: the 3-arg form
-- is dropped and replaced by a 4-arg form with a default, and existing
-- callers keep compiling.
--
-- SECURITY DEFINER, so per CLAUDE.md the authorization lives in the
-- body: a JWT caller may only read its own account's chunks; a server
-- connection (auth.uid() IS NULL — how apps/api connects) may read any.
-- ============================================================
DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id       uuid,
  p_query_embedding  text,
  p_match_count      integer DEFAULT 5,
  p_embedding_model  text DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  document_id uuid,
  content     text,
  distance    double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account';
  END IF;

  RETURN QUERY
  SELECT c.id,
         c.document_id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
    FROM ai_knowledge_chunks c
   WHERE c.account_id = p_account_id
     AND c.embedding IS NOT NULL
     AND (p_embedding_model IS NULL OR c.embedding_model = p_embedding_model)
   ORDER BY c.embedding <=> p_query_embedding::vector(1536)
   LIMIT GREATEST(p_match_count, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, text) TO authenticated, service_role;

-- The lexical RPC gains document_id too, so a reply can name which
-- document grounded it regardless of which path retrieved it.
DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  document_id uuid,
  content     text,
  rank        double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query tsquery;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account';
  END IF;

  -- websearch_to_tsquery never raises on user input (plainto_ can, on
  -- some punctuation), which matters because this string comes straight
  -- from a customer's WhatsApp message.
  v_query := websearch_to_tsquery('simple', p_query);
  IF v_query IS NULL OR v_query::text = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id,
         c.document_id,
         c.content,
         ts_rank(c.fts, v_query)::double precision AS rank
    FROM ai_knowledge_chunks c
   WHERE c.account_id = p_account_id
     AND c.fts @@ v_query
   ORDER BY ts_rank(c.fts, v_query) DESC
   LIMIT GREATEST(p_match_count, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;

-- ============================================================
-- 5. ai_agent_actions — user-defined HTTP tools.
--
-- The model is handed these as function/tool declarations and the
-- SERVER performs the call; the browser never does. `headers` may hold
-- an API key, so the whole object is encrypted at rest with the same
-- AES-256-GCM helper as ai_configs.api_key and is never returned to
-- the client (the UI shows which header names are set, not values).
--
-- `name` is the tool name the model calls: [a-z0-9_], unique per
-- account. `intent` groups actions in the UI only.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agent_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,48}$'),
  intent       text,
  description  text NOT NULL,
  method       text NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url          text NOT NULL,
  headers_enc  text,
  -- [{ name, type: string|number|boolean, description, required, in: query|body|path }]
  parameters   jsonb NOT NULL DEFAULT '[]'::jsonb,
  body_template jsonb,
  enabled      boolean NOT NULL DEFAULT true,
  timeout_ms   integer NOT NULL DEFAULT 8000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  last_used_at timestamptz,
  last_status  integer,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS ai_agent_actions_account_idx
  ON ai_agent_actions (account_id);

ALTER TABLE ai_agent_actions ENABLE ROW LEVEL SECURITY;

-- Settings-class, same shape as ai_configs: members read, admin+ write.
DROP POLICY IF EXISTS ai_agent_actions_select ON ai_agent_actions;
CREATE POLICY ai_agent_actions_select ON ai_agent_actions FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_agent_actions_insert ON ai_agent_actions;
CREATE POLICY ai_agent_actions_insert ON ai_agent_actions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_actions_update ON ai_agent_actions;
CREATE POLICY ai_agent_actions_update ON ai_agent_actions FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_actions_delete ON ai_agent_actions;
CREATE POLICY ai_agent_actions_delete ON ai_agent_actions FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_agent_actions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_agent_actions_updated_at ON ai_agent_actions;
CREATE TRIGGER ai_agent_actions_updated_at
  BEFORE UPDATE ON ai_agent_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_agent_actions_updated_at();
