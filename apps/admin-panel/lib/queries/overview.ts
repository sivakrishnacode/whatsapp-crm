import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  AT_RISK_MRR_EXPR,
  MRR_EXPR,
  PERIOD_AMOUNT_EXPR,
  SUBSCRIBER_COLUMNS,
  SUBSCRIBER_FROM,
  TRIAL_MRR_EXPR,
  type SubscriberRow,
} from '@/lib/queries/sql';

export type SubscriptionTotals = {
  subscriptions: number;
  active: number;
  trial: number;
  pastDue: number;
  cancelled: number;
  expired: number;
  paying: number;
  mrr: number;
  atRiskMrr: number;
  trialMrr: number;
  newThisMonth: number;
  churnedThisMonth: number;
  trialsEndingSoon: number;
  renewalsDue30: number;
  renewalsDue30Amount: number;
};

export type TenantTotals = {
  accounts: number;
  profiles: number;
  users: number;
  newAccountsThisMonth: number;
};

export type PlanBreakdownRow = {
  planId: string;
  name: string;
  displayName: string;
  priceMonthly: number;
  priceYearly: number;
  isActive: boolean | null;
  subscribers: number;
  active: number;
  trial: number;
  mrr: number;
};

async function subscriptionTotals(): Promise<SubscriptionTotals> {
  const [row] = await prisma.$queryRaw<SubscriptionTotals[]>(Prisma.sql`
    select
      (count(*))::int as "subscriptions",
      (count(*) filter (where s.status = 'active'))::int as "active",
      (count(*) filter (where s.status = 'trial'))::int as "trial",
      (count(*) filter (where s.status = 'past_due'))::int as "pastDue",
      (count(*) filter (where s.status = 'cancelled'))::int as "cancelled",
      (count(*) filter (where s.status = 'expired'))::int as "expired",
      (count(*) filter (
        where s.status = 'active' and (${PERIOD_AMOUNT_EXPR}) > 0
      ))::int as "paying",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr",
      coalesce(sum(${AT_RISK_MRR_EXPR}), 0)::float8 as "atRiskMrr",
      coalesce(sum(${TRIAL_MRR_EXPR}), 0)::float8 as "trialMrr",
      (count(*) filter (
        where s.created_at >= date_trunc('month', now())
      ))::int as "newThisMonth",
      (count(*) filter (
        where s.status in ('cancelled', 'expired')
          and s.updated_at >= date_trunc('month', now())
      ))::int as "churnedThisMonth",
      (count(*) filter (
        where s.status = 'trial'
          and s.trial_end_at between now() and now() + interval '7 days'
      ))::int as "trialsEndingSoon",
      (count(*) filter (
        where s.status = 'active'
          and s.current_period_end between now() and now() + interval '30 days'
      ))::int as "renewalsDue30",
      coalesce(sum(
        case
          when s.status = 'active'
            and s.current_period_end between now() and now() + interval '30 days'
          then (${PERIOD_AMOUNT_EXPR})
          else 0
        end
      ), 0)::float8 as "renewalsDue30Amount"
    ${SUBSCRIBER_FROM}
  `);

  return row;
}

async function tenantTotals(): Promise<TenantTotals> {
  const [row] = await prisma.$queryRaw<TenantTotals[]>(Prisma.sql`
    select
      (select count(*) from accounts)::int as "accounts",
      (select count(*) from profiles)::int as "profiles",
      (select count(*) from auth.users where deleted_at is null)::int as "users",
      (
        select count(*) from accounts
        where created_at >= date_trunc('month', now())
      )::int as "newAccountsThisMonth"
  `);

  return row;
}

/**
 * Every plan, including ones nobody is on — a plan with zero subscribers is
 * information (priced wrong, or quietly retired), so this LEFT JOINs from
 * plans rather than grouping the subscription set.
 */
export async function planBreakdown(): Promise<PlanBreakdownRow[]> {
  return prisma.$queryRaw<PlanBreakdownRow[]>(Prisma.sql`
    select
      pl.id as "planId",
      pl.name as "name",
      pl.display_name as "displayName",
      coalesce(pl.price_monthly, 0)::float8 as "priceMonthly",
      coalesce(pl.price_yearly, 0)::float8 as "priceYearly",
      pl.is_active as "isActive",
      (count(s.user_id))::int as "subscribers",
      (count(s.user_id) filter (where s.status = 'active'))::int as "active",
      (count(s.user_id) filter (where s.status = 'trial'))::int as "trial",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
    from subscription_plans pl
    left join user_subscriptions s on s.plan_id = pl.id
    group by pl.id, pl.name, pl.display_name, pl.price_monthly,
             pl.price_yearly, pl.is_active
    order by coalesce(pl.price_monthly, 0) desc, pl.name
  `);
}

/** Trials expiring inside the window, soonest first — the follow-up list. */
export async function trialsEndingSoon(days = 14): Promise<SubscriberRow[]> {
  return prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
    select ${SUBSCRIBER_COLUMNS}
    ${SUBSCRIBER_FROM}
    where s.status = 'trial'
      and s.trial_end_at is not null
      and s.trial_end_at <= now() + ${`${days} days`}::interval
    order by s.trial_end_at asc
    limit 10
  `);
}

/** Renewals coming up, soonest first — the expected-collections list. */
export async function upcomingRenewals(days = 30): Promise<SubscriberRow[]> {
  return prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
    select ${SUBSCRIBER_COLUMNS}
    ${SUBSCRIBER_FROM}
    where s.status in ('active', 'past_due')
      and s.current_period_end is not null
      and s.current_period_end <= now() + ${`${days} days`}::interval
      and (${PERIOD_AMOUNT_EXPR}) > 0
    order by s.current_period_end asc
    limit 10
  `);
}

export async function recentSubscriptions(limit = 8): Promise<SubscriberRow[]> {
  return prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
    select ${SUBSCRIBER_COLUMNS}
    ${SUBSCRIBER_FROM}
    order by s.created_at desc nulls last
    limit ${limit}
  `);
}

export type Overview = {
  subscriptions: SubscriptionTotals;
  tenants: TenantTotals;
  plans: PlanBreakdownRow[];
  trials: SubscriberRow[];
  renewals: SubscriberRow[];
  recent: SubscriberRow[];
};

export async function getOverview(): Promise<Overview> {
  const [subscriptions, tenants, plans, trials, renewals, recent] =
    await Promise.all([
      subscriptionTotals(),
      tenantTotals(),
      planBreakdown(),
      trialsEndingSoon(),
      upcomingRenewals(),
      recentSubscriptions(),
    ]);

  return { subscriptions, tenants, plans, trials, renewals, recent };
}
