import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { MRR_EXPR } from '@/lib/queries/sql';

/**
 * Plans are where the subscription *amounts* actually live — a price edited
 * here changes what every subscriber on that plan is worth, immediately and
 * retroactively across every figure in this panel (see ./sql.ts on why history
 * cannot be pinned down).
 */

export type PlanRow = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  trialDays: number | null;
  maxContacts: number;
  maxMessagesMonthly: number;
  maxBroadcastsMonthly: number;
  maxFlows: number | null;
  maxTeamMembers: number;
  maxStorageMb: number;
  isActive: boolean | null;
  features: unknown;
  stripePriceIdMonthly: string | null;
  stripePriceIdYearly: string | null;
  razorpayPlanId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  subscribers: number;
  active: number;
  trial: number;
  mrr: number;
};

export async function listPlans(): Promise<PlanRow[]> {
  return prisma.$queryRaw<PlanRow[]>(Prisma.sql`
    select
      pl.id as "id",
      pl.name as "name",
      pl.display_name as "displayName",
      pl.description as "description",
      coalesce(pl.price_monthly, 0)::float8 as "priceMonthly",
      coalesce(pl.price_yearly, 0)::float8 as "priceYearly",
      pl.trial_days as "trialDays",
      pl.max_contacts as "maxContacts",
      pl.max_messages_monthly as "maxMessagesMonthly",
      pl.max_broadcasts_monthly as "maxBroadcastsMonthly",
      pl.max_flows as "maxFlows",
      pl.max_team_members as "maxTeamMembers",
      pl.max_storage_mb as "maxStorageMb",
      pl.is_active as "isActive",
      pl.features as "features",
      pl.stripe_price_id_monthly as "stripePriceIdMonthly",
      pl.stripe_price_id_yearly as "stripePriceIdYearly",
      pl.razorpay_plan_id as "razorpayPlanId",
      pl.created_at as "createdAt",
      pl.updated_at as "updatedAt",
      (count(s.user_id))::int as "subscribers",
      (count(s.user_id) filter (where s.status = 'active'))::int as "active",
      (count(s.user_id) filter (where s.status = 'trial'))::int as "trial",
      coalesce(sum(${MRR_EXPR}), 0)::float8 as "mrr"
    from subscription_plans pl
    left join user_subscriptions s on s.plan_id = pl.id
    group by pl.id
    order by coalesce(pl.price_monthly, 0) asc, pl.name
  `);
}
