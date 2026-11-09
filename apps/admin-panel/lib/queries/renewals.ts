import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  PERIOD_AMOUNT_EXPR,
  SUBSCRIBER_COLUMNS,
  SUBSCRIBER_FROM,
  type SubscriberRow,
} from '@/lib/queries/sql';

/**
 * The renewal watchlist (C360-030): what renews, lapses or runs dry inside a
 * window, so the billing team can reach out BEFORE the date rather than after.
 *
 * ⚠️ A row here is a period ending, not a scheduled charge. A subscription
 * with no Stripe or Razorpay subscription id attached will not bill itself —
 * that is surfaced per row, because "due" and "will be collected" are
 * different promises.
 *
 * Every list is capped so one bad week cannot render ten thousand rows; the
 * counts above each list are uncapped.
 */

export type WatchWindow = 7 | 15 | 30;

const LIST_LIMIT = 100;

function windowInterval(days: WatchWindow): string {
  return `${days} days`;
}

export type RenewalWatch = {
  days: WatchWindow;
  /** Active or past-due periods ending inside the window. */
  renewals: SubscriberRow[];
  renewalsTotal: number;
  renewalsAmount: number;
  /** Of those, how many have no gateway subscription to charge them. */
  renewalsManual: number;
  /** Of those, set to cancel at period end. */
  renewalsCancelling: number;
  /** Periods that ended in the last 30 days while the row still says active. */
  lapsedActive: SubscriberRow[];
  trials: SubscriberRow[];
  pastDue: SubscriberRow[];
  wallets: WalletWatchRow[];
};

export type WalletWatchRow = {
  accountId: string;
  accountName: string;
  ownerEmail: string | null;
  balance: number;
  spent30d: number;
  autoReplyAgents: number;
  lowBalanceNotifiedAt: Date | null;
};

export async function getRenewalWatch(
  days: WatchWindow,
  lowCreditThreshold: number
): Promise<RenewalWatch> {
  const interval = windowInterval(days);

  const [renewals, [renewalTotals], lapsedActive, trials, pastDue, wallets] =
    await Promise.all([
      prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
        select ${SUBSCRIBER_COLUMNS}
        ${SUBSCRIBER_FROM}
        where s.status in ('active', 'past_due')
          and s.current_period_end between now() and now() + ${interval}::interval
        order by s.current_period_end asc
        limit ${LIST_LIMIT}
      `),
      prisma.$queryRaw<
        {
          total: number;
          amount: number;
          manual: number;
          cancelling: number;
        }[]
      >(Prisma.sql`
        select
          (count(*))::int as "total",
          coalesce(sum(
            case when coalesce(s.cancel_at_period_end, false) then 0
                 else (${PERIOD_AMOUNT_EXPR}) end
          ), 0)::float8 as "amount",
          (count(*) filter (
            where s.stripe_subscription_id is null
              and s.razorpay_subscription_id is null
          ))::int as "manual",
          (count(*) filter (
            where coalesce(s.cancel_at_period_end, false)
          ))::int as "cancelling"
        ${SUBSCRIBER_FROM}
        where s.status in ('active', 'past_due')
          and s.current_period_end between now() and now() + ${interval}::interval
      `),
      // The sweep should move these off `active`; when it has not, the
      // workspace is still entitled on a period nobody paid for.
      prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
        select ${SUBSCRIBER_COLUMNS}
        ${SUBSCRIBER_FROM}
        where s.status = 'active'
          and s.current_period_end between now() - interval '30 days' and now()
        order by s.current_period_end asc
        limit ${LIST_LIMIT}
      `),
      prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
        select ${SUBSCRIBER_COLUMNS}
        ${SUBSCRIBER_FROM}
        where s.status = 'trial'
          and s.trial_end_at between now() and now() + ${interval}::interval
        order by s.trial_end_at asc
        limit ${LIST_LIMIT}
      `),
      prisma.$queryRaw<SubscriberRow[]>(Prisma.sql`
        select ${SUBSCRIBER_COLUMNS}
        ${SUBSCRIBER_FROM}
        where s.status = 'past_due'
        order by s.current_period_end asc nulls last
        limit ${LIST_LIMIT}
      `),
      // Platform-mode wallets at or under the threshold. A workspace with no
      // ai_configs row runs on the platform key by default, so it counts.
      // BYOK wallets are excluded: nothing meters against them.
      prisma.$queryRaw<WalletWatchRow[]>(Prisma.sql`
        select
          a.id as "accountId",
          a.name as "accountName",
          u.email as "ownerEmail",
          w.balance as "balance",
          coalesce((
            select -sum(l.delta) from ai_credit_ledger l
             where l.account_id = a.id and l.delta < 0
               and l.created_at >= now() - interval '30 days'
          ), 0)::int as "spent30d",
          (
            select count(*) from ai_agents ag
             where ag.account_id = a.id and ag.is_active and ag.auto_reply_enabled
          )::int as "autoReplyAgents",
          w.low_balance_notified_at as "lowBalanceNotifiedAt"
        from ai_credit_wallets w
        join accounts a on a.id = w.account_id
        join auth.users u on u.id = a.owner_user_id
        left join ai_configs ac on ac.account_id = a.id
        where coalesce(ac.credit_mode, 'platform') = 'platform'
          and w.balance <= ${lowCreditThreshold}
        order by w.balance asc, "spent30d" desc
        limit ${LIST_LIMIT}
      `),
    ]);

  return {
    days,
    renewals,
    renewalsTotal: renewalTotals?.total ?? 0,
    renewalsAmount: renewalTotals?.amount ?? 0,
    renewalsManual: renewalTotals?.manual ?? 0,
    renewalsCancelling: renewalTotals?.cancelling ?? 0,
    lapsedActive,
    trials,
    pastDue,
    wallets,
  };
}
