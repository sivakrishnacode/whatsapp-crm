import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  MRR_EXPR,
  SUBSCRIBER_COLUMNS,
  SUBSCRIBER_FROM,
  type SubscriberRow,
  type SubscriptionStatus,
} from '@/lib/queries/sql';

export type SubscriberSort = 'recent' | 'renewal' | 'value' | 'name';

export type SubscriberListParams = {
  q?: string;
  status?: SubscriptionStatus | 'all';
  plan?: string;
  sort?: SubscriberSort;
  page?: number;
  perPage?: number;
};

export type SubscriberList = {
  rows: SubscriberRow[];
  total: number;
  /** MRR of the filtered set, not of the page — a page total would mislead. */
  mrr: number;
  page: number;
  perPage: number;
  pageCount: number;
};

const ORDER_BY: Record<SubscriberSort, Prisma.Sql> = {
  recent: Prisma.sql`order by s.created_at desc nulls last`,
  renewal: Prisma.sql`order by s.current_period_end asc nulls last`,
  value: Prisma.sql`order by (${MRR_EXPR}) desc, s.created_at desc nulls last`,
  name: Prisma.sql`order by coalesce(p.full_name, u.email) asc nulls last`,
};

function buildWhere(params: SubscriberListParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(Prisma.sql`(
      u.email ilike ${like}
      or p.full_name ilike ${like}
      or a.name ilike ${like}
    )`);
  }

  if (params.status && params.status !== 'all') {
    // The parameter arrives as text, so it needs an explicit cast to compare
    // against the enum column.
    conditions.push(
      Prisma.sql`s.status = ${params.status}::subscription_status_enum`
    );
  }

  if (params.plan) {
    conditions.push(Prisma.sql`pl.name = ${params.plan}`);
  }

  return conditions.length
    ? Prisma.sql`where ${Prisma.join(conditions, ' and ')}`
    : Prisma.empty;
}

export async function listSubscribers(
  params: SubscriberListParams = {}
): Promise<SubscriberList> {
  const perPage = Math.min(Math.max(params.perPage ?? 25, 5), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);
  const orderBy = ORDER_BY[params.sort ?? 'recent'];

  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
      select ${SUBSCRIBER_COLUMNS}
      ${SUBSCRIBER_FROM}
      ${where}
      ${orderBy}
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    prisma.$queryRaw<{ total: number; mrr: number }[]>(Prisma.sql`
      select
        (count(*))::int as "total",
        coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
      ${SUBSCRIBER_FROM}
      ${where}
    `),
  ]);

  return {
    rows,
    total: totals.total,
    mrr: totals.mrr,
    page,
    perPage,
    pageCount: Math.max(Math.ceil(totals.total / perPage), 1),
  };
}

export type PlanLimits = {
  maxContacts: number;
  maxMessagesMonthly: number;
  maxBroadcastsMonthly: number;
  maxFlows: number | null;
  maxTeamMembers: number;
  maxStorageMb: number;
  trialDays: number | null;
  features: unknown;
};

export type UsageSnapshot = {
  periodStart: Date;
  periodEnd: Date;
  contactsCount: number;
  messagesSent: number;
  broadcastsSent: number;
  flowsActive: number;
  storageUsedMb: number;
};

export type AccountActivity = {
  contacts: number;
  conversations: number;
  messages: number;
  broadcasts: number;
  automations: number;
  flows: number;
  teamMembers: number;
};

export type SubscriberDetail = {
  subscriber: SubscriberRow;
  limits: PlanLimits;
  usage: UsageSnapshot | null;
  activity: AccountActivity | null;
  /** Email of the admin-side user recorded on the last manual assignment. */
  assignedByEmail: string | null;
};

export async function getSubscriber(
  userId: string
): Promise<SubscriberDetail | null> {
  const [subscriber] = await prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
    select ${SUBSCRIBER_COLUMNS}
    ${SUBSCRIBER_FROM}
    where s.user_id = ${userId}::uuid
    limit 1
  `);

  if (!subscriber) return null;

  const [limitsRow, usageRow, assignedRow] = await Promise.all([
    prisma.$queryRaw<PlanLimits[]>(Prisma.sql`
      select
        max_contacts as "maxContacts",
        max_messages_monthly as "maxMessagesMonthly",
        max_broadcasts_monthly as "maxBroadcastsMonthly",
        max_flows as "maxFlows",
        max_team_members as "maxTeamMembers",
        max_storage_mb as "maxStorageMb",
        trial_days as "trialDays",
        features as "features"
      from subscription_plans
      where id = ${subscriber.planId}::uuid
    `),
    // Most recent tracked period. usage_tracking is keyed by user + period, and
    // nothing guarantees a row exists for the current one.
    prisma.$queryRaw<UsageSnapshot[]>(Prisma.sql`
      select
        period_start as "periodStart",
        period_end as "periodEnd",
        coalesce(contacts_count, 0) as "contactsCount",
        coalesce(messages_sent, 0) as "messagesSent",
        coalesce(broadcasts_sent, 0) as "broadcastsSent",
        coalesce(flows_active, 0) as "flowsActive",
        coalesce(storage_used_mb, 0) as "storageUsedMb"
      from usage_tracking
      where user_id = ${userId}::uuid
      order by period_start desc
      limit 1
    `),
    prisma.$queryRaw<{ email: string | null }[]>(Prisma.sql`
      select u.email
      from user_subscriptions s
      join auth.users u on u.id = s.manually_assigned_by
      where s.user_id = ${userId}::uuid
    `),
  ]);

  const activity = subscriber.accountId
    ? await accountActivity(subscriber.accountId)
    : null;

  return {
    subscriber,
    limits: limitsRow[0],
    usage: usageRow[0] ?? null,
    activity,
    assignedByEmail: assignedRow[0]?.email ?? null,
  };
}

/**
 * What the account has actually done, straight from the domain tables rather
 * than the `usage_tracking` counters — the counters are incremented by the api
 * and drift; these are the ground truth for "is this account real?".
 */
async function accountActivity(accountId: string): Promise<AccountActivity> {
  const [row] = await prisma.$queryRaw<AccountActivity[]>(Prisma.sql`
    select
      (select count(*) from contacts where account_id = ${accountId}::uuid)::int
        as "contacts",
      (select count(*) from conversations where account_id = ${accountId}::uuid)::int
        as "conversations",
      (
        select count(*)
        from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id = ${accountId}::uuid
      )::int as "messages",
      (select count(*) from broadcasts where account_id = ${accountId}::uuid)::int
        as "broadcasts",
      (select count(*) from automations where account_id = ${accountId}::uuid)::int
        as "automations",
      (select count(*) from flows where account_id = ${accountId}::uuid)::int
        as "flows",
      (select count(*) from account_members where account_id = ${accountId}::uuid)::int
        as "teamMembers"
  `);

  return row;
}

/** Plan options for the assignment form — id, name and both prices. */
export async function planOptions(): Promise<
  {
    id: string;
    name: string;
    displayName: string;
    priceMonthly: number;
    priceYearly: number;
    trialDays: number | null;
    isActive: boolean | null;
  }[]
> {
  return prisma.$queryRaw(Prisma.sql`
    select
      id,
      name,
      display_name as "displayName",
      coalesce(price_monthly, 0)::float8 as "priceMonthly",
      coalesce(price_yearly, 0)::float8 as "priceYearly",
      trial_days as "trialDays",
      is_active as "isActive"
    from subscription_plans
    order by coalesce(price_monthly, 0) asc, name
  `);
}
