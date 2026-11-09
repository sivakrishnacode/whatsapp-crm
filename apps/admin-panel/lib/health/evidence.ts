import 'server-only';

import { Prisma } from '@prisma/client';
import { cache } from 'react';

import {
  computeCompletion,
  evaluateHealth,
  overallHealth,
  type CompletionItem,
  type HealthCheck,
  type HealthEvidence,
  type HealthState,
} from '@/lib/health/rules';
import { prisma } from '@/lib/prisma';
import { getSettings } from '@/lib/settings-store';

/**
 * Account health — the evidence.
 *
 * ONE set-based query reads what the rules judge, for one workspace or the
 * whole fleet: every per-table aggregate is a grouped CTE joined back to
 * `accounts`, never a correlated subquery per row, so the fleet scan costs a
 * handful of passes regardless of how many workspaces there are.
 *
 * ⚠️ No secret column is selected — not `access_token`, not
 * `secret_encrypted`, not a webhook secret, not even to test its length.
 * Health is judged from status columns and timestamps the API's own jobs
 * write. The handoff is explicit: no role may see a plaintext secret, and the
 * surest way to keep that true is never to load one.
 *
 * ⚠️ Prisma connects as the database owner, so RLS scopes none of this; the
 * `accountIds` filter is the only scoping, and the fleet variant is
 * cross-tenant on purpose (this is the operations panel).
 */

type EvidenceRow = {
  accountId: string;
  // whatsapp_config
  waStatus: string | null;
  waPhoneNumberId: string | null;
  waWabaId: string | null;
  waConnectionMethod: string | null;
  waCoexistence: boolean | null;
  waConnectedAt: Date | null;
  waRegisteredAt: Date | null;
  waSubscribedAppsAt: Date | null;
  waLastRegistrationError: string | null;
  waTokenExpiresAt: Date | null;
  waLimitsSyncedAt: Date | null;
  waTier: string | null;
  waQuality: string | null;
  waUpdatedAt: Date | null;
  // messages
  out7d: number;
  failed7d: number;
  topErrorCode: number | null;
  topErrorTitle: string | null;
  topErrorCount: number | null;
  lastDeliveredAt: Date | null;
  // templates
  tplTotal: number;
  tplApproved: number;
  tplRejected: number;
  tplPaused: number;
  tplPending: number;
  tplRed: number;
  tplUpdatedAt: Date | null;
  // instagram
  igStatus: string | null;
  igUsername: string | null;
  igLastError: string | null;
  igTokenExpiresAt: Date | null;
  igUpdatedAt: Date | null;
  // web
  webStatus: string | null;
  webLastSeenAt: Date | null;
  webLastError: string | null;
  webUpdatedAt: Date | null;
  // webhooks
  hooksActive: number;
  hooksLastDeliveryAt: Date | null;
  // google
  hasGoogle: boolean;
  gLastOkAt: Date | null;
  gLastErrorAt: Date | null;
  gLastError: string | null;
  gScriptVersion: number | null;
  // ecommerce
  ecoTotal: number;
  ecoErrored: number;
  ecoDisconnected: number;
  ecoLastSyncAt: Date | null;
  // api keys
  keysActive: number;
  keysExpiringSoon: number;
  keysLastUsedAt: Date | null;
  // ai
  creditMode: 'platform' | 'byok' | null;
  balance: number | null;
  walletUpdatedAt: Date | null;
  activeAgents: number;
  autoReplyAgents: number;
  // billing
  subStatus: HealthEvidence['billing']['status'];
  trialEndAt: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  subUpdatedAt: Date | null;
  // setup
  onboardingCompletedAt: Date | null;
  members: number;
  pendingInvites: number;
};

function evidenceQuery(accountIds: string[] | null): Prisma.Sql {
  const scope =
    accountIds === null
      ? Prisma.sql`true`
      : Prisma.sql`a.id = any(${accountIds}::uuid[])`;

  return Prisma.sql`
    with acc as (
      select a.id, a.owner_user_id from accounts a where ${scope}
    ),
    msg7 as (
      select c.account_id,
        (count(*) filter (where m.sender_type in ('agent','bot')))::int as out7d,
        (count(*) filter (where m.sender_type in ('agent','bot') and m.status = 'failed'))::int as failed7d
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.account_id in (select id from acc)
        and m.deleted_at is null
        and m.created_at >= now() - interval '7 days'
      group by c.account_id
    ),
    -- The most frequent Meta error code among the week's failures. The code
    -- lives in messages.metadata.error (commit 8cf02de keeps Meta's reason).
    err as (
      select distinct on (account_id) account_id, code, title, n
      from (
        select c.account_id,
          (m.metadata->'error'->>'code')::int as code,
          max(m.metadata->'error'->>'title') as title,
          (count(*))::int as n
        from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id in (select id from acc)
          and m.status = 'failed'
          and m.created_at >= now() - interval '7 days'
          and (m.metadata->'error'->>'code') ~ '^[0-9]{1,9}$'
        group by 1, 2
      ) x
      order by account_id, n desc, code
    ),
    deliv as (
      select c.account_id, max(m.created_at) as last_delivered_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.account_id in (select id from acc)
        and m.sender_type in ('agent','bot')
        and m.status in ('delivered','read')
      group by c.account_id
    ),
    -- DRAFT is a local draft never sent to Meta, so it is not a template
    -- as far as health is concerned.
    tpl as (
      select account_id,
        (count(*) filter (where upper(coalesce(status,'')) <> 'DRAFT'))::int as total,
        (count(*) filter (where upper(status) = 'APPROVED'))::int as approved,
        (count(*) filter (where upper(status) = 'REJECTED'))::int as rejected,
        (count(*) filter (where upper(status) in ('PAUSED','DISABLED')))::int as paused,
        (count(*) filter (where upper(status) in ('PENDING','IN_APPEAL','PENDING_DELETION')))::int as pending,
        (count(*) filter (where upper(coalesce(quality_score,'')) = 'RED'))::int as red,
        max(updated_at) as updated_at
      from message_templates
      where account_id in (select id from acc)
      group by account_id
    ),
    hooks as (
      select account_id,
        (count(*) filter (where is_active))::int as active,
        max(last_delivery_at) as last_delivery_at
      from webhook_endpoints
      where account_id in (select id from acc)
      group by account_id
    ),
    keys as (
      select account_id,
        (count(*) filter (where revoked_at is null and (expires_at is null or expires_at > now())))::int as active,
        (count(*) filter (where revoked_at is null and expires_at between now() and now() + interval '7 days'))::int as expiring,
        max(last_used_at) as last_used_at
      from api_keys
      where account_id in (select id from acc)
      group by account_id
    ),
    eco as (
      select account_id,
        (count(*))::int as total,
        (count(*) filter (where sync_error is not null))::int as errored,
        (count(*) filter (where status <> 'connected'))::int as disconnected,
        max(last_sync_at) as last_sync_at
      from ecommerce_integrations
      where account_id in (select id from acc)
      group by account_id
    ),
    agents as (
      select account_id,
        (count(*) filter (where is_active))::int as active,
        (count(*) filter (where is_active and auto_reply_enabled))::int as auto_reply
      from ai_agents
      where account_id in (select id from acc)
      group by account_id
    ),
    mem as (
      select account_id, (count(*))::int as n
      from account_members
      where account_id in (select id from acc)
      group by account_id
    ),
    inv as (
      select account_id, (count(*))::int as n
      from account_invitations
      where account_id in (select id from acc)
        and accepted_at is null and expires_at > now()
      group by account_id
    )
    select
      acc.id as "accountId",
      wc.status as "waStatus",
      wc.phone_number_id as "waPhoneNumberId",
      wc.waba_id as "waWabaId",
      wc.connection_method as "waConnectionMethod",
      wc.coexistence as "waCoexistence",
      wc.connected_at as "waConnectedAt",
      wc.registered_at as "waRegisteredAt",
      wc.subscribed_apps_at as "waSubscribedAppsAt",
      wc.last_registration_error as "waLastRegistrationError",
      wc.token_expires_at as "waTokenExpiresAt",
      wc.limits_synced_at as "waLimitsSyncedAt",
      wc.messaging_limit_tier as "waTier",
      wc.quality_rating as "waQuality",
      wc.updated_at as "waUpdatedAt",
      coalesce(msg7.out7d, 0) as "out7d",
      coalesce(msg7.failed7d, 0) as "failed7d",
      err.code as "topErrorCode",
      err.title as "topErrorTitle",
      err.n as "topErrorCount",
      deliv.last_delivered_at as "lastDeliveredAt",
      coalesce(tpl.total, 0) as "tplTotal",
      coalesce(tpl.approved, 0) as "tplApproved",
      coalesce(tpl.rejected, 0) as "tplRejected",
      coalesce(tpl.paused, 0) as "tplPaused",
      coalesce(tpl.pending, 0) as "tplPending",
      coalesce(tpl.red, 0) as "tplRed",
      tpl.updated_at as "tplUpdatedAt",
      ig.status as "igStatus",
      ig.ig_username as "igUsername",
      ig.last_error as "igLastError",
      ig.token_expires_at as "igTokenExpiresAt",
      ig.updated_at as "igUpdatedAt",
      web.status as "webStatus",
      web.last_seen_at as "webLastSeenAt",
      web.last_error as "webLastError",
      web.updated_at as "webUpdatedAt",
      coalesce(hooks.active, 0) as "hooksActive",
      hooks.last_delivery_at as "hooksLastDeliveryAt",
      (g.id is not null) as "hasGoogle",
      g.last_ok_at as "gLastOkAt",
      g.last_error_at as "gLastErrorAt",
      g.last_error as "gLastError",
      g.script_version as "gScriptVersion",
      coalesce(eco.total, 0) as "ecoTotal",
      coalesce(eco.errored, 0) as "ecoErrored",
      coalesce(eco.disconnected, 0) as "ecoDisconnected",
      eco.last_sync_at as "ecoLastSyncAt",
      coalesce(keys.active, 0) as "keysActive",
      coalesce(keys.expiring, 0) as "keysExpiringSoon",
      keys.last_used_at as "keysLastUsedAt",
      ac.credit_mode as "creditMode",
      w.balance as "balance",
      w.updated_at as "walletUpdatedAt",
      coalesce(agents.active, 0) as "activeAgents",
      coalesce(agents.auto_reply, 0) as "autoReplyAgents",
      s.status as "subStatus",
      s.trial_end_at as "trialEndAt",
      s.current_period_end as "periodEnd",
      s.cancel_at_period_end as "cancelAtPeriodEnd",
      s.updated_at as "subUpdatedAt",
      ob.completed_at as "onboardingCompletedAt",
      coalesce(mem.n, 0) as "members",
      coalesce(inv.n, 0) as "pendingInvites"
    from acc
    left join whatsapp_config wc on wc.account_id = acc.id
    left join instagram_config ig on ig.account_id = acc.id
    left join web_config web on web.account_id = acc.id
    left join google_script_connections g on g.account_id = acc.id
    left join ai_configs ac on ac.account_id = acc.id
    left join ai_credit_wallets w on w.account_id = acc.id
    -- A workspace's plan is its OWNER's subscription (see CLAUDE.md).
    left join user_subscriptions s on s.user_id = acc.owner_user_id
    left join account_onboarding ob on ob.account_id = acc.id
    left join msg7 on msg7.account_id = acc.id
    left join err on err.account_id = acc.id
    left join deliv on deliv.account_id = acc.id
    left join tpl on tpl.account_id = acc.id
    left join hooks on hooks.account_id = acc.id
    left join keys on keys.account_id = acc.id
    left join eco on eco.account_id = acc.id
    left join agents on agents.account_id = acc.id
    left join mem on mem.account_id = acc.id
    left join inv on inv.account_id = acc.id
  `;
}

function toEvidence(r: EvidenceRow): HealthEvidence {
  return {
    accountId: r.accountId,
    wa: r.waStatus
      ? {
          status: r.waStatus,
          phoneNumberId: r.waPhoneNumberId ?? '',
          wabaId: r.waWabaId,
          connectionMethod: r.waConnectionMethod ?? 'manual',
          coexistence: Boolean(r.waCoexistence),
          connectedAt: r.waConnectedAt,
          registeredAt: r.waRegisteredAt,
          subscribedAppsAt: r.waSubscribedAppsAt,
          lastRegistrationError: r.waLastRegistrationError,
          tokenExpiresAt: r.waTokenExpiresAt,
          limitsSyncedAt: r.waLimitsSyncedAt,
          tier: r.waTier,
          quality: r.waQuality,
          updatedAt: r.waUpdatedAt,
        }
      : null,
    out7d: r.out7d,
    failed7d: r.failed7d,
    topErrorCode: r.topErrorCode,
    topErrorTitle: r.topErrorTitle,
    topErrorCount: r.topErrorCount ?? 0,
    lastDeliveredAt: r.lastDeliveredAt,
    everDelivered: r.lastDeliveredAt !== null,
    templates: {
      total: r.tplTotal,
      approved: r.tplApproved,
      rejected: r.tplRejected,
      paused: r.tplPaused,
      pending: r.tplPending,
      redQuality: r.tplRed,
      updatedAt: r.tplUpdatedAt,
    },
    ig: r.igStatus
      ? {
          status: r.igStatus,
          username: r.igUsername,
          lastError: r.igLastError,
          tokenExpiresAt: r.igTokenExpiresAt,
          updatedAt: r.igUpdatedAt,
        }
      : null,
    web: r.webStatus
      ? {
          status: r.webStatus,
          lastSeenAt: r.webLastSeenAt,
          lastError: r.webLastError,
          updatedAt: r.webUpdatedAt,
        }
      : null,
    webhooks: { active: r.hooksActive, lastDeliveryAt: r.hooksLastDeliveryAt },
    google: r.hasGoogle
      ? {
          lastOkAt: r.gLastOkAt,
          lastErrorAt: r.gLastErrorAt,
          lastError: r.gLastError,
          scriptVersion: r.gScriptVersion,
        }
      : null,
    ecommerce: {
      total: r.ecoTotal,
      errored: r.ecoErrored,
      disconnected: r.ecoDisconnected,
      lastSyncAt: r.ecoLastSyncAt,
    },
    apiKeys: {
      active: r.keysActive,
      expiringSoon: r.keysExpiringSoon,
      lastUsedAt: r.keysLastUsedAt,
    },
    ai: {
      creditMode: r.creditMode,
      balance: r.balance,
      walletUpdatedAt: r.walletUpdatedAt,
      activeAgents: r.activeAgents,
      autoReplyAgents: r.autoReplyAgents,
    },
    billing: {
      status: r.subStatus,
      trialEndAt: r.trialEndAt,
      periodEnd: r.periodEnd,
      cancelAtPeriodEnd: Boolean(r.cancelAtPeriodEnd),
      updatedAt: r.subUpdatedAt,
    },
    setup: {
      onboardingCompletedAt: r.onboardingCompletedAt,
      members: r.members,
      pendingInvites: r.pendingInvites,
    },
  };
}

export type AccountHealth = {
  accountId: string;
  evidence: HealthEvidence;
  checks: HealthCheck[];
  overall: HealthState;
  completion: { percent: number; items: CompletionItem[] };
  /** When these rules ran. Every screen shows it. */
  evaluatedAt: Date;
  /** Any of WhatsApp / Instagram / web live — used by lifecycle. */
  channelLive: boolean;
};

async function load(accountIds: string[] | null): Promise<AccountHealth[]> {
  const [rows, settings] = await Promise.all([
    prisma.$queryRaw<EvidenceRow[]>(evidenceQuery(accountIds)),
    getSettings(),
  ]);
  const now = new Date();
  const thresholds = {
    staleHours: settings.healthStaleHours,
    lowCreditThreshold: settings.lowCreditThreshold,
    deliveryAttentionPct: settings.deliveryAttentionPct,
    deliveryCriticalPct: settings.deliveryCriticalPct,
  };

  return rows.map((row) => {
    const evidence = toEvidence(row);
    const checks = evaluateHealth(evidence, now, thresholds);
    return {
      accountId: row.accountId,
      evidence,
      checks,
      overall: overallHealth(checks),
      completion: computeCompletion(evidence),
      evaluatedAt: now,
      channelLive:
        evidence.wa?.status === 'connected' ||
        evidence.ig?.status === 'connected' ||
        evidence.web?.status === 'connected',
    };
  });
}

/** Every workspace. Memoised per render pass. */
export const getFleetHealth = cache(async (): Promise<AccountHealth[]> =>
  load(null)
);

/** One workspace, or null if it does not exist. */
export const getAccountHealth = cache(
  async (accountId: string): Promise<AccountHealth | null> => {
    const [row] = await load([accountId]);
    return row ?? null;
  }
);

/** A subset (a page of the directory). */
export async function getHealthFor(
  accountIds: string[]
): Promise<Map<string, AccountHealth>> {
  if (accountIds.length === 0) return new Map();
  const rows = await load(accountIds);
  return new Map(rows.map((row) => [row.accountId, row]));
}
