-- ============================================================
-- whatsapp_config: messaging tier + quality rating visibility
--
-- Surfaces Meta's per-phone-number messaging limit tier and quality
-- rating in the CRM so operators know their ceiling before running a
-- broadcast. Populated by a 6-hourly BullMQ sweep
-- (messaging-limits.processor.ts) and by inbound webhook pushes.
--
--   messaging_limit_tier — raw tier string from Meta.
--   quality_rating       — raw rating from Meta.
--   tier_daily_limit     — denormalised int derived from the tier map
--                          in messaging-limits.service.ts.
--   limits_synced_at     — last SUCCESSFUL sync. Deliberately left
--                          untouched on failure so staleness surfaces
--                          in the UI rather than being papered over.
--
-- NOTE ON THE ABSENCE OF CHECK CONSTRAINTS
-- messaging_limit_tier and quality_rating are value sets Meta owns and
-- can extend without notice. A CHECK constraint would convert "Meta
-- shipped a new tier" into a constraint violation that fails the sync
-- write — losing the quality rating in the same statement. Both columns
-- store the raw string; mapping and fallback happen in code, where an
-- unrecognised value degrades to "Unknown tier" and logs a warning.
--
-- Concretely: Meta's own Postman collection documents quality_rating as
-- GREEN | YELLOW | RED | NA. An earlier draft of this migration
-- constrained it to (..., 'UNKNOWN'), which would have rejected the NA
-- that Meta actually sends for every not-yet-rated number.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS messaging_limit_tier TEXT,
  ADD COLUMN IF NOT EXISTS quality_rating       TEXT,
  ADD COLUMN IF NOT EXISTS tier_daily_limit     INTEGER,
  ADD COLUMN IF NOT EXISTS limits_synced_at     TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_config.messaging_limit_tier IS
  'Raw messaging_limit_tier from Meta (TIER_250 / TIER_1K / TIER_10K / TIER_100K / UNLIMITED). Unmapped values render as "Unknown tier".';
COMMENT ON COLUMN whatsapp_config.quality_rating IS
  'Raw quality_rating from Meta: GREEN | YELLOW | RED | NA.';
COMMENT ON COLUMN whatsapp_config.tier_daily_limit IS
  'Denormalised daily limit from the tier map. NULL means unlimited OR unknown tier OR never synced — disambiguate via messaging_limit_tier, never by testing this column alone.';
COMMENT ON COLUMN whatsapp_config.limits_synced_at IS
  'Last successful Meta sync. NULL = never synced. Left unchanged on sync failure so the UI staleness indicator stays honest.';

-- Supports the rolling 24-hour usage scan in
-- MessagingLimitsService.getLiveUsage. broadcast_recipients has no
-- account_id column, so account scoping joins through
-- broadcasts.account_id (already covered by idx_broadcasts_account);
-- this index covers the sent_at window predicate on a table that grows
-- with every recipient of every broadcast, forever.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sent_at
  ON broadcast_recipients (sent_at)
  WHERE sent_at IS NOT NULL;
