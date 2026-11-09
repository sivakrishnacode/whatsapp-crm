import 'server-only';

import { Prisma } from '@prisma/client';
import { cache } from 'react';

import { getFleetHealth, type AccountHealth } from '@/lib/health/evidence';
import { deriveLifecycle, type LifecycleStage } from '@/lib/lifecycle';
import { prisma } from '@/lib/prisma';
import {
  MRR_EXPR,
  type BillingCycle,
  type SubscriptionStatus,
} from '@/lib/queries/sql';

/**
 * The client roster — every workspace with what the Control Center needs to
 * list, filter, sort and triage it: plan, owner, the ops profile (manager,
 * tier, pin), open tickets, last activity, health and lifecycle.
 *
 * ONE memoised read shared by the directory, overview, portfolio, onboarding
 * queue and incident monitor, so the same workspace cannot be "critical" on
 * one screen and "healthy" on the next within a render.
 *
 * Filtering and sorting happen in memory on the server after this read (see
 * `filterRoster`). That is server-side pagination in the sense the handoff
 * means — the browser receives one page — and it is the right trade at this
 * fleet size: health and lifecycle are computed in TypeScript, so filtering
 * on them in SQL would mean restating the rules there. If the fleet grows
 * past a few thousand workspaces, persist the evaluated health
 * (metric_snapshots) and move the filter into SQL.
 *
 * ⚠️ Prisma bypasses RLS: this is deliberately cross-tenant (the operations
 * panel). Anything that narrows it to one client passes an account id the
 * page took from its own URL and re-validated, never a client-supplied list.
 */

type RosterSqlRow = {
  accountId: string;
  name: string;
  createdAt: Date;
  ownerUserId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  planName: string | null;
  planDisplayName: string | null;
  subStatus: SubscriptionStatus | null;
  billingCycle: BillingCycle | null;
  mrr: number;
  periodEnd: Date | null;
  trialEndAt: Date | null;
  managerId: string | null;
  managerName: string | null;
  backupManagerId: string | null;
  backupManagerName: string | null;
  supportLeadId: string | null;
  supportLeadName: string | null;
  serviceTier: string;
  tags: string[];
  lifecycleOverride: string | null;
  lifecycleReason: string | null;
  openTickets: number;
  criticalTickets: number;
  lastMessageAt: Date | null;
  conversations: number;
  phoneNumberId: string | null;
  wabaId: string | null;
  memberEmails: string;
  members: number;
};

export type RosterEntry = RosterSqlRow & {
  health: AccountHealth;
  lifecycle: { stage: LifecycleStage; pinned: boolean; because: string };
};

const ROSTER_SQL = Prisma.sql`
  select
    a.id as "accountId",
    a.name as "name",
    a.created_at as "createdAt",
    a.owner_user_id as "ownerUserId",
    ou.email as "ownerEmail",
    op.full_name as "ownerName",
    pl.name as "planName",
    pl.display_name as "planDisplayName",
    s.status as "subStatus",
    s.billing_cycle as "billingCycle",
    (${MRR_EXPR})::float8 as "mrr",
    s.current_period_end as "periodEnd",
    s.trial_end_at as "trialEndAt",
    ca.account_manager_id as "managerId",
    am.full_name as "managerName",
    ca.backup_manager_id as "backupManagerId",
    bm.full_name as "backupManagerName",
    ca.support_lead_id as "supportLeadId",
    sl.full_name as "supportLeadName",
    coalesce(ca.service_tier, 'standard') as "serviceTier",
    coalesce(ca.tags, '{}') as "tags",
    ca.lifecycle_override as "lifecycleOverride",
    ca.lifecycle_reason as "lifecycleReason",
    coalesce(t.open, 0) as "openTickets",
    coalesce(t.critical, 0) as "criticalTickets",
    cv.last_message_at as "lastMessageAt",
    coalesce(cv.n, 0) as "conversations",
    wc.phone_number_id as "phoneNumberId",
    wc.waba_id as "wabaId",
    coalesce(me.emails, '') as "memberEmails",
    coalesce(me.n, 0) as "members"
  from accounts a
  join auth.users ou on ou.id = a.owner_user_id
  left join profiles op on op.user_id = a.owner_user_id
  -- A workspace's plan is its OWNER's subscription (CLAUDE.md, billing).
  left join user_subscriptions s on s.user_id = a.owner_user_id
  left join subscription_plans pl on pl.id = s.plan_id
  left join client_accounts ca on ca.account_id = a.id
  left join admin_staff am on am.id = ca.account_manager_id
  left join admin_staff bm on bm.id = ca.backup_manager_id
  left join admin_staff sl on sl.id = ca.support_lead_id
  left join whatsapp_config wc on wc.account_id = a.id
  left join (
    select account_id,
      (count(*) filter (where status not in ('resolved','closed')))::int as open,
      (count(*) filter (
        where status not in ('resolved','closed') and severity = 'critical'
      ))::int as critical
    from support_tickets
    where account_id is not null
    group by account_id
  ) t on t.account_id = a.id
  left join (
    select account_id, max(last_message_at) as last_message_at, (count(*))::int as n
    from conversations
    group by account_id
  ) cv on cv.account_id = a.id
  left join (
    select m.account_id, string_agg(lower(u.email), ' ') as emails, (count(*))::int as n
    from account_members m
    join auth.users u on u.id = m.user_id
    group by m.account_id
  ) me on me.account_id = a.id
  order by a.created_at desc
`;

/** Every workspace, with health and lifecycle. Memoised per render pass. */
export const getRoster = cache(async (): Promise<RosterEntry[]> => {
  const [rows, fleet] = await Promise.all([
    prisma.$queryRaw<RosterSqlRow[]>(ROSTER_SQL),
    getFleetHealth(),
  ]);
  const healthById = new Map(fleet.map((h) => [h.accountId, h]));

  return rows.flatMap((row) => {
    const health = healthById.get(row.accountId);
    // Created between the two reads — it will be on the next render.
    if (!health) return [];
    return [
      {
        ...row,
        health,
        lifecycle: deriveLifecycle({
          override: row.lifecycleOverride,
          subscriptionStatus: row.subStatus,
          onboardingCompleted:
            health.evidence.setup.onboardingCompletedAt !== null,
          channelLive: health.channelLive,
          health: health.overall,
        }),
      },
    ];
  });
});

/** One workspace's roster entry. */
export async function getRosterEntry(
  accountId: string
): Promise<RosterEntry | null> {
  const roster = await getRoster();
  return roster.find((entry) => entry.accountId === accountId) ?? null;
}

/**
 * Free-text match across everything an operator might paste: workspace name,
 * owner or any member email, owner name, WABA id, phone number id, tenant id
 * (full or prefix), tags.
 */
export function matchesQuery(entry: RosterEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.name,
    entry.ownerEmail,
    entry.ownerName,
    entry.memberEmails,
    entry.wabaId,
    entry.phoneNumberId,
    entry.accountId,
    entry.tags.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
