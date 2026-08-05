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

/**
 * The sales reporting reads.
 *
 * Read the header of ./sql.ts first: there is no payment ledger in this
 * database, so "revenue" here means *the recurring value of the current
 * subscription set*, priced from `subscription_plans`. Consequences that shape
 * everything below:
 *
 *  - MRR/ARR/expected-collections are exact statements about today.
 *  - Historical *money* is not recoverable, so the monthly series counts
 *    subscriptions started and lost, and the MRR those additions represent at
 *    today's prices. It is deliberately not labelled as revenue collected.
 */

export type SalesSummary = {
  mrr: number;
  atRiskMrr: number;
  trialMrr: number;
  payingSubscribers: number;
  activeSubscribers: number;
  freeSubscribers: number;
};

export type SegmentRow = {
  label: string;
  subscribers: number;
  mrr: number;
};

export type MonthlyRow = {
  month: Date;
  started: number;
  startedMrr: number;
  churned: number;
};

export type RenewalBucket = {
  key: 'overdue' | 'week' | 'month' | 'quarter';
  label: string;
  subscribers: number;
  amount: number;
};

export async function salesSummary(): Promise<SalesSummary> {
  const [row] = await prisma.$queryRaw<SalesSummary[]>(Prisma.sql`
    select
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr",
      coalesce(sum(${AT_RISK_MRR_EXPR}), 0)::float8 as "atRiskMrr",
      coalesce(sum(${TRIAL_MRR_EXPR}), 0)::float8 as "trialMrr",
      (count(*) filter (
        where s.status = 'active' and (${PERIOD_AMOUNT_EXPR}) > 0
      ))::int as "payingSubscribers",
      (count(*) filter (where s.status = 'active'))::int as "activeSubscribers",
      (count(*) filter (
        where s.status = 'active' and (${PERIOD_AMOUNT_EXPR}) = 0
      ))::int as "freeSubscribers"
    ${SUBSCRIBER_FROM}
  `);

  return row;
}

export async function revenueByPlan(): Promise<SegmentRow[]> {
  return prisma.$queryRaw<SegmentRow[]>(Prisma.sql`
    select
      pl.display_name as "label",
      (count(*) filter (where s.status = 'active'))::int as "subscribers",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
    ${SUBSCRIBER_FROM}
    group by pl.id, pl.display_name, pl.price_monthly
    order by coalesce(pl.price_monthly, 0) desc, pl.display_name
  `);
}

export async function revenueByCycle(): Promise<SegmentRow[]> {
  return prisma.$queryRaw<SegmentRow[]>(Prisma.sql`
    select
      coalesce(s.billing_cycle::text, 'none') as "label",
      (count(*) filter (where s.status = 'active'))::int as "subscribers",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
    ${SUBSCRIBER_FROM}
    group by 1
    order by "mrr" desc
  `);
}

export async function revenueByPaymentMethod(): Promise<SegmentRow[]> {
  return prisma.$queryRaw<SegmentRow[]>(Prisma.sql`
    select
      coalesce(s.payment_method::text, 'unrecorded') as "label",
      (count(*) filter (where s.status = 'active'))::int as "subscribers",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
    ${SUBSCRIBER_FROM}
    group by 1
    order by "mrr" desc
  `);
}

/**
 * Subscriptions started and lost per month, with the MRR the new ones are
 * worth. `generate_series` supplies the months so quiet ones render as a zero
 * rather than disappearing from the axis.
 *
 * Churn is dated by `updated_at`, which is the best available proxy — nothing
 * records *when* a subscription was cancelled, only that it now is. A cancelled
 * row edited for any other reason moves in this series.
 */
export async function monthlyMovement(months = 12): Promise<MonthlyRow[]> {
  return prisma.$queryRaw<MonthlyRow[]>(Prisma.sql`
    with span as (
      select generate_series(
        date_trunc('month', now()) - ${`${months - 1} months`}::interval,
        date_trunc('month', now()),
        interval '1 month'
      ) as month
    ),
    started as (
      select
        date_trunc('month', s.created_at) as month,
        (count(*))::int as count,
        coalesce(sum(${MRR_EXPR}), 0)::float8 as mrr
      from user_subscriptions s
      join subscription_plans pl on pl.id = s.plan_id
      where s.created_at is not null
      group by 1
    ),
    lost as (
      select
        date_trunc('month', s.updated_at) as month,
        (count(*))::int as count
      from user_subscriptions s
      where s.status in ('cancelled', 'expired') and s.updated_at is not null
      group by 1
    )
    select
      span.month as "month",
      coalesce(started.count, 0) as "started",
      coalesce(started.mrr, 0)::float8 as "startedMrr",
      coalesce(lost.count, 0) as "churned"
    from span
    left join started on started.month = span.month
    left join lost on lost.month = span.month
    order by span.month asc
  `);
}

const BUCKET_LABELS: Record<RenewalBucket['key'], string> = {
  overdue: 'Past due date',
  week: 'Next 7 days',
  month: '8–30 days',
  quarter: '31–90 days',
};

/**
 * What the current period ends imply is collectable, bucketed by urgency. Free
 * plans are excluded — a ₹0 renewal is not a collection.
 */
export async function renewalBuckets(): Promise<RenewalBucket[]> {
  const rows = await prisma.$queryRaw<
    { key: RenewalBucket['key']; subscribers: number; amount: number }[]
  >(Prisma.sql`
    select
      case
        when s.current_period_end < now() then 'overdue'
        when s.current_period_end <= now() + interval '7 days' then 'week'
        when s.current_period_end <= now() + interval '30 days' then 'month'
        else 'quarter'
      end as "key",
      (count(*))::int as "subscribers",
      coalesce(sum(${PERIOD_AMOUNT_EXPR}), 0)::float8 as "amount"
    ${SUBSCRIBER_FROM}
    where s.status in ('active', 'past_due')
      and s.current_period_end is not null
      and s.current_period_end <= now() + interval '90 days'
      and (${PERIOD_AMOUNT_EXPR}) > 0
    group by 1
  `);

  const byKey = new Map(rows.map((row) => [row.key, row]));

  return (Object.keys(BUCKET_LABELS) as RenewalBucket['key'][]).map((key) => ({
    key,
    label: BUCKET_LABELS[key],
    subscribers: byKey.get(key)?.subscribers ?? 0,
    amount: byKey.get(key)?.amount ?? 0,
  }));
}

export async function topSubscribers(limit = 10): Promise<SubscriberRow[]> {
  return prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
    select ${SUBSCRIBER_COLUMNS}
    ${SUBSCRIBER_FROM}
    where (${MRR_EXPR}) > 0
    order by (${MRR_EXPR}) desc, s.created_at asc
    limit ${limit}
  `);
}

export type SalesReport = {
  summary: SalesSummary;
  byPlan: SegmentRow[];
  byCycle: SegmentRow[];
  byMethod: SegmentRow[];
  monthly: MonthlyRow[];
  renewals: RenewalBucket[];
  top: SubscriberRow[];
};

export async function getSalesReport(months = 12): Promise<SalesReport> {
  const [summary, byPlan, byCycle, byMethod, monthly, renewals, top] =
    await Promise.all([
      salesSummary(),
      revenueByPlan(),
      revenueByCycle(),
      revenueByPaymentMethod(),
      monthlyMovement(months),
      renewalBuckets(),
      topSubscribers(),
    ]);

  return { summary, byPlan, byCycle, byMethod, monthly, renewals, top };
}
