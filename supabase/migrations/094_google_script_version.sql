-- ============================================================
-- 094_google_script_version.sql
--   Record which version of the bridge a workspace actually deployed.
--
-- WHY THIS COLUMN EXISTS
--
--   The bridge has NO UPDATE CHANNEL: the script runs in the customer's
--   own Google account, so adding an action means every customer must
--   re-paste before that action works. Without this, a workspace only
--   discovers its script is behind when an automation fails at 3am with
--   `unknown action: update_event` — a message that reads like our bug.
--
--   The script echoes the BRIDGE_VERSION it was generated with in every
--   reply. Storing the last one seen lets Integrations say "your script
--   is out of date" while nothing is broken yet, which is the only
--   honest moment to say it.
--
-- NULLABLE, AND NULL MEANS "NOT SEEN YET", NOT "OLD".
--   A workspace that has never made a successful call has no reported
--   version, and a v1 script predates the field entirely — it replies
--   without one. Treating either as stale would nag people whose setup
--   is fine, so the UI only claims staleness on a version it has
--   actually been told.
-- ============================================================

ALTER TABLE public.google_script_connections
  ADD COLUMN IF NOT EXISTS script_version integer;

COMMENT ON COLUMN public.google_script_connections.script_version IS
  'BRIDGE_VERSION last reported by the deployed script. NULL = never reported (never called, or a v1 script that predates the field). Compared against BRIDGE_VERSION to offer an update.';
