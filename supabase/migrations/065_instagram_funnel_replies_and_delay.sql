-- ============================================================
-- 065_instagram_funnel_replies_and_delay.sql — rotating public
-- replies, and a delay before the funnel answers.
--
-- WHY MORE THAN ONE PUBLIC REPLY
--   064 gave a funnel a single `public_reply_text`, posted under every
--   comment it answers. On a post that does what these funnels are
--   built for — hundreds of comments in an hour — that produces
--   hundreds of byte-identical replies from the same account in the
--   same thread, which is the exact shape of Instagram's own
--   comment-spam signal. Meta will start dropping them, and nothing in
--   the API says it happened.
--
--   So the column becomes a list, and the sender rotates through it.
--   Three variants of "check your DMs" read as a human answering, not
--   as a robot; the same three also read better to the humans who are
--   scrolling the thread.
--
--   Migrated, not replaced: the existing scalar is folded into the
--   array before it is dropped, so no funnel loses its wording.
--
-- WHY A DELAY
--   Answering a comment inside 300ms is the tell. `reply_delay_seconds`
--   parks the opening DM on a delayed queue job instead. It is capped
--   at an hour — beyond that, Meta's 7-day private-reply window and the
--   commenter's memory both make the DM a stranger's message rather
--   than an answer.
--
--   0 (the default, and what every existing funnel keeps) means send
--   inline, on the webhook path, exactly as before.
-- ============================================================


-- ============================================================
-- 1) public_reply_text -> public_reply_texts[]
-- ============================================================

ALTER TABLE instagram_comment_funnels
  ADD COLUMN IF NOT EXISTS public_reply_texts TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN instagram_comment_funnels.public_reply_texts IS
  'Public comment replies ("Check your DMs 📩"), rotated per match so a post with hundreds of comments does not carry hundreds of identical replies from the business. Empty means the funnel answers privately only.';

-- Fold the scalar in, then drop it.
--
-- Both inside a DO block that checks the old column still exists: a
-- plain UPDATE referencing a dropped column is a parse error, not a
-- no-op, so the second run of this migration would fail on a schema
-- that is already correct. Guarded on cardinality too, so re-running
-- before the drop cannot resurrect old wording over a newer array.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'instagram_comment_funnels'
       AND column_name = 'public_reply_text'
  ) THEN
    UPDATE instagram_comment_funnels
       SET public_reply_texts = ARRAY[public_reply_text]
     WHERE public_reply_text IS NOT NULL
       AND btrim(public_reply_text) <> ''
       AND cardinality(public_reply_texts) = 0;

    ALTER TABLE instagram_comment_funnels DROP COLUMN public_reply_text;
  END IF;
END $$;

-- 10 is a UI cap as much as a storage one: past ten variants nobody can
-- keep track of what their post is publicly saying, and the rotation
-- stops being reviewable. Empty entries are rejected because a blank in
-- the rotation is a silently skipped turn.
--
-- Deliberately NOT unnest/EXISTS — Postgres forbids a subquery in a
-- CHECK, so per-element trimming and the 1000-char-each rule live in the
-- controller's normaliseReplyVariants instead. What is enforceable here
-- is the count, exact-empty strings, and a total-size bound that makes
-- the per-element cap unreachable in aggregate.
ALTER TABLE instagram_comment_funnels
  DROP CONSTRAINT IF EXISTS instagram_comment_funnels_public_replies_chk;

ALTER TABLE instagram_comment_funnels
  ADD CONSTRAINT instagram_comment_funnels_public_replies_chk
  CHECK (
    cardinality(public_reply_texts) <= 10
    AND NOT ('' = ANY (public_reply_texts))
    AND char_length(array_to_string(public_reply_texts, '')) <= 10000
  );


-- ============================================================
-- 2) reply_delay_seconds
-- ============================================================

ALTER TABLE instagram_comment_funnels
  ADD COLUMN IF NOT EXISTS reply_delay_seconds INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN instagram_comment_funnels.reply_delay_seconds IS
  'Seconds to wait before the opening DM goes out. 0 sends inline on the webhook path; anything higher parks the send on a delayed BullMQ job. Capped at 3600 — Meta only allows a private reply within 7 days of the comment, and an answer that arrives hours later reads as a cold DM.';

ALTER TABLE instagram_comment_funnels
  DROP CONSTRAINT IF EXISTS instagram_comment_funnels_delay_chk;

ALTER TABLE instagram_comment_funnels
  ADD CONSTRAINT instagram_comment_funnels_delay_chk
  CHECK (reply_delay_seconds BETWEEN 0 AND 3600);


-- ============================================================
-- 3) Post-scoped lookup for the Posts grid
-- ============================================================

-- The Posts page now asks "is this post automated?" for a screenful of
-- posts at a time, which means reading every funnel for the account and
-- matching on ig_media_id. 064's index is partial on is_active, so a
-- paused funnel — the one the grid has to render as "Paused" rather
-- than as nothing at all — was not covered by any index.
CREATE INDEX IF NOT EXISTS idx_ig_comment_funnels_account_media
  ON instagram_comment_funnels (account_id, ig_media_id);
