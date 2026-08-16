-- ============================================================
-- 089_channel_analytics
--
-- Per-channel analytics RPCs backing /channels/<id>/analytics for
-- WhatsApp, Instagram and Web.
--
-- WHY RPCs AND NOT CLIENT QUERIES
-- `messages` has no account_id — every message aggregate is a join
-- through `conversations`, and the RLS policy on `messages` is itself
-- an EXISTS subquery against `conversations` (migration 017). Pulling
-- 90 days of rows into the browser to count them would be one large
-- transfer plus one policy subquery per row. These aggregate in SQL.
--
-- ⚠️ AUTHORIZATION LIVES IN THE FUNCTION BODY.
-- Every function here is SECURITY DEFINER (that is the whole point —
-- it skips the per-row policy subquery) and granted to `authenticated`,
-- so RLS protects nothing and `p_account_id` is caller-supplied. Each
-- one therefore opens with `analytics_guard(p_account_id)`, which
-- restates migration 017's `is_account_member` and RAISEs otherwise.
-- A server connection (auth.uid() IS NULL, which is how apps/api
-- connects) passes, matching migration 067's rule for
-- get_user_subscription.
--
-- Note: migration 047's dashboard RPCs (get_dashboard_metrics,
-- get_response_time_buckets, get_activity_feed) are SECURITY DEFINER,
-- granted to `authenticated`, take a p_account_id and have NO such
-- guard — any signed-in user can read any workspace's dashboard
-- aggregates. Guards are added to all three at the end of this file.
--
-- CHANNEL VOCABULARY (conversations.channel, migrations 050/053):
--   'whatsapp' | 'instagram' | 'web'
-- SENDER VOCABULARY (messages.sender_type, CHECK from 001):
--   'customer' = inbound; 'agent' = human/API; 'bot' = automation,
--   flow or AI. `ai_agent_id IS NOT NULL` is the AI-written flag
--   (migration 084) and is narrower than sender_type='bot'.
--
-- FILTERS
-- The channel-generic functions take `p_filters JSONB` rather than a
-- widening parameter list, because adding a parameter to a function
-- that already has one means DROP + CREATE (signature change) and a
-- window where the deployed app calls a function that is not there.
-- Recognised keys — every one optional, unknown keys ignored:
--   status      'sent'|'delivered'|'read'|'failed'  → messages.status
--   direction   'in'|'out'
--   agent       'ai'|'human'
--   template    message_templates.name / messages.template_name
--   broadcastId uuid — joins via broadcast_recipients.whatsapp_message_id
--
-- TIME
-- Every bucketing function takes p_tz (an IANA name) and buckets on
-- local wall-clock time. A "busiest hour" in UTC is not a fact anyone
-- can act on.
-- ============================================================

-- ============================================================
-- 0. Guard + shared helpers
-- ============================================================

-- Raises unless the caller may read this account. Server connections
-- (auth.uid() IS NULL) pass — see migration 067.
CREATE OR REPLACE FUNCTION public.analytics_guard(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN TRUE;
  END IF;
  IF is_account_member(p_account_id) THEN
    RETURN TRUE;
  END IF;
  RAISE EXCEPTION 'Not a member of account %', p_account_id
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public.analytics_guard(UUID) IS
  'Authorization for the SECURITY DEFINER analytics RPCs. A JWT caller must be a member of p_account_id; a server connection (auth.uid() IS NULL) passes.';

REVOKE ALL ON FUNCTION public.analytics_guard(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.analytics_guard(UUID) TO authenticated, service_role;

-- Local wall-clock date in an IANA zone.
CREATE OR REPLACE FUNCTION public.local_day(ts TIMESTAMPTZ, tz TEXT)
RETURNS DATE
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT (ts AT TIME ZONE tz)::DATE;
$$;

-- Monday-first day of week (0 = Mon … 6 = Sun) in an IANA zone.
-- iso_dow_mon_first (migration 047) is UTC-only and left untouched.
CREATE OR REPLACE FUNCTION public.local_dow_mon_first(ts TIMESTAMPTZ, tz TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT (EXTRACT(DOW FROM (ts AT TIME ZONE tz))::INT + 6) % 7;
$$;

GRANT EXECUTE ON FUNCTION public.local_day(TIMESTAMPTZ, TEXT)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.local_dow_mon_first(TIMESTAMPTZ, TEXT)   TO authenticated, service_role;

-- ============================================================
-- 1. get_channel_kpis
--
-- One row of headline numbers for a channel, plus the same numbers
-- for the immediately preceding window of equal length so the UI can
-- render a delta without a second call. The previous window is
-- [start - (end-start), start) — half-open at both ends so a day is
-- never counted in both.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_kpis(
  p_account_id UUID,
  p_channel    TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_filters    JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  msgs_out              BIGINT,
  msgs_in               BIGINT,
  delivered             BIGINT,
  read_count            BIGINT,
  failed                BIGINT,
  convs_new             BIGINT,
  convs_active          BIGINT,
  contacts_new          BIGINT,
  ai_replies            BIGINT,
  human_replies         BIGINT,
  handoffs              BIGINT,
  avg_response_minutes  NUMERIC,
  prev_msgs_out             BIGINT,
  prev_msgs_in              BIGINT,
  prev_delivered            BIGINT,
  prev_read_count           BIGINT,
  prev_failed               BIGINT,
  prev_convs_new            BIGINT,
  prev_convs_active         BIGINT,
  prev_contacts_new         BIGINT,
  prev_ai_replies           BIGINT,
  prev_human_replies        BIGINT,
  prev_handoffs             BIGINT,
  prev_avg_response_minutes NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  win AS (
    SELECT
      p_start                       AS cur_start,
      p_end                         AS cur_end,
      p_start - (p_end - p_start)   AS prev_start,
      p_start                       AS prev_end
  ),
  f AS (
    SELECT
      p_filters->>'status'      AS f_status,
      p_filters->>'direction'   AS f_direction,
      p_filters->>'agent'       AS f_agent,
      p_filters->>'template'    AS f_template,
      NULLIF(p_filters->>'broadcastId', '')::UUID AS f_broadcast
  ),
  msg AS (
    SELECT
      m.created_at,
      m.sender_type,
      m.status,
      m.ai_agent_id,
      m.conversation_id,
      (m.created_at >= (SELECT cur_start FROM win) AND m.created_at < (SELECT cur_end  FROM win)) AS in_cur,
      (m.created_at >= (SELECT prev_start FROM win) AND m.created_at < (SELECT prev_end FROM win)) AS in_prev
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    CROSS JOIN f
    WHERE (SELECT ok FROM guard)
      AND c.account_id = p_account_id
      AND c.channel    = p_channel
      AND m.deleted_at IS NULL
      AND m.created_at >= (SELECT prev_start FROM win)
      AND m.created_at <  (SELECT cur_end    FROM win)
      AND (f.f_status    IS NULL OR m.status = f.f_status)
      AND (f.f_template  IS NULL OR m.template_name = f.f_template)
      AND (f.f_direction IS NULL
           OR (f.f_direction = 'in'  AND m.sender_type = 'customer')
           OR (f.f_direction = 'out' AND m.sender_type IN ('agent', 'bot')))
      AND (f.f_agent IS NULL
           OR (f.f_agent = 'ai'    AND m.ai_agent_id IS NOT NULL)
           OR (f.f_agent = 'human' AND m.sender_type = 'agent'))
      AND (f.f_broadcast IS NULL
           OR EXISTS (
             SELECT 1 FROM broadcast_recipients br
             WHERE br.broadcast_id = f.f_broadcast
               AND br.whatsapp_message_id = m.message_id))
  ),
  msg_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE in_cur  AND sender_type IN ('agent','bot'))          AS msgs_out,
      COUNT(*) FILTER (WHERE in_cur  AND sender_type = 'customer')                AS msgs_in,
      COUNT(*) FILTER (WHERE in_cur  AND sender_type IN ('agent','bot')
                                     AND status IN ('delivered','read'))          AS delivered,
      COUNT(*) FILTER (WHERE in_cur  AND sender_type IN ('agent','bot')
                                     AND status = 'read')                         AS read_count,
      COUNT(*) FILTER (WHERE in_cur  AND status = 'failed')                       AS failed,
      COUNT(*) FILTER (WHERE in_cur  AND ai_agent_id IS NOT NULL)                 AS ai_replies,
      COUNT(*) FILTER (WHERE in_cur  AND sender_type = 'agent')                   AS human_replies,
      COUNT(*) FILTER (WHERE in_prev AND sender_type IN ('agent','bot'))          AS p_msgs_out,
      COUNT(*) FILTER (WHERE in_prev AND sender_type = 'customer')                AS p_msgs_in,
      COUNT(*) FILTER (WHERE in_prev AND sender_type IN ('agent','bot')
                                     AND status IN ('delivered','read'))          AS p_delivered,
      COUNT(*) FILTER (WHERE in_prev AND sender_type IN ('agent','bot')
                                     AND status = 'read')                         AS p_read,
      COUNT(*) FILTER (WHERE in_prev AND status = 'failed')                       AS p_failed,
      COUNT(*) FILTER (WHERE in_prev AND ai_agent_id IS NOT NULL)                 AS p_ai,
      COUNT(*) FILTER (WHERE in_prev AND sender_type = 'agent')                   AS p_human
    FROM msg
  ),
  -- First-response pairs: a customer message immediately followed by
  -- an agent/bot one, within the same conversation. Same shape as
  -- migration 047's get_response_time_buckets so the two agree.
  ordered AS (
    SELECT
      conversation_id, sender_type, created_at,
      LEAD(created_at)  OVER (PARTITION BY conversation_id ORDER BY created_at) AS next_at,
      LEAD(sender_type) OVER (PARTITION BY conversation_id ORDER BY created_at) AS next_sender
    FROM msg
  ),
  resp AS (
    SELECT
      created_at,
      EXTRACT(EPOCH FROM (next_at - created_at)) / 60.0 AS minutes
    FROM ordered
    WHERE sender_type = 'customer'
      AND next_sender IN ('agent','bot')
      AND next_at > created_at
  ),
  resp_agg AS (
    SELECT
      AVG(minutes) FILTER (WHERE created_at >= (SELECT cur_start  FROM win)
                             AND created_at <  (SELECT cur_end    FROM win)) AS cur_avg,
      AVG(minutes) FILTER (WHERE created_at >= (SELECT prev_start FROM win)
                             AND created_at <  (SELECT prev_end   FROM win)) AS prev_avg
    FROM resp
  ),
  conv_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE c.created_at >= (SELECT cur_start FROM win)
                         AND c.created_at <  (SELECT cur_end   FROM win))            AS new_cur,
      COUNT(*) FILTER (WHERE c.created_at >= (SELECT prev_start FROM win)
                         AND c.created_at <  (SELECT prev_end   FROM win))           AS new_prev,
      COUNT(*) FILTER (WHERE c.last_message_at >= (SELECT cur_start FROM win)
                         AND c.last_message_at <  (SELECT cur_end   FROM win))       AS active_cur,
      COUNT(*) FILTER (WHERE c.last_message_at >= (SELECT prev_start FROM win)
                         AND c.last_message_at <  (SELECT prev_end   FROM win))      AS active_prev,
      COUNT(*) FILTER (WHERE c.ai_handoff_at >= (SELECT cur_start FROM win)
                         AND c.ai_handoff_at <  (SELECT cur_end   FROM win))         AS handoff_cur,
      COUNT(*) FILTER (WHERE c.ai_handoff_at >= (SELECT prev_start FROM win)
                         AND c.ai_handoff_at <  (SELECT prev_end   FROM win))        AS handoff_prev
    FROM conversations c
    WHERE c.account_id = p_account_id
      AND c.channel    = p_channel
  ),
  -- A contact "belongs to" a channel if it has ever held a
  -- conversation there. contacts.source is not usable for this: it
  -- records how the row was created (import, api, …), not where the
  -- person talks.
  contact_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE ct.created_at >= (SELECT cur_start FROM win)
                         AND ct.created_at <  (SELECT cur_end   FROM win))  AS new_cur,
      COUNT(*) FILTER (WHERE ct.created_at >= (SELECT prev_start FROM win)
                         AND ct.created_at <  (SELECT prev_end   FROM win)) AS new_prev
    FROM contacts ct
    WHERE ct.account_id = p_account_id
      AND EXISTS (
        SELECT 1 FROM conversations c2
        WHERE c2.contact_id = ct.id AND c2.channel = p_channel
      )
  )
  SELECT
    ma.msgs_out, ma.msgs_in, ma.delivered, ma.read_count, ma.failed,
    ca.new_cur, ca.active_cur, cta.new_cur,
    ma.ai_replies, ma.human_replies, ca.handoff_cur,
    ROUND(ra.cur_avg, 1),
    ma.p_msgs_out, ma.p_msgs_in, ma.p_delivered, ma.p_read, ma.p_failed,
    ca.new_prev, ca.active_prev, cta.new_prev,
    ma.p_ai, ma.p_human, ca.handoff_prev,
    ROUND(ra.prev_avg, 1)
  FROM msg_agg ma
  CROSS JOIN conv_agg ca
  CROSS JOIN contact_agg cta
  CROSS JOIN resp_agg ra;
$$;

REVOKE ALL ON FUNCTION public.get_channel_kpis(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_kpis(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) TO authenticated, service_role;

-- ============================================================
-- 2. get_channel_series — daily volume
--
-- Returns one row per day that HAS data. Days with no traffic are
-- absent, not zero: the client fills the gaps, because only it knows
-- the requested range and cannot distinguish "no rows" from
-- "query failed" if the server silently returns nothing.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_series(
  p_account_id UUID,
  p_channel    TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT  DEFAULT 'UTC',
  p_filters    JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  day       DATE,
  incoming  BIGINT,
  outgoing  BIGINT,
  delivered BIGINT,
  read_count BIGINT,
  failed    BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  f AS (
    SELECT
      p_filters->>'status'    AS f_status,
      p_filters->>'direction' AS f_direction,
      p_filters->>'agent'     AS f_agent,
      p_filters->>'template'  AS f_template,
      NULLIF(p_filters->>'broadcastId', '')::UUID AS f_broadcast
  )
  SELECT
    local_day(m.created_at, p_tz)                                        AS day,
    COUNT(*) FILTER (WHERE m.sender_type = 'customer')                   AS incoming,
    COUNT(*) FILTER (WHERE m.sender_type IN ('agent','bot'))             AS outgoing,
    COUNT(*) FILTER (WHERE m.sender_type IN ('agent','bot')
                       AND m.status IN ('delivered','read'))             AS delivered,
    COUNT(*) FILTER (WHERE m.sender_type IN ('agent','bot')
                       AND m.status = 'read')                            AS read_count,
    COUNT(*) FILTER (WHERE m.status = 'failed')                          AS failed
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  CROSS JOIN f
  WHERE (SELECT ok FROM guard)
    AND c.account_id = p_account_id
    AND c.channel    = p_channel
    AND m.deleted_at IS NULL
    AND m.created_at >= p_start
    AND m.created_at <  p_end
    AND (f.f_status    IS NULL OR m.status = f.f_status)
    AND (f.f_template  IS NULL OR m.template_name = f.f_template)
    AND (f.f_direction IS NULL
         OR (f.f_direction = 'in'  AND m.sender_type = 'customer')
         OR (f.f_direction = 'out' AND m.sender_type IN ('agent','bot')))
    AND (f.f_agent IS NULL
         OR (f.f_agent = 'ai'    AND m.ai_agent_id IS NOT NULL)
         OR (f.f_agent = 'human' AND m.sender_type = 'agent'))
    AND (f.f_broadcast IS NULL
         OR EXISTS (
           SELECT 1 FROM broadcast_recipients br
           WHERE br.broadcast_id = f.f_broadcast
             AND br.whatsapp_message_id = m.message_id))
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_channel_series(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_series(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB) TO authenticated, service_role;

-- ============================================================
-- 3. get_channel_heatmap — when customers actually message
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_heatmap(
  p_account_id UUID,
  p_channel    TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  dow      INT,   -- 0 = Mon … 6 = Sun, in p_tz
  hour     INT,   -- 0 … 23, in p_tz
  inbound  BIGINT,
  outbound BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    local_dow_mon_first(m.created_at, p_tz)                       AS dow,
    EXTRACT(HOUR FROM (m.created_at AT TIME ZONE p_tz))::INT      AS hour,
    COUNT(*) FILTER (WHERE m.sender_type = 'customer')            AS inbound,
    COUNT(*) FILTER (WHERE m.sender_type IN ('agent','bot'))      AS outbound
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE (SELECT ok FROM guard)
    AND c.account_id = p_account_id
    AND c.channel    = p_channel
    AND m.deleted_at IS NULL
    AND m.created_at >= p_start
    AND m.created_at <  p_end
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

REVOKE ALL ON FUNCTION public.get_channel_heatmap(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_heatmap(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- ============================================================
-- 4. get_channel_leads — contacts and pipeline sourced from a channel
--
-- Deals are attributed through deals.conversation_id, which is the
-- only hard link between a deal and where the conversation happened.
-- A deal created from the contacts page has no conversation and is
-- correctly absent here rather than spread across channels.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_leads(
  p_account_id UUID,
  p_channel    TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day          DATE,
  contacts     BIGINT,
  deals        BIGINT,
  deals_won    BIGINT,
  deal_value   NUMERIC,
  won_value    NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  new_contacts AS (
    SELECT local_day(ct.created_at, p_tz) AS day, COUNT(*) AS n
    FROM contacts ct
    WHERE (SELECT ok FROM guard)
      AND ct.account_id = p_account_id
      AND ct.created_at >= p_start
      AND ct.created_at <  p_end
      AND EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.contact_id = ct.id AND c.channel = p_channel
      )
    GROUP BY 1
  ),
  new_deals AS (
    SELECT
      local_day(d.created_at, p_tz)                            AS day,
      COUNT(*)                                                 AS n,
      COUNT(*) FILTER (WHERE d.status = 'won')                 AS won,
      COALESCE(SUM(d.value), 0)                                AS val,
      COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) AS won_val
    FROM deals d
    JOIN conversations c ON c.id = d.conversation_id
    WHERE d.account_id = p_account_id
      AND c.channel    = p_channel
      AND d.created_at >= p_start
      AND d.created_at <  p_end
    GROUP BY 1
  )
  SELECT
    COALESCE(nc.day, nd.day)   AS day,
    COALESCE(nc.n, 0)          AS contacts,
    COALESCE(nd.n, 0)          AS deals,
    COALESCE(nd.won, 0)        AS deals_won,
    COALESCE(nd.val, 0)        AS deal_value,
    COALESCE(nd.won_val, 0)    AS won_value
  FROM new_contacts nc
  FULL OUTER JOIN new_deals nd ON nd.day = nc.day
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_channel_leads(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_leads(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- ============================================================
-- 5. get_channel_top_contacts
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_top_contacts(
  p_account_id UUID,
  p_channel    TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 8
)
RETURNS TABLE (
  contact_id   UUID,
  name         TEXT,
  handle       TEXT,
  inbound      BIGINT,
  outbound     BIGINT,
  last_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    ct.id,
    ct.name,
    COALESCE(ct.phone, ct.ig_username, ct.web_visitor_id)      AS handle,
    COUNT(*) FILTER (WHERE m.sender_type = 'customer')         AS inbound,
    COUNT(*) FILTER (WHERE m.sender_type IN ('agent','bot'))   AS outbound,
    MAX(m.created_at)                                          AS last_at
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN contacts ct     ON ct.id = c.contact_id
  WHERE (SELECT ok FROM guard)
    AND c.account_id = p_account_id
    AND c.channel    = p_channel
    AND m.deleted_at IS NULL
    AND m.created_at >= p_start
    AND m.created_at <  p_end
  GROUP BY ct.id, ct.name, handle
  ORDER BY (COUNT(*)) DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_channel_top_contacts(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_top_contacts(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 6. WhatsApp — broadcast performance
--
-- Counts come from broadcast_recipients rather than the denormalised
-- counters on `broadcasts`: the counters are maintained by the send
-- worker and drift when a run is interrupted, while the recipient
-- rows are what the worker actually wrote.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_wa_broadcast_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 25
)
RETURNS TABLE (
  broadcast_id  UUID,
  name          TEXT,
  template_name TEXT,
  status        TEXT,
  created_at    TIMESTAMPTZ,
  scheduled_at  TIMESTAMPTZ,
  recipients    BIGINT,
  sent          BIGINT,
  delivered     BIGINT,
  read_count    BIGINT,
  replied       BIGINT,
  failed        BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    b.id,
    b.name,
    b.template_name,
    b.status,
    b.created_at,
    b.scheduled_at,
    COUNT(br.id)                                                AS recipients,
    COUNT(br.id) FILTER (WHERE br.sent_at      IS NOT NULL)      AS sent,
    COUNT(br.id) FILTER (WHERE br.delivered_at IS NOT NULL)      AS delivered,
    COUNT(br.id) FILTER (WHERE br.read_at      IS NOT NULL)      AS read_count,
    COUNT(br.id) FILTER (WHERE br.replied_at   IS NOT NULL)      AS replied,
    COUNT(br.id) FILTER (WHERE br.status = 'failed')             AS failed
  FROM broadcasts b
  LEFT JOIN broadcast_recipients br ON br.broadcast_id = b.id
  WHERE (SELECT ok FROM guard)
    AND b.account_id = p_account_id
    AND b.created_at >= p_start
    AND b.created_at <  p_end
  GROUP BY b.id
  ORDER BY b.created_at DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_wa_broadcast_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wa_broadcast_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 7. WhatsApp — template usage
--
-- Sends are counted from messages.template_name (what actually went
-- out) and LEFT JOINed to message_templates for approval status and
-- Meta's quality score. A template that was deleted from the library
-- still appears, because its sends happened.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_wa_template_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 15
)
RETURNS TABLE (
  template_name  TEXT,
  category       TEXT,
  status         TEXT,
  quality_score  TEXT,
  sends          BIGINT,
  delivered      BIGINT,
  read_count     BIGINT,
  failed         BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  sends AS (
    SELECT
      m.template_name                                              AS tname,
      COUNT(*)                                                     AS n,
      COUNT(*) FILTER (WHERE m.status IN ('delivered','read'))     AS delivered,
      COUNT(*) FILTER (WHERE m.status = 'read')                    AS read_count,
      COUNT(*) FILTER (WHERE m.status = 'failed')                  AS failed
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (SELECT ok FROM guard)
      AND c.account_id = p_account_id
      AND c.channel    = 'whatsapp'
      AND m.template_name IS NOT NULL
      AND m.deleted_at IS NULL
      AND m.created_at >= p_start
      AND m.created_at <  p_end
    GROUP BY 1
  )
  SELECT
    s.tname,
    mt.category,
    mt.status,
    mt.quality_score,
    s.n, s.delivered, s.read_count, s.failed
  FROM sends s
  LEFT JOIN LATERAL (
    SELECT t.category, t.status, t.quality_score
    FROM message_templates t
    WHERE t.account_id = p_account_id AND t.name = s.tname
    LIMIT 1
  ) mt ON TRUE
  ORDER BY s.n DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_wa_template_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wa_template_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 8. WhatsApp — commerce
--
-- ⚠️ whatsapp_orders.total_amount is a DECIMAL in MAJOR units, unlike
-- the ads and credits tables which are BIGINT minor units. Do not
-- copy a minorToMajor() call onto these numbers.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_wa_commerce_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day       DATE,
  orders    BIGINT,
  revenue   NUMERIC,
  pending   BIGINT,
  currency  TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    local_day(o.created_at, p_tz)                       AS day,
    COUNT(*)                                            AS orders,
    COALESCE(SUM(o.total_amount), 0)                    AS revenue,
    COUNT(*) FILTER (WHERE o.status = 'pending')        AS pending,
    MIN(o.currency)                                     AS currency
  FROM whatsapp_orders o
  WHERE (SELECT ok FROM guard)
    AND o.account_id = p_account_id
    AND o.created_at >= p_start
    AND o.created_at <  p_end
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_wa_commerce_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wa_commerce_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- Top products, unnested from whatsapp_orders.items. The shape is
-- [{product_retailer_id, item_price, quantity, ...}] as Meta sends it.
CREATE OR REPLACE FUNCTION public.get_wa_top_products(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 8
)
RETURNS TABLE (
  retailer_id TEXT,
  title       TEXT,
  units       BIGINT,
  revenue     NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  items AS (
    SELECT
      COALESCE(it->>'product_retailer_id', it->>'retailer_id', 'unknown') AS rid,
      COALESCE((it->>'quantity')::NUMERIC, 1)                             AS qty,
      COALESCE((it->>'item_price')::NUMERIC, 0)                           AS price
    FROM whatsapp_orders o
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::JSONB END
    ) AS it
    WHERE (SELECT ok FROM guard)
      AND o.account_id = p_account_id
      AND o.created_at >= p_start
      AND o.created_at <  p_end
  )
  SELECT
    i.rid,
    p.name,
    SUM(i.qty)::BIGINT      AS units,
    SUM(i.qty * i.price)    AS revenue
  FROM items i
  LEFT JOIN LATERAL (
    SELECT wp.name
    FROM whatsapp_products wp
    WHERE wp.account_id = p_account_id AND wp.retailer_id = i.rid
    LIMIT 1
  ) p ON TRUE
  GROUP BY i.rid, p.name
  ORDER BY revenue DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_wa_top_products(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wa_top_products(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 9. WhatsApp — Click-to-WhatsApp funnel
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_wa_ctwa_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 15
)
RETURNS TABLE (
  campaign_id   UUID,
  name          TEXT,
  status        TEXT,
  clicks        BIGINT,
  conversations BIGINT,
  converted     BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    cc.id,
    cc.name,
    cc.status,
    COUNT(cl.id)                                                       AS clicks,
    COUNT(DISTINCT cl.conversation_id)                                 AS conversations,
    COUNT(cl.id) FILTER (WHERE cl.converted IS TRUE)                   AS converted
  FROM ctwa_campaigns cc
  LEFT JOIN ctwa_clicks cl
    ON cl.campaign_id = cc.id
   AND cl.click_timestamp >= p_start
   AND cl.click_timestamp <  p_end
  WHERE (SELECT ok FROM guard)
    AND cc.account_id = p_account_id
  GROUP BY cc.id
  ORDER BY clicks DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_wa_ctwa_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wa_ctwa_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 10. Instagram — comments
--
-- `commented_at` is Meta's timestamp and is nullable on rows that
-- arrived without one; COALESCE to created_at so those are not
-- silently dropped from every range.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_ig_comment_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC',
  p_media_id   TEXT DEFAULT NULL
)
RETURNS TABLE (
  day             DATE,
  received        BIGINT,
  replied         BIGINT,
  open_count      BIGINT,
  hidden          BIGINT,
  private_replies BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    local_day(COALESCE(ic.commented_at, ic.created_at), p_tz)          AS day,
    COUNT(*) FILTER (WHERE ic.is_from_business IS FALSE)               AS received,
    COUNT(*) FILTER (WHERE ic.replied_at IS NOT NULL)                  AS replied,
    COUNT(*) FILTER (WHERE ic.status = 'open'
                       AND ic.is_from_business IS FALSE)               AS open_count,
    COUNT(*) FILTER (WHERE ic.status = 'hidden')                       AS hidden,
    COUNT(*) FILTER (WHERE ic.private_replied_at IS NOT NULL)          AS private_replies
  FROM instagram_comments ic
  WHERE (SELECT ok FROM guard)
    AND ic.account_id = p_account_id
    AND (p_media_id IS NULL OR ic.ig_media_id = p_media_id)
    AND COALESCE(ic.commented_at, ic.created_at) >= p_start
    AND COALESCE(ic.commented_at, ic.created_at) <  p_end
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_ig_comment_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ig_comment_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO authenticated, service_role;

-- ============================================================
-- 11. Instagram — comment→DM funnels
--
-- Run states are awaiting_optin | awaiting_follow | delivered | failed
-- (migration 051). `matched` is counted from runs in range, not from
-- the lifetime matched_count counter on the funnel row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_ig_funnel_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 15
)
RETURNS TABLE (
  funnel_id       UUID,
  name            TEXT,
  is_active       BOOLEAN,
  matched         BIGINT,
  awaiting_optin  BIGINT,
  awaiting_follow BIGINT,
  delivered       BIGINT,
  failed          BIGINT,
  was_following   BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    fn.id,
    fn.name,
    fn.is_active,
    COUNT(r.id)                                                     AS matched,
    COUNT(r.id) FILTER (WHERE r.state = 'awaiting_optin')           AS awaiting_optin,
    COUNT(r.id) FILTER (WHERE r.state = 'awaiting_follow')          AS awaiting_follow,
    COUNT(r.id) FILTER (WHERE r.state = 'delivered')                AS delivered,
    COUNT(r.id) FILTER (WHERE r.state = 'failed')                   AS failed,
    COUNT(r.id) FILTER (WHERE r.was_following IS TRUE)              AS was_following
  FROM instagram_comment_funnels fn
  LEFT JOIN instagram_comment_funnel_runs r
    ON r.funnel_id  = fn.id
   AND r.created_at >= p_start
   AND r.created_at <  p_end
  WHERE (SELECT ok FROM guard)
    AND fn.account_id = p_account_id
  GROUP BY fn.id
  ORDER BY matched DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_ig_funnel_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ig_funnel_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 12. Instagram — post performance
--
-- `comments_count` on instagram_media is Instagram's own lifetime
-- total and includes comments from before the account was connected;
-- `comments_in_range` is what we actually saw. They are deliberately
-- separate columns rather than one reconciled number.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_ig_post_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 10
)
RETURNS TABLE (
  ig_media_id       TEXT,
  permalink         TEXT,
  thumbnail_url     TEXT,
  caption           TEXT,
  media_product_type TEXT,
  posted_at         TIMESTAMPTZ,
  like_count        INT,
  comments_total    INT,
  comments_in_range BIGINT,
  dms_started       BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  in_range AS (
    SELECT
      ic.ig_media_id,
      COUNT(*) FILTER (WHERE ic.is_from_business IS FALSE)          AS comments,
      COUNT(*) FILTER (WHERE ic.private_reply_conversation_id
                             IS NOT NULL)                            AS dms
    FROM instagram_comments ic
    WHERE (SELECT ok FROM guard)
      AND ic.account_id = p_account_id
      AND COALESCE(ic.commented_at, ic.created_at) >= p_start
      AND COALESCE(ic.commented_at, ic.created_at) <  p_end
    GROUP BY 1
  )
  SELECT
    im.ig_media_id,
    im.permalink,
    COALESCE(im.thumbnail_url, im.media_url),
    im.caption,
    im.media_product_type,
    im.posted_at,
    im.like_count,
    im.comments_count,
    COALESCE(ir.comments, 0),
    COALESCE(ir.dms, 0)
  FROM instagram_media im
  LEFT JOIN in_range ir ON ir.ig_media_id = im.ig_media_id
  WHERE im.account_id = p_account_id
  ORDER BY COALESCE(ir.comments, 0) DESC, im.posted_at DESC NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.get_ig_post_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ig_post_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 13. Web — visitor sessions
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_web_session_stats(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day               DATE,
  sessions          BIGINT,
  visitors          BIGINT,
  with_conversation BIGINT,
  identified        BIGINT,
  pages_viewed      BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok)
  SELECT
    local_day(ws.started_at, p_tz)                                AS day,
    COUNT(*)                                                      AS sessions,
    COUNT(DISTINCT ws.visitor_id)                                 AS visitors,
    COUNT(*) FILTER (WHERE ws.conversation_id IS NOT NULL)        AS with_conversation,
    COUNT(*) FILTER (WHERE ws.contact_id IS NOT NULL)             AS identified,
    COALESCE(SUM(ws.pages_viewed), 0)                             AS pages_viewed
  FROM web_sessions ws
  WHERE (SELECT ok FROM guard)
    AND ws.account_id = p_account_id
    AND ws.started_at >= p_start
    AND ws.started_at <  p_end
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_web_session_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_web_session_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- Top entry pages / referrers / countries in one call. `dimension`
-- discriminates the rows so the page makes one round trip for three
-- tables that are always shown together.
CREATE OR REPLACE FUNCTION public.get_web_top_sources(
  p_account_id UUID,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_limit      INT DEFAULT 8
)
RETURNS TABLE (
  dimension     TEXT,   -- 'page' | 'referrer' | 'country'
  label         TEXT,
  sessions      BIGINT,
  conversations BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  scoped AS (
    SELECT ws.page_url, ws.referrer, ws.country, ws.conversation_id
    FROM web_sessions ws
    WHERE (SELECT ok FROM guard)
      AND ws.account_id = p_account_id
      AND ws.started_at >= p_start
      AND ws.started_at <  p_end
  ),
  ranked AS (
    SELECT
      d.dimension,
      d.label,
      COUNT(*)                                                  AS sessions,
      COUNT(*) FILTER (WHERE s.conversation_id IS NOT NULL)     AS conversations,
      ROW_NUMBER() OVER (
        PARTITION BY d.dimension ORDER BY COUNT(*) DESC
      ) AS rn
    FROM scoped s
    CROSS JOIN LATERAL (VALUES
      ('page',     COALESCE(NULLIF(s.page_url, ''), '(unknown)')),
      ('referrer', COALESCE(NULLIF(s.referrer, ''), '(direct)')),
      ('country',  COALESCE(NULLIF(s.country,  ''), '(unknown)'))
    ) AS d(dimension, label)
    GROUP BY d.dimension, d.label
  )
  SELECT r.dimension, r.label, r.sessions, r.conversations
  FROM ranked r
  WHERE r.rn <= GREATEST(p_limit, 1)
  ORDER BY r.dimension, r.sessions DESC;
$$;

REVOKE ALL ON FUNCTION public.get_web_top_sources(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_web_top_sources(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

-- ============================================================
-- 14. get_channel_alerts — the fix-it shortcuts
--
-- Everything the analytics page can offer to FIX rather than merely
-- report, in one call. `severity` is 'error' | 'warn'; `href` is where
-- the fix happens. Rows only exist when there is something wrong, so
-- an empty result is a healthy channel and the strip renders nothing.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_channel_alerts(
  p_account_id UUID,
  p_channel    TEXT
)
RETURNS TABLE (
  kind     TEXT,
  severity TEXT,
  count    BIGINT,
  detail   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (SELECT analytics_guard(p_account_id) AS ok),
  failed_msgs AS (
    SELECT COUNT(*) AS n
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (SELECT ok FROM guard)
      AND c.account_id = p_account_id
      AND c.channel    = p_channel
      AND m.status     = 'failed'
      AND m.created_at >= NOW() - INTERVAL '7 days'
  ),
  unread AS (
    SELECT COUNT(*) AS n
    FROM conversations c
    WHERE c.account_id = p_account_id
      AND c.channel    = p_channel
      AND c.status     = 'open'
      AND COALESCE(c.unread_count, 0) > 0
  ),
  handoffs AS (
    SELECT COUNT(*) AS n
    FROM conversations c
    WHERE c.account_id = p_account_id
      AND c.channel    = p_channel
      AND c.status     = 'open'
      AND c.ai_handoff_at >= NOW() - INTERVAL '7 days'
  ),
  rejected_templates AS (
    SELECT COUNT(*) AS n
    FROM message_templates t
    WHERE p_channel = 'whatsapp'
      AND t.account_id = p_account_id
      AND UPPER(COALESCE(t.status, '')) = 'REJECTED'
  ),
  wa_token AS (
    SELECT
      COUNT(*) FILTER (
        WHERE w.token_expires_at IS NOT NULL
          AND w.token_expires_at < NOW() + INTERVAL '14 days'
      ) AS n,
      MIN(w.quality_rating) AS quality
    FROM whatsapp_config w
    WHERE p_channel = 'whatsapp' AND w.account_id = p_account_id
  ),
  ig_token AS (
    SELECT COUNT(*) AS n
    FROM instagram_config g
    WHERE p_channel = 'instagram'
      AND g.account_id = p_account_id
      AND (g.status <> 'connected'
           OR (g.token_expires_at IS NOT NULL
               AND g.token_expires_at < NOW() + INTERVAL '14 days'))
  ),
  ig_failed_runs AS (
    SELECT COUNT(*) AS n
    FROM instagram_comment_funnel_runs r
    WHERE p_channel = 'instagram'
      AND r.account_id = p_account_id
      AND r.state = 'failed'
      AND r.created_at >= NOW() - INTERVAL '7 days'
  ),
  web_origins AS (
    SELECT COUNT(*) AS n
    FROM web_config wc
    WHERE p_channel = 'web'
      AND wc.account_id = p_account_id
      AND COALESCE(ARRAY_LENGTH(wc.allowed_origins, 1), 0) = 0
  )
  SELECT * FROM (
    SELECT 'failed_messages'::TEXT,  'error'::TEXT, n, 'in the last 7 days'::TEXT      FROM failed_msgs        WHERE n > 0
    UNION ALL
    SELECT 'unread',                 'warn',        n, 'open threads unread'           FROM unread             WHERE n > 0
    UNION ALL
    SELECT 'ai_handoff',             'warn',        n, 'threads the bot handed over'   FROM handoffs           WHERE n > 0
    UNION ALL
    SELECT 'rejected_templates',     'error',       n, 'templates rejected by Meta'    FROM rejected_templates WHERE n > 0
    UNION ALL
    SELECT 'token_expiring',         'error',       n, 'WhatsApp token expires soon'   FROM wa_token           WHERE n > 0
    UNION ALL
    SELECT 'quality_rating',         'warn',        1, quality                          FROM wa_token
      WHERE quality IS NOT NULL AND UPPER(quality) IN ('RED', 'YELLOW')
    UNION ALL
    SELECT 'connection',             'error',       n, 'Instagram needs reconnecting'  FROM ig_token           WHERE n > 0
    UNION ALL
    SELECT 'funnel_failures',        'error',       n, 'funnel runs failed'            FROM ig_failed_runs     WHERE n > 0
    UNION ALL
    SELECT 'no_origins',             'error',       n, 'no allowed origins — widget blocked' FROM web_origins  WHERE n > 0
  ) AS alerts(kind, severity, count, detail);
$$;

REVOKE ALL ON FUNCTION public.get_channel_alerts(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_channel_alerts(UUID, TEXT) TO authenticated, service_role;

-- ============================================================
-- 15. Retro-fit the missing guard onto migration 047's RPCs
--
-- All three are SECURITY DEFINER, take a caller-supplied
-- p_account_id and are granted to `authenticated` — so today any
-- signed-in user can read any workspace's dashboard aggregates by
-- passing a different id. The bodies are otherwise unchanged; only
-- the analytics_guard() call is new.
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
    guard AS (SELECT analytics_guard(p_account_id) AS ok),
    range_dur AS (
      SELECT
        p_since_ts                                AS win_start,
        p_range_end                               AS win_end,
        p_since_ts - (p_range_end - p_since_ts)   AS prev_start,
        p_since_ts                                AS prev_end
    ),
    cur_convs AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')                                 AS total_open,
        COUNT(*) FILTER (WHERE status = 'open'
                           AND created_at >= (SELECT win_start FROM range_dur)
                           AND created_at <= (SELECT win_end   FROM range_dur)) AS new_in_range
      FROM conversations
      WHERE (SELECT ok FROM guard) AND account_id = p_account_id
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
      SELECT COUNT(*) AS cnt, COALESCE(SUM(value), 0) AS val
      FROM deals
      WHERE account_id = p_account_id AND status = 'open'
    ),
    cur_msgs AS (
      SELECT COUNT(*) AS sent_in_range
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type IN ('agent', 'bot')
        AND m.created_at >= (SELECT win_start FROM range_dur)
        AND m.created_at <= (SELECT win_end   FROM range_dur)
    ),
    prev_msgs AS (
      SELECT COUNT(*) AS sent_yesterday
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type IN ('agent', 'bot')
        AND m.created_at >= (SELECT prev_start FROM range_dur)
        AND m.created_at <  (SELECT prev_end   FROM range_dur)
    )
  SELECT
    cur_convs.total_open,
    cur_convs.new_in_range,
    cur_contacts.new_in_range,
    open_deals.cnt,
    open_deals.val,
    cur_msgs.sent_in_range,
    prev_convs.new_yesterday,
    prev_contacts.new_yesterday,
    prev_msgs.sent_yesterday
  FROM cur_convs, prev_convs, cur_contacts, prev_contacts, open_deals, cur_msgs, prev_msgs;
$$;

CREATE OR REPLACE FUNCTION public.get_response_time_buckets(
  p_account_id UUID,
  p_days       INT DEFAULT 14
)
RETURNS TABLE (
  dow          INT,
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
  paired AS (
    SELECT
      wm.conversation_id,
      wm.created_at AS customer_at,
      LEAD(wm.created_at)  OVER (PARTITION BY wm.conversation_id ORDER BY wm.rn) AS next_at,
      LEAD(wm.sender_type) OVER (PARTITION BY wm.conversation_id ORDER BY wm.rn) AS next_sender
    FROM window_messages wm
    WHERE wm.sender_type = 'customer'
  ),
  samples AS (
    SELECT
      customer_at,
      EXTRACT(EPOCH FROM (next_at - customer_at)) / 60.0 AS response_minutes
    FROM paired
    WHERE next_sender IN ('agent', 'bot') AND next_at > customer_at
  )
  SELECT
    iso_dow_mon_first(customer_at) AS dow,
    AVG(response_minutes)          AS avg_minutes,
    COUNT(*)                       AS sample_count
  FROM samples
  GROUP BY iso_dow_mon_first(customer_at)
  ORDER BY dow;
$$;

-- get_activity_feed is a UNION of five per-source branches, each with
-- its own ORDER BY/LIMIT, so a guard CTE cannot be prepended the way
-- it was above. plpgsql with an up-front PERFORM is the same check.
-- `#variable_conflict use_column` is required: the OUT parameters are
-- named id/kind/text/at/href and the body's final `ORDER BY at` would
-- otherwise resolve to the variable, not the column.
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM analytics_guard(p_account_id);

  RETURN QUERY
  (
    SELECT
      'msg-' || m.id::TEXT,
      'message'::TEXT,
      'New message from ' || COALESCE(ct.name, ct.phone, 'Unknown'),
      m.created_at,
      '/inbox?c=' || m.conversation_id::TEXT
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
    SELECT
      'contact-' || c.id::TEXT,
      'contact'::TEXT,
      'New contact: ' || COALESCE(c.name, c.phone),
      c.created_at,
      '/contacts'::TEXT
    FROM contacts c
    WHERE c.account_id = p_account_id
    ORDER BY c.created_at DESC
    LIMIT 10
  )
  UNION ALL
  (
    SELECT
      'deal-' || d.id::TEXT,
      'deal'::TEXT,
      CASE WHEN ps.name IS NOT NULL
        THEN 'Deal "' || d.title || '" in ' || ps.name
        ELSE 'Deal "' || d.title || '" updated'
      END,
      d.updated_at,
      '/pipelines'::TEXT
    FROM deals d
    LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
    WHERE d.account_id = p_account_id
    ORDER BY d.updated_at DESC
    LIMIT 10
  )
  UNION ALL
  (
    SELECT
      'broadcast-' || b.id::TEXT,
      'broadcast'::TEXT,
      'Broadcast "' || b.name || '" ' ||
        CASE b.status
          WHEN 'sent' THEN 'sent to ' || b.total_recipients || ' contacts'
          ELSE b.status || ' (' || b.total_recipients || ' recipients)'
        END,
      b.created_at,
      '/broadcasts'::TEXT
    FROM broadcasts b
    WHERE b.account_id = p_account_id
    ORDER BY b.created_at DESC
    LIMIT 5
  )
  UNION ALL
  (
    SELECT
      'auto-' || al.id::TEXT,
      'automation'::TEXT,
      'Automation "' || COALESCE(a.name, 'Automation') || '" ' ||
        CASE WHEN al.status = 'failed' THEN 'failed for ' ELSE 'triggered for ' END ||
        COALESCE(ct.name, ct.phone, 'a contact'),
      al.created_at,
      NULL::TEXT
    FROM automation_logs al
    JOIN automations a ON a.id = al.automation_id
    LEFT JOIN contacts ct ON ct.id = al.contact_id
    WHERE al.account_id = p_account_id
    ORDER BY al.created_at DESC
    LIMIT 10
  )
  ORDER BY 4 DESC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_channel_kpis(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) IS
  'Headline analytics for one channel plus the preceding equal-length window. SECURITY DEFINER — authorization is analytics_guard() in the body.';

COMMENT ON FUNCTION public.get_activity_feed(UUID, INT) IS
  'Recent cross-source activity for one account. SECURITY DEFINER — authorization is analytics_guard() in the body (added in migration 089).';
