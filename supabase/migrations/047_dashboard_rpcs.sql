-- ============================================================
-- 047_dashboard_rpcs
--
-- Server-side aggregation RPCs that replace large client-side
-- data fetches in src/lib/dashboard/queries.ts.
--
-- Two RPCs are added:
--
--   1. get_dashboard_metrics(p_account_id, p_since_ts, p_range_end)
--      Replaces 8 parallel Supabase queries in loadMetrics() with a
--      single round-trip. Returns one row of metric card values.
--
--   2. get_response_time_buckets(p_account_id, p_days)
--      Replaces the full 14-day messages fetch + JS aggregation in
--      loadResponseTime() with a server-side GROUP BY aggregation.
--      Returns 7 rows (Mon–Sun) with avg response minutes.
--
--   3. get_activity_feed(p_account_id, p_limit)
--      Replaces 5 parallel queries + JS merge-sort in loadActivity()
--      with a single UNION ALL query. Returns the N most recent
--      activity items across all sources.
--
-- All RPCs are SECURITY DEFINER with an explicit search_path so they
-- run with the function owner's privileges (no caller RLS). They are
-- restricted to service_role by revoking PUBLIC execute, then granting
-- back only to service_role. Client-side code calls them via the
-- anon/user key — which means they need to be accessible from the
-- client; we GRANT to authenticated instead.
--
-- Idempotent: uses CREATE OR REPLACE FUNCTION.
-- ============================================================

-- ============================================================
-- 1. get_dashboard_metrics
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_dashboard_metrics(
  p_account_id UUID,
  p_since_ts   TIMESTAMPTZ,
  p_range_end  TIMESTAMPTZ
)
RETURNS TABLE (
  active_conversations_total    BIGINT,
  new_convs_in_range            BIGINT,
  new_contacts_in_range         BIGINT,
  open_deals_count              BIGINT,
  open_deals_value              NUMERIC,
  messages_sent_in_range        BIGINT,
  -- yesterday comparisons (using same window offset by 1 day)
  new_convs_yesterday           BIGINT,
  new_contacts_yesterday        BIGINT,
  messages_sent_yesterday       BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
    range_dur AS (
      -- Duration of the requested window; replicated one day earlier
      -- to build the "yesterday" comparison window.
      SELECT
        p_since_ts                                        AS win_start,
        p_range_end                                       AS win_end,
        p_since_ts  - (p_range_end - p_since_ts)         AS prev_start,
        p_since_ts                                        AS prev_end
    ),
    cur_convs AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')                                       AS total_open,
        COUNT(*) FILTER (WHERE status = 'open'
                           AND created_at >= (SELECT win_start FROM range_dur)
                           AND created_at <= (SELECT win_end   FROM range_dur))       AS new_in_range
      FROM conversations
      WHERE account_id = p_account_id
    ),
    prev_convs AS (
      SELECT COUNT(*) AS new_yesterday
      FROM conversations
      WHERE account_id = p_account_id
        AND status = 'open'
        AND created_at >= (SELECT prev_start FROM range_dur)
        AND created_at <  (SELECT prev_end   FROM range_dur)
    ),
    cur_contacts AS (
      SELECT COUNT(*) AS new_in_range
      FROM contacts
      WHERE account_id = p_account_id
        AND created_at >= (SELECT win_start FROM range_dur)
        AND created_at <= (SELECT win_end   FROM range_dur)
    ),
    prev_contacts AS (
      SELECT COUNT(*) AS new_yesterday
      FROM contacts
      WHERE account_id = p_account_id
        AND created_at >= (SELECT prev_start FROM range_dur)
        AND created_at <  (SELECT prev_end   FROM range_dur)
    ),
    open_deals AS (
      SELECT COUNT(*) AS cnt, COALESCE(SUM(value), 0) AS total_value
      FROM deals
      WHERE account_id = p_account_id
        AND status = 'open'
    ),
    cur_msgs AS (
      -- Messages are joined through conversations; messages has no account_id.
      SELECT COUNT(*) AS cnt
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type = 'agent'
        AND m.created_at >= (SELECT win_start FROM range_dur)
        AND m.created_at <= (SELECT win_end   FROM range_dur)
    ),
    prev_msgs AS (
      SELECT COUNT(*) AS cnt
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type = 'agent'
        AND m.created_at >= (SELECT prev_start FROM range_dur)
        AND m.created_at <  (SELECT prev_end   FROM range_dur)
    )
  SELECT
    (SELECT total_open      FROM cur_convs)      AS active_conversations_total,
    (SELECT new_in_range    FROM cur_convs)      AS new_convs_in_range,
    (SELECT new_in_range    FROM cur_contacts)   AS new_contacts_in_range,
    (SELECT cnt             FROM open_deals)     AS open_deals_count,
    (SELECT total_value     FROM open_deals)     AS open_deals_value,
    (SELECT cnt             FROM cur_msgs)       AS messages_sent_in_range,
    (SELECT new_yesterday   FROM prev_convs)     AS new_convs_yesterday,
    (SELECT new_yesterday   FROM prev_contacts)  AS new_contacts_yesterday,
    (SELECT cnt             FROM prev_msgs)      AS messages_sent_yesterday;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- ============================================================
-- 2. get_response_time_buckets
-- ============================================================

-- Helper: extract Monday-based ISO day-of-week (0=Mon … 6=Sun)
-- from a TIMESTAMPTZ. EXTRACT(DOW …) gives 0=Sun … 6=Sat; we shift.
CREATE OR REPLACE FUNCTION public.iso_dow_mon_first(ts TIMESTAMPTZ)
RETURNS INT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT (EXTRACT(DOW FROM ts AT TIME ZONE 'UTC')::INT + 6) % 7;
$$;

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
  -- For each conversation, find inbound→outbound response pairs:
  -- the first customer message, then the next agent/bot message.
  -- We do this efficiently with window functions rather than a
  -- self-join.
  WITH window_messages AS (
    SELECT
      m.conversation_id,
      m.sender_type,
      m.created_at,
      -- Row number within the conversation, ordered by time
      ROW_NUMBER() OVER (
        PARTITION BY m.conversation_id
        ORDER BY m.created_at
      ) AS rn
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = p_account_id
      AND m.created_at >= NOW() - (p_days || ' days')::INTERVAL
  ),
  -- Lead to find the next message after a customer one
  paired AS (
    SELECT
      wm.conversation_id,
      wm.created_at  AS customer_at,
      LEAD(wm.created_at)  OVER (
        PARTITION BY wm.conversation_id ORDER BY wm.rn
      ) AS next_at,
      LEAD(wm.sender_type) OVER (
        PARTITION BY wm.conversation_id ORDER BY wm.rn
      ) AS next_sender
    FROM window_messages wm
    WHERE wm.sender_type = 'customer'
  ),
  -- Keep only pairs where the next message is from an agent/bot
  samples AS (
    SELECT
      customer_at,
      EXTRACT(EPOCH FROM (next_at - customer_at)) / 60.0 AS response_minutes
    FROM paired
    WHERE next_sender IN ('agent', 'bot')
      AND next_at > customer_at
  )
  SELECT
    iso_dow_mon_first(customer_at)   AS dow,
    AVG(response_minutes)            AS avg_minutes,
    COUNT(*)                         AS sample_count
  FROM samples
  GROUP BY iso_dow_mon_first(customer_at)
  ORDER BY dow;
$$;

REVOKE ALL ON FUNCTION public.get_response_time_buckets(UUID, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_response_time_buckets(UUID, INT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_response_time_buckets(UUID, INT) TO service_role;

-- ============================================================
-- 3. get_activity_feed
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_activity_feed(
  p_account_id UUID,
  p_limit      INT DEFAULT 20
)
RETURNS TABLE (
  id           TEXT,
  kind         TEXT,
  text         TEXT,
  at           TIMESTAMPTZ,
  href         TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  (
    -- Recent customer messages
    SELECT
      'msg-' || m.id::TEXT                              AS id,
      'message'                                         AS kind,
      'New message from ' || COALESCE(ct.name, ct.phone, 'Unknown') AS text,
      m.created_at                                      AS at,
      '/inbox?c=' || m.conversation_id::TEXT            AS href
    FROM messages m
    JOIN conversations cv ON cv.id = m.conversation_id
    JOIN contacts ct      ON ct.id = cv.contact_id
    WHERE cv.account_id = p_account_id
      AND m.sender_type = 'customer'
    ORDER BY m.created_at DESC
    LIMIT 10
  )
  UNION ALL
  (
    -- New contacts
    SELECT
      'contact-' || c.id::TEXT,
      'contact',
      'New contact: ' || COALESCE(c.name, c.phone),
      c.created_at,
      '/contacts'
    FROM contacts c
    WHERE c.account_id = p_account_id
    ORDER BY c.created_at DESC
    LIMIT 10
  )
  UNION ALL
  (
    -- Updated deals
    SELECT
      'deal-' || d.id::TEXT,
      'deal',
      CASE WHEN ps.name IS NOT NULL
        THEN 'Deal "' || d.title || '" in ' || ps.name
        ELSE 'Deal "' || d.title || '" updated'
      END,
      d.updated_at,
      '/pipelines'
    FROM deals d
    LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
    WHERE d.account_id = p_account_id
    ORDER BY d.updated_at DESC
    LIMIT 10
  )
  UNION ALL
  (
    -- Broadcasts
    SELECT
      'broadcast-' || b.id::TEXT,
      'broadcast',
      'Broadcast "' || b.name || '" ' ||
        CASE b.status
          WHEN 'sent' THEN 'sent to ' || b.total_recipients || ' contacts'
          ELSE b.status || ' (' || b.total_recipients || ' recipients)'
        END,
      b.created_at,
      '/broadcasts'
    FROM broadcasts b
    WHERE b.account_id = p_account_id
    ORDER BY b.created_at DESC
    LIMIT 5
  )
  UNION ALL
  (
    -- Automation logs
    SELECT
      'auto-' || al.id::TEXT,
      'automation',
      'Automation "' || COALESCE(a.name, 'Automation') || '" ' ||
        CASE WHEN al.status = 'failed' THEN 'failed for ' ELSE 'triggered for ' END ||
        COALESCE(ct.name, ct.phone, 'a contact'),
      al.created_at,
      NULL
    FROM automation_logs al
    JOIN automations a ON a.id = al.automation_id
    LEFT JOIN contacts ct ON ct.id = al.contact_id
    WHERE al.account_id = p_account_id
    ORDER BY al.created_at DESC
    LIMIT 10
  )
  ORDER BY at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.get_activity_feed(UUID, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_activity_feed(UUID, INT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_activity_feed(UUID, INT) TO service_role;
