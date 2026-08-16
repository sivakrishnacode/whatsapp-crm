-- ============================================================
-- 090: get_response_time_buckets always returned zero rows
-- ============================================================
--
-- "Average First Response Time" on the dashboard has been empty since
-- migration 047 shipped. Not "no data yet" — the query could not match
-- a single row, on any account, ever.
--
-- ⚠️ THE BUG: A WHERE CLAUSE RAN BEFORE THE WINDOW FUNCTION BESIDE IT.
--
--   paired AS (
--     SELECT wm.created_at AS customer_at,
--            LEAD(wm.created_at)  OVER (...) AS next_at,
--            LEAD(wm.sender_type) OVER (...) AS next_sender
--     FROM window_messages wm
--     WHERE wm.sender_type = 'customer'      -- <— here
--   )
--   ... SELECT ... FROM paired WHERE next_sender IN ('agent','bot')
--
-- Postgres evaluates FROM → WHERE → GROUP/HAVING → *window functions* →
-- SELECT. So that WHERE had already thrown every agent and bot message
-- away by the time LEAD() ran: the window frame contained customer rows
-- and nothing else, `next_sender` was therefore always 'customer' (or
-- NULL on a conversation's last message), and the downstream
-- `next_sender IN ('agent','bot')` could never be true.
--
-- Verified on production before the fix: 345 messages in the window,
-- LEAD saw exactly two distinct values — 'customer' and NULL — and the
-- function returned 0 rows. The same window with the filter moved
-- yields 91 response pairs.
--
-- It reads as correct, which is why it survived two migrations: the two
-- filters look like they compose, and the empty chart had a plausible
-- cover story ("no replies recorded yet") that is indistinguishable
-- from a quiet account.
--
-- ⚠️ THE FIX IS TO FILTER *AFTER* THE WINDOW, which is what
-- `get_channel_kpis` (089) already does in its `ordered`/`resp` pair —
-- its `ordered` CTE carries no WHERE at all, and that is precisely why
-- the per-channel "avg reply" figures have always worked while this one
-- never did. 089's comment claiming the two are "the same shape so the
-- two agree" was the aspiration, not the state; after this migration it
-- is true.
--
-- Semantics are otherwise UNCHANGED, deliberately: a sample is still a
-- customer message immediately followed by an agent/bot message, so
-- this function and get_channel_kpis report the same number. (Note that
-- makes it "reply latency measured from the LAST message of an inbound
-- burst" — a customer who sends three messages and is answered a minute
-- after the third scores 1 minute, not the time since their first.
-- Changing that is a metric redefinition and belongs in its own change,
-- touching both functions together.)
--
-- Idempotent: CREATE OR REPLACE, signature unchanged, grants restated.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_response_time_buckets(
  p_account_id UUID,
  p_days       INT DEFAULT 14
)
RETURNS TABLE (
  dow          INT,      -- 0 = Mon … 6 = Sun
  avg_minutes  NUMERIC,
  sample_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  window_messages AS (
    SELECT
      m.conversation_id,
      m.sender_type,
      m.created_at,
      ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS rn
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (SELECT ok FROM guard)
      AND c.account_id = p_account_id
      AND m.created_at >= NOW() - (p_days || ' days')::INTERVAL
  ),
  -- ⚠️ NO WHERE HERE. The window must see every message in the
  -- conversation, or LEAD() cannot report an agent reply following a
  -- customer message — which is the entire question being asked.
  -- `sender_type` is carried through so the next CTE can filter on it.
  paired AS (
    SELECT
      wm.conversation_id,
      wm.sender_type,
      wm.created_at AS msg_at,
      LEAD(wm.created_at)  OVER (PARTITION BY wm.conversation_id ORDER BY wm.rn) AS next_at,
      LEAD(wm.sender_type) OVER (PARTITION BY wm.conversation_id ORDER BY wm.rn) AS next_sender
    FROM window_messages wm
  ),
  samples AS (
    SELECT
      msg_at AS customer_at,
      EXTRACT(EPOCH FROM (next_at - msg_at)) / 60.0 AS response_minutes
    FROM paired
    WHERE sender_type = 'customer'          -- moved here, after the window
      AND next_sender IN ('agent', 'bot')
      AND next_at > msg_at
  )
  SELECT
    iso_dow_mon_first(customer_at) AS dow,
    AVG(response_minutes)          AS avg_minutes,
    COUNT(*)                       AS sample_count
  FROM samples
  GROUP BY iso_dow_mon_first(customer_at)
  ORDER BY dow;
$$;

COMMENT ON FUNCTION public.get_response_time_buckets(UUID, INT) IS
  'Average first-response minutes by weekday (0=Mon). A sample is a customer message immediately followed by an agent/bot message in the same conversation. The customer filter MUST stay outside the windowed SELECT — see migration 090.';

REVOKE ALL ON FUNCTION public.get_response_time_buckets(UUID, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_response_time_buckets(UUID, INT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_response_time_buckets(UUID, INT) TO service_role;
