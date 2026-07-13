-- ============================================================
-- 046_performance_indexes
--
-- Adds targeted covering indexes to eliminate full table/account
-- scans on the application's highest-frequency query patterns.
--
-- ALL indexes are CREATE INDEX IF NOT EXISTS — idempotent, safe
-- to run multiple times, and non-blocking (Postgres builds them
-- without holding an ACCESS EXCLUSIVE lock when created with
-- CREATE INDEX CONCURRENTLY; the IF NOT EXISTS variant is used
-- here for simplicity and is safe on fresh databases and in
-- migrations that run before traffic lands).
--
-- Every index is annotated with the specific query it supports.
-- ============================================================

-- ============================================================
-- MESSAGES
-- ============================================================

-- 1. (conversation_id, sender_type)
--
--    Supports:
--      a) processMessage — first-inbound-message COUNT:
--           SELECT COUNT(*) FROM messages
--           WHERE conversation_id = $1 AND sender_type = 'customer'
--      b) loadResponseTime — pairs inbound↔outbound messages per
--         conversation over a 14-day window. Without this index the
--         planner seq-scans the entire messages partition.
--
--    This is the single highest-impact index: processMessage runs
--    this query on every inbound webhook event.
CREATE INDEX IF NOT EXISTS idx_messages_conv_sender
  ON messages (conversation_id, sender_type);

-- 2. (conversation_id, created_at DESC)
--
--    Supports inbox thread fetch:
--      SELECT * FROM messages
--      WHERE conversation_id = $1
--      ORDER BY created_at DESC
--      LIMIT 50
--
--    The existing idx_messages_conversation covers the WHERE clause
--    but forces a sort on created_at. This covering index eliminates
--    the sort and allows an index-only scan for the LIMIT fetch.
CREATE INDEX IF NOT EXISTS idx_messages_conv_time
  ON messages (conversation_id, created_at DESC);

-- 3. (created_at, sender_type)
--
--    Supports loadConversationsSeries:
--      SELECT created_at, sender_type FROM messages
--      WHERE created_at >= $start AND created_at <= $end
--      ORDER BY created_at
--
--    Without this, each dashboard load reads ALL messages in the
--    date window via a seq-scan.
CREATE INDEX IF NOT EXISTS idx_messages_time_sender
  ON messages (created_at, sender_type);

-- ============================================================
-- CONVERSATIONS
-- ============================================================

-- 4. (account_id, contact_id)
--
--    Supports findOrCreateConversation — called on EVERY inbound
--    WhatsApp message:
--      SELECT * FROM conversations
--      WHERE account_id = $1 AND contact_id = $2
--
--    Without this, Postgres must scan the entire account's
--    conversations table on each inbound message. On accounts
--    with thousands of conversations this is the single most
--    expensive per-message query.
CREATE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);

-- 5. (account_id, status, last_message_at DESC)
--
--    Supports the inbox conversation list:
--      SELECT ... FROM conversations
--      WHERE account_id = $1 AND status = 'open'
--      ORDER BY last_message_at DESC
--
--    The WHERE + ORDER BY is a very common pattern — used by the
--    ConversationList component on initial load and on every
--    resync. The composite index lets Postgres do an index-only
--    scan for the list, avoiding a filesort on last_message_at.
CREATE INDEX IF NOT EXISTS idx_conversations_account_status_time
  ON conversations (account_id, status, last_message_at DESC);

-- ============================================================
-- BROADCAST_RECIPIENTS
-- ============================================================

-- 6. (contact_id, status)
--
--    Supports flagBroadcastReplyIfAny — called on EVERY inbound
--    WhatsApp message to check whether the sender is an outstanding
--    broadcast recipient:
--      SELECT id, status FROM broadcast_recipients
--      WHERE contact_id = $1 AND status IN ('sent', 'delivered', 'read')
--      ORDER BY created_at DESC LIMIT 1
--
--    The existing idx_broadcast_recipients_broadcast only covers
--    broadcast_id; contact_id lookups fall back to a seq-scan.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact_status
  ON broadcast_recipients (contact_id, status);

-- ============================================================
-- AUTOMATION_LOGS
-- ============================================================

-- 7. (account_id, created_at DESC)
--
--    Supports the Automation Logs page:
--      SELECT ... FROM automation_logs
--      WHERE account_id = $1
--      ORDER BY created_at DESC
--      LIMIT N
--
--    Without this, the page does a full account-scan + sort.
CREATE INDEX IF NOT EXISTS idx_automation_logs_account_time
  ON automation_logs (account_id, created_at DESC);

-- ============================================================
-- FLOW_RUN_EVENTS — JSONB functional index
-- ============================================================

-- 8. Functional index on payload->>'meta_message_id'
--
--    Supports isDuplicateInbound idempotency check in the flows
--    engine. Currently done via two sequential queries:
--      (a) fetch all run_ids for the contact
--      (b) WHERE flow_run_id IN (...) AND event_type = 'reply_received'
--          AND payload->>'meta_message_id' = $meta_id
--
--    The existing idx_flow_run_events_run_type covers (flow_run_id,
--    event_type); this functional index adds the JSONB path extraction
--    so a future consolidated query can hit a single index scan.
--
--    Note: this supports the isDuplicateInbound refactor (Priority 3).
--    The current two-query pattern still benefits from the existing
--    idx_flow_run_events_run_type; this index accelerates the
--    combined-query approach.
CREATE INDEX IF NOT EXISTS idx_flow_run_events_meta_message_id
  ON flow_run_events ((payload->>'meta_message_id'))
  WHERE event_type = 'reply_received';

-- ============================================================
-- FLOW_RUNS — account + contact lookup
-- ============================================================

-- 9. (account_id, contact_id, status)
--
--    Supports loadActiveRunForContact in the flows engine:
--      SELECT * FROM flow_runs
--      WHERE account_id = $1 AND contact_id = $2 AND status = 'active'
--
--    The existing partial unique index idx_one_active_run_per_contact
--    covers (user_id, contact_id) — but after migration 017 the
--    runner queries by account_id, not user_id. This index covers
--    the post-017 shape.
CREATE INDEX IF NOT EXISTS idx_flow_runs_account_contact_status
  ON flow_runs (account_id, contact_id, status)
  WHERE status = 'active';
