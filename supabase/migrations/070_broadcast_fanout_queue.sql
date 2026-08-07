-- ============================================================
-- 070_broadcast_fanout_queue.sql — support the fan-out delivery queue.
--
-- WHY
--   Broadcast delivery used to be one BullMQ job that looped over every
--   recipient in-process (and, on the public API, no job at all — a
--   fire-and-forget `void deliverBroadcast()` that a restart threw
--   away). It is now one orchestrator job that fans out one job per
--   recipient. Two consequences need schema:
--
--   1. 'queued' status. With fan-out, a broadcast is accepted long
--      before the first message leaves — the orchestrator has to be
--      picked up, and the send queue is rate limited. "Accepted, not
--      started" and "actively delivering" are different answers to
--      "why has nobody received it yet?", so they get different
--      statuses instead of both being 'sending'.
--
--   2. broadcast_recipients.template_params. The public API accepts
--      per-recipient template parameters (`{ to, params }`). Those used
--      to live only in the in-memory plan the fire-and-forget delivery
--      loop closed over. A per-recipient job must be able to rebuild
--      the send from the database alone — otherwise a retry, or a
--      worker restart, produces a message with the wrong variables (or
--      none). Deliberately NOT put in the job payload: Redis is not
--      the system of record, and a flushed queue must be resumable.
--
--      NULL means "resolve from broadcasts.template_variables", which
--      is how every dashboard broadcast works. Only the API path
--      writes it.
--
-- The status flow is now:
--   draft → queued → sending → sent
--                            ↘ failed
--   ('scheduled' is unchanged and still feeds campaign_schedules.)
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allow status = 'queued'
-- ------------------------------------------------------------

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'queued'::text,
    'scheduled'::text,
    'sending'::text,
    'sent'::text,
    'failed'::text
  ]));

-- ------------------------------------------------------------
-- 2. Per-recipient template parameters
-- ------------------------------------------------------------

ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS template_params JSONB;

COMMENT ON COLUMN public.broadcast_recipients.template_params IS
  'Per-recipient template parameters supplied by the public API ({ to, params }). NULL = resolve from broadcasts.template_variables instead. Persisted rather than kept in the BullMQ payload so a retried or restarted send rebuilds identically.';

-- ------------------------------------------------------------
-- 3. Index the orchestrator''s fan-out read
--
-- The orchestrator pages through `WHERE broadcast_id = $1 AND status =
-- 'pending' ORDER BY created_at` on every attempt. There is already an
-- index on (broadcast_id, status); adding created_at lets the paging
-- read be a plain index scan on a 50k-recipient broadcast instead of a
-- sort of the whole partition.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_fanout
  ON public.broadcast_recipients (broadcast_id, status, created_at);
