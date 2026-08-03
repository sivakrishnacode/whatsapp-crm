-- ============================================================
-- 064_instagram_comment_funnels.sql — comment → DM funnels with a
-- soft follow gate.
--
-- WHAT THIS IS
--   Someone comments on a post; the business private-replies with a
--   DM, optionally asks them to follow, then sends the reward link.
--   The "link in comments" pattern, automated.
--
-- WHY IT IS NOT AN AUTOMATION
--   `automations` fire on a contact. A first-time commenter has no
--   contact row — instagram-comments.service deliberately never
--   creates one, because a comment is not consent to be in a CRM and a
--   viral post would flood the table. So the entire audience this
--   feature exists for is exactly the audience automations cannot see.
--
-- WHY THERE IS AN OPT-IN STEP AT ALL
--   Meta's User Profile API (is_user_follow_business) refuses to answer
--   for someone who has only commented — a comment is not consent. The
--   opening "tap below" message exists solely to manufacture the
--   inbound event that unlocks the lookup. It is a protocol
--   requirement, not a growth trick.
--
-- SOFT GATE
--   The reward is delivered whether or not they actually follow. The
--   gate asks once and moves on, so a stale follow status or a failed
--   profile lookup can never cost a conversion. That is why there is
--   no re-check state and no loop.
--
-- OFF BY DEFAULT, TWICE
--   instagram_config.comment_funnels_enabled is the account master
--   switch and defaults FALSE; funnels themselves default is_active
--   FALSE. A feature that DMs strangers on the business's behalf must
--   never switch itself on for an account that has not asked for it.
-- ============================================================


-- ============================================================
-- 0) Account master switch
-- ============================================================

ALTER TABLE instagram_config
  ADD COLUMN IF NOT EXISTS comment_funnels_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN instagram_config.comment_funnels_enabled IS
  'Master switch for comment → DM funnels. FALSE (the default) means no funnel fires regardless of its own is_active, so an account can be paused wholesale without editing every funnel. Off by default because this feature sends DMs to people who have never messaged the business.';


-- ============================================================
-- 1) instagram_comment_funnels — the definition
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_comment_funnels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name                TEXT NOT NULL,

  -- Scope ------------------------------------------------------

  -- NULL means every post, present and future. A specific id scopes the
  -- funnel to one piece of media. Deliberately a plain TEXT and not an
  -- FK to instagram_media: media rows are a synced cache that a "Sync
  -- posts" run can rewrite, and a funnel must not be deleted because a
  -- cache row went away.
  ig_media_id         TEXT,

  -- Empty means any comment matches. Matched case-insensitively as
  -- substrings, the same rule as automations' KeywordMatchTriggerConfig
  -- — one keyword semantic across the product, not two.
  keywords            TEXT[] NOT NULL DEFAULT '{}',

  -- Step 1: the opening private reply ---------------------------

  optin_text          TEXT NOT NULL,
  -- Quick-reply titles are capped at 20 characters by Meta. Enforced
  -- here so a too-long label is rejected when it is saved, rather than
  -- at 2am when a post goes viral.
  optin_button_label  TEXT NOT NULL DEFAULT 'I''m ready 🙂',

  -- Step 2: the follow gate -------------------------------------

  follow_gate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  follow_ask_text     TEXT,
  follow_button_label TEXT NOT NULL DEFAULT 'I followed you! ✅',

  -- Step 3: the reward ------------------------------------------

  reward_text         TEXT NOT NULL,
  -- [{ "label": "Click here!", "url": "https://..." }]. Rendered as a
  -- button template with web_url buttons — these are link-outs, not
  -- postbacks, so tapping one leaves the thread rather than driving the
  -- machine. Meta caps a button template at 3.
  reward_buttons      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Optional public comment reply, posted alongside the DM. The "check
  -- your DMs 📩" convention: it tells the other 500 readers of that
  -- thread that something happened, which is most of why the pattern
  -- works at all.
  public_reply_text   TEXT,

  is_active           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Denormalised counters, same trade-off as forms.submission_count:
  -- the funnel list would otherwise COUNT(*) over runs per row.
  matched_count       INTEGER NOT NULL DEFAULT 0,
  delivered_count     INTEGER NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT instagram_comment_funnels_optin_label_chk
    CHECK (char_length(optin_button_label) BETWEEN 1 AND 20),
  CONSTRAINT instagram_comment_funnels_follow_label_chk
    CHECK (char_length(follow_button_label) BETWEEN 1 AND 20),
  -- Meta's button-template limit. A funnel that saves 4 reward buttons
  -- would fail on send, i.e. after the visitor has already opted in and
  -- followed — the worst possible moment to discover a config error.
  CONSTRAINT instagram_comment_funnels_reward_buttons_chk
    CHECK (
      jsonb_typeof(reward_buttons) = 'array'
      AND jsonb_array_length(reward_buttons) <= 3
    ),
  -- A gate with no question is a gate that sends an empty DM.
  CONSTRAINT instagram_comment_funnels_gate_chk
    CHECK (
      follow_gate_enabled = FALSE
      OR (follow_ask_text IS NOT NULL AND char_length(trim(follow_ask_text)) > 0)
    )
);

COMMENT ON TABLE instagram_comment_funnels IS
  'Comment → DM funnel definitions. Fires only when instagram_config.comment_funnels_enabled AND is_active are both true.';
COMMENT ON COLUMN instagram_comment_funnels.ig_media_id IS
  'NULL = every post. Intentionally not an FK to instagram_media: that table is a resyncable cache, and losing a cache row must not delete a funnel.';
COMMENT ON COLUMN instagram_comment_funnels.keywords IS
  'Empty = match any comment. Case-insensitive substring match, same rule as automations KeywordMatchTriggerConfig.';
COMMENT ON COLUMN instagram_comment_funnels.reward_buttons IS
  'Up to 3 {label,url} link-out buttons, sent as a web_url button template. Not postbacks — tapping one ends the funnel rather than advancing it.';
COMMENT ON COLUMN instagram_comment_funnels.public_reply_text IS
  'Optional public reply on the comment itself ("check your DMs"). NULL sends nothing publicly.';

-- The ingest path's lookup: active funnels for this account, then
-- filtered in code by media id and keywords. Partial, because inactive
-- funnels are never read on the hot path.
CREATE INDEX IF NOT EXISTS idx_ig_comment_funnels_active
  ON instagram_comment_funnels (account_id, ig_media_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_ig_comment_funnels_account_updated
  ON instagram_comment_funnels (account_id, updated_at DESC);

ALTER TABLE instagram_comment_funnels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ig_comment_funnels_select ON instagram_comment_funnels;
CREATE POLICY ig_comment_funnels_select ON instagram_comment_funnels FOR SELECT
  USING (is_account_member(account_id));

-- Agent-level write, matching forms/automations/flows: building a
-- funnel is ordinary marketing work, not an admin act.
DROP POLICY IF EXISTS ig_comment_funnels_write ON instagram_comment_funnels;
CREATE POLICY ig_comment_funnels_write ON instagram_comment_funnels FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));


-- ============================================================
-- 2) instagram_comment_funnel_runs — one person's journey
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_comment_funnel_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  funnel_id       uuid NOT NULL REFERENCES instagram_comment_funnels(id) ON DELETE CASCADE,

  -- The comment that started it. Kept even after the DM thread exists,
  -- because it is the only link back to what they actually asked for.
  ig_comment_id   TEXT NOT NULL,
  from_igsid      TEXT NOT NULL,

  -- Both NULL until they tap the opt-in: the contact and conversation
  -- are created by the messaging webhook when the tap arrives, not by
  -- the comment.
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,

  --   awaiting_optin  private reply sent, waiting for the tap
  --   awaiting_follow follow gate asked, waiting for the tap
  --   delivered       reward sent — terminal
  --   failed          a send failed — terminal, see last_error
  state           TEXT NOT NULL DEFAULT 'awaiting_optin'
                    CHECK (state IN ('awaiting_optin', 'awaiting_follow', 'delivered', 'failed')),

  -- What is_user_follow_business said at the moment we asked. NULL
  -- means we never got an answer (lookup failed, or the gate was off).
  -- Recorded rather than acted on twice: under a soft gate this is
  -- reporting, not control flow.
  was_following   BOOLEAN,

  delivered_at    TIMESTAMPTZ,
  last_error      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One run per person per funnel, forever. Someone who comments five
  -- times on the same post gets one DM, not five — and Meta's one
  -- private reply per comment rule would not have saved us here,
  -- because five comments are five different comment ids.
  UNIQUE (funnel_id, from_igsid)
);

COMMENT ON TABLE instagram_comment_funnel_runs IS
  'One commenter''s journey through one funnel. UNIQUE(funnel_id, from_igsid) is the anti-spam guarantee: a repeat commenter is never DMed twice by the same funnel.';
COMMENT ON COLUMN instagram_comment_funnel_runs.state IS
  'awaiting_optin → awaiting_follow → delivered. No loop: the gate is soft, so a tap on "I followed you" delivers without re-checking.';
COMMENT ON COLUMN instagram_comment_funnel_runs.was_following IS
  'is_user_follow_business at gate time. NULL = never determined (lookup failed or gate disabled). Reporting only — a soft gate delivers either way.';

-- The postback path resolves a run by id straight out of the button
-- payload, so no index is needed for the hot path. This one serves the
-- funnel stats panel.
CREATE INDEX IF NOT EXISTS idx_ig_funnel_runs_funnel_state
  ON instagram_comment_funnel_runs (funnel_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ig_funnel_runs_account_created
  ON instagram_comment_funnel_runs (account_id, created_at DESC);

ALTER TABLE instagram_comment_funnel_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ig_funnel_runs_select ON instagram_comment_funnel_runs;
CREATE POLICY ig_funnel_runs_select ON instagram_comment_funnel_runs FOR SELECT
  USING (is_account_member(account_id));

-- No client INSERT or UPDATE policy. Every row is written by the
-- webhook path on the server; a browser-writable runs table would let
-- anyone forge a "delivered" and skip the gate.
DROP POLICY IF EXISTS ig_funnel_runs_delete ON instagram_comment_funnel_runs;
CREATE POLICY ig_funnel_runs_delete ON instagram_comment_funnel_runs FOR DELETE
  USING (is_account_member(account_id, 'admin'));
