import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { LOW_CREDIT_THRESHOLD } from '@/lib/queries/workspaces';

/**
 * AI credits, across every tenant.
 *
 * ## Two things here are unlike the rest of the panel
 *
 * **1. This history is real.** Every other figure in this app is derived —
 * `plan price × subscription` — because there is no payments table (see
 * ./sql.ts). `ai_credit_ledger` and `ai_credit_orders` are different: the
 * ledger records every credit that moved, when, for what feature and at what
 * token cost, and an order records an amount that Razorpay actually collected.
 * So "credits consumed in March" and "top-up revenue in March" are recorded
 * facts, not reconstructions, and editing a pack price today does not rewrite
 * them. That is why this file is allowed to put money on a time axis when
 * ./sales.ts is not.
 *
 * **2. ⚠️ The money here is in MINOR UNITS.** `ai_credit_orders.amount_minor`
 * and `ai_credit_packs.price_minor` are BIGINT paise — ₹299 is `29900` —
 * matching Razorpay's own API and the ads module. `subscription_plans.price_*`
 * next door are plain major-unit decimals. Mixing the two silently is a 100×
 * error, so every field in this file that holds minor units is named
 * `...Minor`, and `minorToMajor()` in lib/format.ts is the only place the
 * conversion happens. Never add a `...Minor` value to an MRR figure.
 *
 * Sums of minor units are cast to `float8` in SQL because Prisma returns a
 * bigint column as a JS `BigInt`, which neither `Intl` nor the client boundary
 * accepts. Exact to 2^53 paise, i.e. ninety trillion rupees.
 */

export type CreditTotals = {
  /** Credits sitting in wallets — what we still owe in inference. */
  outstanding: number;
  lifetimePurchased: number;
  lifetimeConsumed: number;
  wallets: number;
  walletsEmpty: number;
  walletsLow: number;
  onPlatform: number;
  onOwnKey: number;
  consumed30d: number;
  granted30d: number;
  adminGranted30d: number;
  adminRevoked30d: number;
  topUpRevenueMinor: number;
  topUpRevenueMinorThisMonth: number;
  paidOrders: number;
  /** Orders created but never paid — the abandoned-checkout count. */
  unpaidOrders: number;
};

export async function creditTotals(): Promise<CreditTotals> {
  const [row] = await prisma.$queryRaw<CreditTotals[]>(Prisma.sql`
    select
      (select coalesce(sum(balance), 0) from ai_credit_wallets)::int
        as "outstanding",
      (select coalesce(sum(lifetime_purchased), 0) from ai_credit_wallets)::int
        as "lifetimePurchased",
      (select coalesce(sum(lifetime_consumed), 0) from ai_credit_wallets)::int
        as "lifetimeConsumed",
      (select count(*) from ai_credit_wallets)::int as "wallets",
      (select count(*) from ai_credit_wallets where balance = 0)::int
        as "walletsEmpty",
      (
        select count(*) from ai_credit_wallets
         where balance between 1 and ${LOW_CREDIT_THRESHOLD}
      )::int as "walletsLow",
      (select count(*) from ai_configs where credit_mode = 'platform')::int
        as "onPlatform",
      (select count(*) from ai_configs where credit_mode = 'byok')::int
        as "onOwnKey",
      -- Consumption is every negative movement EXCEPT an operator taking
      -- credits back: a clawback is not inference we paid for, and counting it
      -- as usage would overstate what the platform key cost us.
      (
        select coalesce(-sum(delta), 0) from ai_credit_ledger
         where delta < 0 and reason = 'usage'
           and created_at >= now() - interval '30 days'
      )::int as "consumed30d",
      (
        select coalesce(sum(delta), 0) from ai_credit_ledger
         where delta > 0 and created_at >= now() - interval '30 days'
      )::int as "granted30d",
      (
        select coalesce(sum(delta), 0) from ai_credit_ledger
         where reason = 'admin_adjust' and delta > 0
           and created_at >= now() - interval '30 days'
      )::int as "adminGranted30d",
      (
        select coalesce(-sum(delta), 0) from ai_credit_ledger
         where reason = 'admin_adjust' and delta < 0
           and created_at >= now() - interval '30 days'
      )::int as "adminRevoked30d",
      -- credited_at rather than status = 'paid': it is the latch that proves
      -- the credits were actually granted, so counting it can never report
      -- revenue for a payment that failed to land.
      (
        select coalesce(sum(amount_minor), 0) from ai_credit_orders
         where credited_at is not null
      )::float8 as "topUpRevenueMinor",
      (
        select coalesce(sum(amount_minor), 0) from ai_credit_orders
         where credited_at is not null
           and credited_at >= date_trunc('month', now())
      )::float8 as "topUpRevenueMinorThisMonth",
      (select count(*) from ai_credit_orders where credited_at is not null)::int
        as "paidOrders",
      (
        select count(*) from ai_credit_orders
         where credited_at is null and created_at < now() - interval '1 hour'
      )::int as "unpaidOrders"
  `);

  return row;
}

export type FeatureSpend = {
  feature: string | null;
  credits: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * What the platform key is actually being spent on.
 *
 * `reason = 'usage'` only, so an admin adjustment (which carries a NULL
 * feature) never appears as a phantom feature bucket.
 */
export async function spendByFeature(days = 30): Promise<FeatureSpend[]> {
  return prisma.$queryRaw<FeatureSpend[]>(Prisma.sql`
    select
      feature as "feature",
      coalesce(-sum(delta), 0)::int as "credits",
      (count(*))::int as "calls",
      coalesce(sum(input_tokens), 0)::int as "inputTokens",
      coalesce(sum(output_tokens), 0)::int as "outputTokens"
    from ai_credit_ledger
    where reason = 'usage'
      and created_at >= now() - ${`${days} days`}::interval
    group by feature
    order by "credits" desc
  `);
}

export type CreditMonth = {
  month: Date;
  granted: number;
  consumed: number;
  adminGranted: number;
  adminRevoked: number;
  purchased: number;
  revenueMinor: number;
  orders: number;
};

/**
 * Month by month, from the ledger itself.
 *
 * The months come from `generate_series` and the aggregates are LEFT joined
 * onto them, so a quiet month renders as a zero row rather than disappearing —
 * a gap in a series reads as missing data, which is a different claim.
 */
export async function creditsByMonth(months = 6): Promise<CreditMonth[]> {
  const window = `${Math.max(months - 1, 0)} months`;

  return prisma.$queryRaw<CreditMonth[]>(Prisma.sql`
    with span as (
      select generate_series(
        date_trunc('month', now()) - ${window}::interval,
        date_trunc('month', now()),
        interval '1 month'
      ) as month
    ),
    ledger as (
      select
        date_trunc('month', created_at) as month,
        sum(case when delta > 0 then delta else 0 end) as granted,
        sum(case when reason = 'usage' and delta < 0 then -delta else 0 end)
          as consumed,
        sum(case when reason = 'purchase' then delta else 0 end) as purchased,
        sum(case when reason = 'admin_adjust' and delta > 0 then delta else 0 end)
          as admin_granted,
        sum(case when reason = 'admin_adjust' and delta < 0 then -delta else 0 end)
          as admin_revoked
      from ai_credit_ledger
      where created_at >= date_trunc('month', now()) - ${window}::interval
      group by 1
    ),
    paid as (
      select
        date_trunc('month', credited_at) as month,
        sum(amount_minor) as revenue_minor,
        count(*) as orders
      from ai_credit_orders
      where credited_at is not null
        and credited_at >= date_trunc('month', now()) - ${window}::interval
      group by 1
    )
    select
      s.month as "month",
      coalesce(l.granted, 0)::int as "granted",
      coalesce(l.consumed, 0)::int as "consumed",
      coalesce(l.admin_granted, 0)::int as "adminGranted",
      coalesce(l.admin_revoked, 0)::int as "adminRevoked",
      coalesce(l.purchased, 0)::int as "purchased",
      coalesce(p.revenue_minor, 0)::float8 as "revenueMinor",
      coalesce(p.orders, 0)::int as "orders"
    from span s
    left join ledger l on l.month = s.month
    left join paid p on p.month = s.month
    order by s.month asc
  `);
}

export type TopConsumer = {
  accountId: string;
  accountName: string;
  ownerEmail: string | null;
  creditMode: string | null;
  balance: number | null;
  credits: number;
  calls: number;
};

/** Who is burning the platform key, and whether they can pay for more. */
export async function topConsumers(
  days = 30,
  limit = 10
): Promise<TopConsumer[]> {
  return prisma.$queryRaw<TopConsumer[]>(Prisma.sql`
    select
      a.id as "accountId",
      a.name as "accountName",
      u.email as "ownerEmail",
      ac.credit_mode as "creditMode",
      w.balance as "balance",
      coalesce(-sum(l.delta), 0)::int as "credits",
      (count(*))::int as "calls"
    from ai_credit_ledger l
    join accounts a on a.id = l.account_id
    join auth.users u on u.id = a.owner_user_id
    left join ai_configs ac on ac.account_id = a.id
    left join ai_credit_wallets w on w.account_id = a.id
    where l.reason = 'usage'
      and l.delta < 0
      and l.created_at >= now() - ${`${days} days`}::interval
    group by a.id, a.name, u.email, ac.credit_mode, w.balance
    order by "credits" desc
    limit ${limit}
  `);
}

export type PackRow = {
  id: string;
  code: string;
  displayName: string;
  credits: number;
  priceMinor: number;
  currency: string;
  badge: string | null;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date | null;
  sold: number;
  revenueMinor: number;
};

/**
 * The price list, with what each pack has actually earned.
 *
 * Revenue is summed from the orders' own `amount_minor` — what the customer was
 * charged at the time — not from the pack's current price. Repricing a pack must
 * not rewrite what it has already sold for, which is the exact failure mode the
 * subscription side of this panel cannot avoid.
 */
export async function listPacks(): Promise<PackRow[]> {
  return prisma.$queryRaw<PackRow[]>(Prisma.sql`
    select
      p.id as "id",
      p.code as "code",
      p.display_name as "displayName",
      p.credits as "credits",
      (p.price_minor)::float8 as "priceMinor",
      p.currency as "currency",
      p.badge as "badge",
      p.sort_order as "sortOrder",
      p.is_active as "isActive",
      p.updated_at as "updatedAt",
      (
        select count(*) from ai_credit_orders o
         where o.pack_id = p.id and o.credited_at is not null
      )::int as "sold",
      (
        select coalesce(sum(o.amount_minor), 0) from ai_credit_orders o
         where o.pack_id = p.id and o.credited_at is not null
      )::float8 as "revenueMinor"
    from ai_credit_packs p
    order by p.sort_order asc, p.credits asc
  `);
}

export type OrderRow = {
  id: string;
  accountId: string;
  accountName: string;
  buyerEmail: string | null;
  packCode: string;
  credits: number;
  amountMinor: number;
  currency: string;
  status: string;
  gateway: string;
  creditedAt: Date | null;
  createdAt: Date;
};

export async function recentOrders(limit = 15): Promise<OrderRow[]> {
  return prisma.$queryRaw<OrderRow[]>(Prisma.sql`
    select
      o.id as "id",
      o.account_id as "accountId",
      a.name as "accountName",
      u.email as "buyerEmail",
      o.pack_code as "packCode",
      o.credits as "credits",
      (o.amount_minor)::float8 as "amountMinor",
      o.currency as "currency",
      o.status as "status",
      o.gateway as "gateway",
      o.credited_at as "creditedAt",
      o.created_at as "createdAt"
    from ai_credit_orders o
    join accounts a on a.id = o.account_id
    left join auth.users u on u.id = o.user_id
    order by o.created_at desc
    limit ${limit}
  `);
}

export type AdjustmentRow = {
  id: string;
  accountId: string;
  accountName: string;
  delta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: Date;
};

/**
 * Every manual correction, newest first — the review list for the one thing in
 * this panel that creates value out of nothing.
 */
export async function recentAdjustments(limit = 15): Promise<AdjustmentRow[]> {
  return prisma.$queryRaw<AdjustmentRow[]>(Prisma.sql`
    select
      l.id as "id",
      l.account_id as "accountId",
      a.name as "accountName",
      l.delta as "delta",
      l.balance_after as "balanceAfter",
      l.note as "note",
      l.created_at as "createdAt"
    from ai_credit_ledger l
    join accounts a on a.id = l.account_id
    where l.reason = 'admin_adjust'
    order by l.created_at desc
    limit ${limit}
  `);
}

export type CreditsOverview = {
  totals: CreditTotals;
  features: FeatureSpend[];
  months: CreditMonth[];
  consumers: TopConsumer[];
  packs: PackRow[];
  orders: OrderRow[];
  adjustments: AdjustmentRow[];
};

export async function getCreditsOverview(): Promise<CreditsOverview> {
  const [totals, features, months, consumers, packs, orders, adjustments] =
    await Promise.all([
      creditTotals(),
      spendByFeature(),
      creditsByMonth(),
      topConsumers(),
      listPacks(),
      recentOrders(),
      recentAdjustments(),
    ]);

  return { totals, features, months, consumers, packs, orders, adjustments };
}
