-- ============================================================
-- 052_automations_multi_channel.sql — automations stop being a
-- WhatsApp feature.
--
-- Since migration 050 a conversation carries a `channel`, and
-- ChannelSenderService routes a send step by that column — so one
-- automation already answers a WhatsApp message and an Instagram DM
-- without being authored twice. What was missing is the ability to say
-- "this one is Instagram only", and any record of which channel a run
-- actually fired on.
--
-- WHY AN ARRAY AND NOT A SINGLE `channel` COLUMN
--   The common case is "runs everywhere", and the second most common is
--   "runs on exactly one". A single nullable column expresses both
--   (NULL = all) but cannot express "WhatsApp and Instagram but not the
--   next channel we add" — which becomes a real request the moment
--   there is a third channel. An array covers all three shapes.
--
-- WHY EMPTY MEANS ALL, RATHER THAN NULL
--   `'{}'` and `NULL` would both have to mean "unscoped", and code that
--   forgot one of them would silently scope an automation to nothing.
--   One representation, NOT NULL, default `'{}'`: an empty array is
--   "no restriction". Every pre-existing automation therefore keeps
--   running on every channel, which is exactly its behaviour today.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1) automations.channels — which platforms a rule applies to
-- ============================================================

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS channels TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN automations.channels IS
  'Channels this automation runs on. EMPTY = all channels (the default, and what every automation predating this column does). Non-empty restricts it: dispatch skips the automation when the triggering conversation''s channel is not listed.';

-- Guard the contents. Without this a typo ('instgram') produces an
-- automation that silently never fires — the worst possible failure for
-- a rule, since it looks active in the UI.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_channels_chk;
ALTER TABLE automations
  ADD CONSTRAINT automations_channels_chk
  CHECK (channels <@ ARRAY['whatsapp', 'instagram']::TEXT[]);

-- The dispatch hot path is "active automations for this account with
-- this trigger", already covered by idx_automations_account_active_trigger.
-- Channel filtering happens in memory on that small result set, so no
-- GIN index here — it would cost writes to serve a filter that runs
-- over a handful of rows.


-- ============================================================
-- 2) automation_logs.channel — which platform a run fired on
-- ============================================================

ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS channel TEXT;

COMMENT ON COLUMN automation_logs.channel IS
  'Channel of the conversation that triggered this run. NULL for runs with no channel context (time_based schedules, the manual engine entrypoint) and for rows predating this column — NULL means "unknown", not "whatsapp", so backfilling a guess would be a lie.';

-- "Show me this automation's Instagram runs" — the debugging question
-- this column exists to answer.
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation_channel
  ON automation_logs (automation_id, channel, created_at DESC)
  WHERE channel IS NOT NULL;
