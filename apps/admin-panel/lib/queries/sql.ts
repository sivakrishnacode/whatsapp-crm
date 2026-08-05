import 'server-only';

import { Prisma } from '@prisma/client';

/**
 * Shared SQL for every subscriber/revenue read in the panel.
 *
 * These are raw fragments rather than Prisma model queries because almost
 * everything here aggregates across `user_subscriptions`, `subscription_plans`,
 * `auth.users`, `profiles` and `accounts` at once — five tables and a `sum()`
 * that Prisma's `groupBy` cannot express. Composing `Prisma.sql` keeps the
 * money maths written down exactly once, still parameterised.
 *
 * ## Where the money comes from
 *
 * There is no payments/invoices table in this database. `user_subscriptions`
 * records *what someone is on*, not *what was collected* — no amount column, no
 * transaction history. So every figure in this panel is derived:
 *
 *   amount for a period = the plan's price for that subscription's cycle
 *
 * That makes MRR, ARR and "expected collections" accurate statements about what
 * the current subscription set is worth, and it makes historical revenue
 * unknowable — a plan price edited today rewrites what last month appears to
 * have earned. Anything time-series in here counts subscriptions, never money
 * in the past.
 */

/**
 * The amount billed once per cycle — a yearly subscriber's ₹5,000 rather than
 * their ₹417/month share. This is what a renewal on `current_period_end` will
 * actually charge.
 *
 * Guarded on `s.user_id` because several queries reach these expressions through
 * a LEFT JOIN *from* `subscription_plans`, where a plan with no subscribers
 * produces a row with every `s.*` column NULL. Without the guard, `else
 * price_monthly` fires on that phantom row and the plan reports its own list
 * price as revenue it isn't earning.
 */
export const PERIOD_AMOUNT_EXPR = Prisma.sql`
  case
    when s.user_id is null then 0
    when s.billing_cycle = 'yearly' then coalesce(pl.price_yearly, 0)
    else coalesce(pl.price_monthly, 0)
  end`;

/** The same amount normalised to one month. */
const MONTHLY_AMOUNT_EXPR = Prisma.sql`
  case
    when s.user_id is null then 0
    when s.billing_cycle = 'yearly' then coalesce(pl.price_yearly, 0) / 12.0
    else coalesce(pl.price_monthly, 0)
  end`;

/**
 * Monthly recurring revenue for one subscription row.
 *
 * Only `active` counts. Trials have not paid yet and `past_due` has stopped
 * paying; both are reported on their own so a headline MRR is never quietly
 * propped up by revenue that is not arriving.
 *
 * The status test is positive (`= 'active'`) rather than negated, so a NULL
 * status — a plan with no subscriptions, a user with no subscription — falls to
 * the `else` and contributes nothing, instead of skipping past a `<> 'active'`
 * test that NULL never satisfies.
 */
export const MRR_EXPR = Prisma.sql`
  case when s.status = 'active' then (${MONTHLY_AMOUNT_EXPR}) else 0 end`;

/** The same figure for `past_due` rows: booked, not collected. */
export const AT_RISK_MRR_EXPR = Prisma.sql`
  case when s.status = 'past_due' then (${MONTHLY_AMOUNT_EXPR}) else 0 end`;

/** What a trial would be worth per month if it converts as-is. */
export const TRIAL_MRR_EXPR = Prisma.sql`
  case when s.status = 'trial' then (${MONTHLY_AMOUNT_EXPR}) else 0 end`;

/**
 * `profiles`/`accounts` are LEFT joined: a subscription hangs off an auth user,
 * and a user can exist without a profile (invited but never onboarded, or a
 * profile deleted out from under them). Those rows still cost money, so they
 * must not vanish from the books via an inner join.
 */
export const SUBSCRIBER_FROM = Prisma.sql`
  from user_subscriptions s
  join auth.users u on u.id = s.user_id
  join subscription_plans pl on pl.id = s.plan_id
  left join profiles p on p.user_id = s.user_id
  left join accounts a on a.id = p.account_id`;

export const SUBSCRIBER_COLUMNS = Prisma.sql`
  s.user_id as "userId",
  u.email as "email",
  u.created_at as "userCreatedAt",
  u.last_sign_in_at as "lastSignInAt",
  p.full_name as "fullName",
  p.account_role as "accountRole",
  a.id as "accountId",
  a.name as "accountName",
  pl.id as "planId",
  pl.name as "planName",
  pl.display_name as "planDisplayName",
  s.status as "status",
  s.billing_cycle as "billingCycle",
  s.payment_method as "paymentMethod",
  s.trial_end_at as "trialEndAt",
  s.current_period_start as "periodStart",
  s.current_period_end as "periodEnd",
  s.cancel_at_period_end as "cancelAtPeriodEnd",
  s.stripe_subscription_id as "stripeSubscriptionId",
  s.razorpay_subscription_id as "razorpaySubscriptionId",
  s.created_at as "subscribedAt",
  s.updated_at as "updatedAt",
  (${PERIOD_AMOUNT_EXPR})::float8 as "periodAmount",
  (${MRR_EXPR})::float8 as "mrr"`;

export type SubscriptionStatus =
  'active' | 'trial' | 'past_due' | 'cancelled' | 'expired';

export type BillingCycle = 'monthly' | 'yearly';

export type PaymentMethod = 'stripe' | 'razorpay' | 'manual';

export type SubscriberRow = {
  userId: string;
  email: string | null;
  userCreatedAt: Date | null;
  lastSignInAt: Date | null;
  fullName: string | null;
  accountRole: string | null;
  accountId: string | null;
  accountName: string | null;
  planId: string;
  planName: string;
  planDisplayName: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle | null;
  paymentMethod: PaymentMethod | null;
  trialEndAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  stripeSubscriptionId: string | null;
  razorpaySubscriptionId: string | null;
  subscribedAt: Date | null;
  updatedAt: Date | null;
  periodAmount: number;
  mrr: number;
};

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'active',
  'trial',
  'past_due',
  'cancelled',
  'expired',
];
