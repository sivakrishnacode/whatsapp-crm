-- ============================================================
-- 098_control_center
--
-- The tables behind the C2.0 Management Control Center
-- (apps/admin-panel). Everything here is INTERNAL operations data:
-- who on our side looks after a workspace, what they wrote about it,
-- the support tickets raised for it, and how staff sign in.
--
-- ⚠️ NONE OF THIS IS CUSTOMER DATA AND NONE OF IT IS REACHABLE FROM THE
-- BROWSER. Every table below gets RLS ON with ZERO policies and all
-- rights revoked from anon/authenticated, exactly like admin_audit_log
-- (073). Only an owner connection — the admin panel's Prisma client —
-- can read or write them. A policy added here later would expose staff
-- password hashes or internal notes to every signed-in customer.
--
-- WHAT IS DELIBERATELY NOT DUPLICATED
-- The handoff (C360-036) asks to "reference existing organization and
-- subscription IDs; avoid duplicate copies". So there is no copy of
-- plan, status, members, messages or health here. Lifecycle stage, for
-- one, is DERIVED from those tables on read; the only thing stored is
-- an operator's explicit override and the reason for it.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Staff — the people who sign in to the Control Center.
--
-- Before this the panel had ONE env credential. That credential still
-- works (as a break-glass super admin, see apps/admin-panel/lib/auth.ts)
-- but cannot be assigned an account, own a ticket or be told apart in
-- the audit log, which is what everything below needs.
--
-- `session_version` is the revoke button: every session JWT carries the
-- version it was minted under, and bumping it (deactivate, role change,
-- password reset) invalidates them on the next request.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_staff (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL,
  full_name        TEXT NOT NULL,
  role             TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  session_version  INTEGER NOT NULL DEFAULT 1,
  last_login_at    TIMESTAMPTZ,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_staff_role_check CHECK (role IN (
    'super_admin', 'account_manager', 'billing',
    'support_l1', 'support_l2', 'support_l3'
  )),
  CONSTRAINT admin_staff_email_lower CHECK (email = lower(email))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_staff_email
  ON public.admin_staff (email);

-- ------------------------------------------------------------
-- 2. Client operations profile — one row per workspace, created lazily
--    the first time an operator assigns, tags or pins it.
--
-- `lifecycle_override` is NULL almost always: the stage is derived from
-- onboarding, subscription and health on read. An override exists for
-- the states nothing in the data can express ("lead", "archived") and is
-- a CLASSIFICATION for the portfolio — it does not suspend anybody.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_accounts (
  account_id          UUID PRIMARY KEY
                        REFERENCES public.accounts (id) ON DELETE CASCADE,
  lifecycle_override  TEXT,
  lifecycle_reason    TEXT,
  account_manager_id  UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  backup_manager_id   UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  support_lead_id     UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  service_tier        TEXT NOT NULL DEFAULT 'standard',
  tags                TEXT[] NOT NULL DEFAULT '{}',
  updated_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_accounts_lifecycle_check CHECK (
    lifecycle_override IS NULL OR lifecycle_override IN (
      'lead', 'onboarding', 'active', 'attention',
      'suspended', 'churned', 'archived'
    )
  ),
  CONSTRAINT client_accounts_tier_check CHECK (
    service_tier IN ('standard', 'priority', 'enterprise')
  )
);

CREATE INDEX IF NOT EXISTS idx_client_accounts_manager
  ON public.client_accounts (account_manager_id)
  WHERE account_manager_id IS NOT NULL;

-- Every pin and unpin, with its reason (C360-022: "state transitions
-- controlled, with audit and reasons").
CREATE TABLE IF NOT EXISTS public.client_lifecycle_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_lifecycle_events_account
  ON public.client_lifecycle_events (account_id, created_at DESC);

-- ------------------------------------------------------------
-- 3. Notes and follow-up tasks (C360-023).
-- `author` / `created_by` are text so a row survives the staff member
-- who wrote it being deleted — the FK is a convenience, the name is the
-- record.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  pinned           BOOLEAN NOT NULL DEFAULT FALSE,
  author_staff_id  UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  author           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_notes_body_len CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS idx_client_notes_account
  ON public.client_notes (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  due_on             DATE,
  assignee_staff_id  UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  completed_by       TEXT,
  CONSTRAINT client_tasks_status_check CHECK (status IN ('open', 'done')),
  CONSTRAINT client_tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS idx_client_tasks_open
  ON public.client_tasks (assignee_staff_id, due_on)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_client_tasks_account
  ON public.client_tasks (account_id, created_at DESC);

-- ------------------------------------------------------------
-- 4. Support desk (C360-032).
--
-- A ticket's `account_id` is SET NULL rather than CASCADE, and the name
-- is snapshotted: "what went wrong for the customer who left" is a
-- question support asks after the workspace is gone.
--
-- SLA due times are written at creation (and on a severity change) from
-- the targets in admin_settings, so changing a target later does not
-- silently move the goalposts on tickets already open.
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number_seq START 1001;

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                 BIGINT NOT NULL
                           DEFAULT nextval('public.support_ticket_number_seq'),
  account_id             UUID REFERENCES public.accounts (id) ON DELETE SET NULL,
  account_name           TEXT,
  subject                TEXT NOT NULL,
  description            TEXT,
  source                 TEXT NOT NULL DEFAULT 'staff',
  category               TEXT NOT NULL DEFAULT 'other',
  severity               TEXT NOT NULL DEFAULT 'normal',
  tier                   TEXT NOT NULL DEFAULT 'L1',
  status                 TEXT NOT NULL DEFAULT 'open',
  assignee_staff_id      UUID REFERENCES public.admin_staff (id) ON DELETE SET NULL,
  requester              TEXT,
  incident_key           TEXT,
  first_response_due_at  TIMESTAMPTZ,
  resolution_due_at      TIMESTAMPTZ,
  first_responded_at     TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  resolution             TEXT,
  created_by             TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_source_check CHECK (source IN (
    'staff', 'phone', 'email', 'whatsapp', 'monitoring',
    'onboarding', 'portal', 'mobile'
  )),
  CONSTRAINT support_tickets_category_check CHECK (category IN (
    'onboarding', 'meta_channel', 'messaging', 'templates', 'ai',
    'billing', 'api_integration', 'account', 'other'
  )),
  CONSTRAINT support_tickets_severity_check CHECK (
    severity IN ('low', 'normal', 'high', 'critical')
  ),
  CONSTRAINT support_tickets_tier_check CHECK (
    tier IN ('L1', 'L2', 'L3', 'billing')
  ),
  CONSTRAINT support_tickets_status_check CHECK (status IN (
    'open', 'in_progress', 'waiting_customer', 'escalated',
    'resolved', 'closed'
  )),
  CONSTRAINT support_tickets_subject_len CHECK (char_length(subject) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_number
  ON public.support_tickets (number);
CREATE INDEX IF NOT EXISTS idx_support_tickets_account
  ON public.support_tickets (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_open
  ON public.support_tickets (status, severity, created_at)
  WHERE status NOT IN ('resolved', 'closed');
-- One open ticket per (workspace, incident) — opening a ticket from the
-- incident monitor twice should find the first, not file a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_open_incident
  ON public.support_tickets (account_id, incident_key)
  WHERE incident_key IS NOT NULL AND status NOT IN ('resolved', 'closed');

-- The change log of a ticket: comments, status moves, reassignment,
-- escalation, diagnostic snapshots and the resolution. Append-only.
CREATE TABLE IF NOT EXISTS public.support_ticket_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES public.support_tickets (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  body        TEXT,
  from_value  TEXT,
  to_value    TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_ticket_events_kind_check CHECK (kind IN (
    'created', 'comment', 'status', 'assign', 'severity', 'tier',
    'diagnostic', 'resolution'
  ))
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket
  ON public.support_ticket_events (ticket_id, created_at);

-- ------------------------------------------------------------
-- 5. Converse AI catalog (C360-011) — branded aliases 01–06.
--
-- The customer-facing name lives here alongside the INTERNAL mapping
-- (provider / model / fallback). The mapping columns must never reach a
-- customer API. Seeded unmapped: a NULL model means "not routed yet",
-- which the panel shows as such rather than guessing.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_model_catalog (
  alias              TEXT PRIMARY KEY,
  position           INTEGER NOT NULL,
  name               TEXT NOT NULL,
  tagline            TEXT NOT NULL,
  description        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT FALSE,
  plans              TEXT[] NOT NULL DEFAULT '{}',
  provider           TEXT,
  model              TEXT,
  fallback_provider  TEXT,
  fallback_model     TEXT,
  max_output_tokens  INTEGER,
  tool_policy        TEXT NOT NULL DEFAULT 'none',
  prompt_version     TEXT,
  notes              TEXT,
  updated_by         TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_catalog_alias_format CHECK (alias ~ '^converse-[0-9]{2}$'),
  CONSTRAINT ai_model_catalog_provider_check CHECK (
    provider IS NULL OR provider IN ('gemini', 'openai', 'anthropic')
  ),
  CONSTRAINT ai_model_catalog_fallback_check CHECK (
    fallback_provider IS NULL OR fallback_provider IN ('gemini', 'openai', 'anthropic')
  ),
  CONSTRAINT ai_model_catalog_tool_policy_check CHECK (
    tool_policy IN ('none', 'read_only', 'permissioned')
  )
);

INSERT INTO public.ai_model_catalog (alias, position, name, tagline, description, tool_policy)
VALUES
  ('converse-01', 1, 'Listen',  'Intent and active listening',
     'General customer support: understands what the customer is asking and answers from the knowledge base.', 'read_only'),
  ('converse-02', 2, 'Think',   'Advanced reasoning',
     'Multi-step reasoning for complex support queries.', 'read_only'),
  ('converse-03', 3, 'Swift',   'Low-latency, high-volume answers',
     'Fast replies for FAQs and high message volumes.', 'none'),
  ('converse-04', 4, 'Engage',  'Sales qualification',
     'Product enquiries, lead qualification and CRM lead workflows.', 'read_only'),
  ('converse-05', 5, 'Connect', 'Multilingual conversations',
     'Regional and multilingual audiences, subject to tested language coverage.', 'none'),
  ('converse-06', 6, 'Flow',    'Permissioned actions',
     'Business workflows that call tools and controlled CRM actions.', 'permissioned')
ON CONFLICT (alias) DO NOTHING;

-- ------------------------------------------------------------
-- 6. Control Center settings — SLA targets, watch windows, thresholds.
-- Key/value so a new setting is code, not a migration. Defaults live
-- in apps/admin-panel/lib/settings.ts; an absent row means "default".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 7. Lock everything down. Owner connection only.
-- ------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'admin_staff', 'client_accounts', 'client_lifecycle_events',
    'client_notes', 'client_tasks', 'support_tickets',
    'support_ticket_events', 'ai_model_catalog', 'admin_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.support_ticket_number_seq FROM anon, authenticated;
