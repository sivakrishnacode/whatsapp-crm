-- ============================================================
-- 082_app_connections.sql — OAuth connections to third-party apps.
--
-- Design: docs/app-connections.md. Read it before changing this table.
--
-- WHAT THIS IS
--
--   One row per (workspace, provider, external account): the workspace
--   connected ops@acme.com to Google, and here are the encrypted tokens
--   and the scopes they granted. Automation steps of type `app_action`
--   reference a row by id.
--
-- ⚠️ RLS IS ON WITH ZERO POLICIES, AND RIGHTS ARE REVOKED. THIS IS THE
--    WHOLE SECURITY MODEL OF THE TABLE.
--
--   RLS is ROW-level, not column-level. Any policy that lets a browser
--   select its own workspace's rows also hands `refresh_token` to
--   PostgREST — and a Google refresh token is a durable credential for
--   somebody's mailbox and calendar, not a session artifact. There is no
--   "read everything except two columns" policy to write.
--
--   So nothing may read this table except an owner connection, which is
--   how apps/api connects. The API returns a redacted projection (id,
--   provider, display_name, scopes, status) and never the token columns.
--   Same shape and same reasoning as `admin_audit_log` in migration 073.
--
--   The corollary: DO NOT add a policy here to make a browser feature
--   easier. Add an endpoint.
--
-- WHY ONE ROW PER GOOGLE ACCOUNT, NOT PER SERVICE
--
--   `scopes` is an array because Google consent is incremental: a
--   workspace may connect for Sheets today and grant Calendar next
--   month, on the same underlying account. One row that accumulates
--   scopes matches what Google actually stores on its side. Modelling it
--   as one row per service would mean four rows sharing one refresh
--   token, and four places to invalidate when the user revokes.
--
-- WHY `status` EXISTS SEPARATELY FROM "has a token"
--
--   A refresh token can be revoked by the user at myaccount.google.com,
--   expire (Google expires refresh tokens for apps still in Testing
--   after 7 days), or be invalidated by a password change. The API
--   discovers this as an `invalid_grant` at refresh time, mid-automation.
--   Recording `needs_reauth` turns that into something the editor can
--   warn about BEFORE the run and the integrations page can show as a
--   distinct state — an expired grant with live automations pointing at
--   it is an incident, not a blank slate.
--
-- NO ACCOUNT-LEVEL UNIQUE CONSTRAINT ON `provider`
--
--   A workspace may legitimately connect two Google accounts (sales@ and
--   support@) and point different automations at each. Uniqueness is on
--   the external account, which is what "the same connection" means.
-- ============================================================

create table if not exists public.app_connections (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,

  -- 'google' today. The connector registry in the API is the authority
  -- on valid values; a check constraint here would mean a migration per
  -- provider for no benefit the registry does not already give.
  provider            text not null,

  -- Stable provider-side id ('sub' for Google). NOT the email: an email
  -- can be changed on the provider side, which would silently mint a
  -- second connection for the same account.
  external_account_id text not null,

  -- What a human recognises in the UI, usually the email address.
  display_name        text,

  -- Granted OAuth scopes. Grows on incremental consent. The API checks
  -- an action's required scopes against this before running it, so a
  -- missing scope becomes a re-consent prompt rather than a 403 from
  -- Google mid-automation.
  scopes              text[] not null default '{}',

  -- Both AES-256-GCM via common/security/encryption.util.ts.
  -- refresh_token is nullable because Google returns it on FIRST consent
  -- only; a re-consent that omits it must leave the stored one intact.
  access_token        text not null,
  refresh_token       text,
  token_expires_at    timestamptz,

  status              text not null default 'active'
                        check (status in ('active', 'needs_reauth', 'revoked')),
  last_error          text,

  -- Who clicked Connect. Nullable and NOT a foreign key on purpose: the
  -- connection belongs to the workspace, and it must outlive the
  -- teammate who set it up leaving.
  created_by          uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (account_id, provider, external_account_id)
);

create index if not exists idx_app_connections_account
  on public.app_connections(account_id);

-- Partial: the only scheduled read is "which grants are about to expire",
-- and rows without an expiry (or already dead) are not candidates.
create index if not exists idx_app_connections_expiring
  on public.app_connections(token_expires_at)
  where token_expires_at is not null and status = 'active';

alter table public.app_connections enable row level security;
revoke all on public.app_connections from anon, authenticated;

comment on table public.app_connections is
  'OAuth connections to third-party apps (Google Sheets/Gmail/Calendar/Meet). '
  'API-only: RLS is on with no policies and rights are revoked, because RLS '
  'cannot hide the token columns from a browser select. See docs/app-connections.md.';
