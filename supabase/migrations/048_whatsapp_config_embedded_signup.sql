-- ============================================================
-- whatsapp_config: support Embedded Signup connections
--
-- Adds the columns needed for the OAuth-based "Connect with Facebook"
-- flow alongside the existing manual-paste flow:
--
--   connection_method  — how this row's credentials were obtained.
--                        Manual rows keep working exactly as before;
--                        this is purely informational (and drives the
--                        token-expiry banner below).
--   business_id        — the Meta Business that owns the WABA. Not
--                        used by any Cloud API call today; stored for
--                        support/debugging and potential future use
--                        (e.g. Business-level webhook subscriptions).
--   coexistence        — true when the merchant kept their number on
--                        the WhatsApp Business App instead of fully
--                        migrating to the Cloud API ("FINISH_ONLY_WABA"
--                        in Meta's Embedded Signup event). We never
--                        call /register for these numbers — see
--                        src/lib/whatsapp/connect-account.ts.
--   token_expires_at   — set for embedded_signup rows, whose access
--                        token is a long-lived USER token (~60 days)
--                        rather than a non-expiring System User token.
--                        NULL for manual rows, where the operator is
--                        responsible for using a permanent token.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_method TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS business_id TEXT,
  ADD COLUMN IF NOT EXISTS coexistence BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_connection_method_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_connection_method_check
      CHECK (connection_method IN ('manual', 'embedded_signup'));
  END IF;
END $$;

-- Supports the expiry-warning query the GET /api/whatsapp/config health
-- check will eventually run across accounts (a future "renew before it
-- expires" cron); cheap to maintain since it only indexes non-null rows.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_token_expires_at
  ON whatsapp_config (token_expires_at)
  WHERE token_expires_at IS NOT NULL;
