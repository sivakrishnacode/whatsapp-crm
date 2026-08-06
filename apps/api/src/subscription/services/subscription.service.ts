import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type LimitType =
  'contacts' | 'messages' | 'broadcasts' | 'flows' | 'team_members' | 'storage';

export interface LimitCheckResult {
  allowed: boolean;
  currentUsage: number;
  limitValue: number | null;
  reason: string;
}

/** The tier that no longer exists as a choice (migration 066). */
export const RETIRED_PLAN = 'FREE';

/** Priced by a human, so the UI shows an enquiry form instead of a price. */
export const ENTERPRISE_PLAN = 'ENTERPRISE';

/** A plan as the pricing table and the signup wizard need it. */
export interface PlanView {
  name: string;
  displayName: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  trialDays: number | null;
  features: string[];
  maxContacts: number;
  maxMessagesMonthly: number;
  maxBroadcastsMonthly: number;
  /** null = unlimited. */
  maxFlows: number | null;
  maxTeamMembers: number;
  maxStorageMb: number;
  isEnquiryOnly: boolean;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user subscription with plan details using SQL RPC.
   */
  async getUserSubscription(userId: string): Promise<any> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM get_user_subscription($1::uuid)',
        userId,
      );
      return rows?.[0] || null;
    } catch (error) {
      this.logger.error(
        `Error fetching subscription for user ${userId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Every plan a customer may choose, in the order a pricing table
   * should show them: cheapest first, with the quoted tier last.
   *
   * The second sort is not cosmetic. Enterprise carries
   * `price_monthly = 0` because it is priced by hand, so a plain
   * price-ascending sort puts the most expensive tier at the front of
   * the table, before the cheapest one.
   *
   * Reads the table rather than a constant so a price edited in the
   * admin panel takes effect without a deploy — the pricing page and
   * the signup wizard both render from this.
   *
   * FREE is filtered by name, not by `is_active`: accounts still
   * reference it, so the row has to stay readable even though it must
   * never be offered again.
   */
  async listSelectablePlans(): Promise<PlanView[]> {
    const rows = await this.prisma.subscription_plans.findMany({
      where: { is_active: true, name: { not: RETIRED_PLAN } },
      orderBy: { price_monthly: 'asc' },
    });

    const plans = [
      ...rows.filter((plan) => plan.name !== ENTERPRISE_PLAN),
      ...rows.filter((plan) => plan.name === ENTERPRISE_PLAN),
    ];

    return plans.map((plan) => ({
      name: plan.name,
      displayName: plan.display_name,
      description: plan.description,
      priceMonthly: Number(plan.price_monthly ?? 0),
      priceYearly: Number(plan.price_yearly ?? 0),
      trialDays: plan.trial_days,
      features: Array.isArray(plan.features) ? (plan.features as string[]) : [],
      maxContacts: plan.max_contacts,
      maxMessagesMonthly: plan.max_messages_monthly,
      maxBroadcastsMonthly: plan.max_broadcasts_monthly,
      maxFlows: plan.max_flows,
      maxTeamMembers: plan.max_team_members,
      maxStorageMb: plan.max_storage_mb,
      isEnquiryOnly: plan.name === ENTERPRISE_PLAN,
    }));
  }

  /**
   * Check if user can perform an action based on their subscription limits.
   */
  async checkSubscriptionLimit(
    userId: string,
    limitType: LimitType,
    increment: number = 1,
  ): Promise<LimitCheckResult> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT allowed, current_usage as "currentUsage", limit_value as "limitValue", reason FROM check_subscription_limit($1::uuid, $2, $3::integer)',
        userId,
        limitType,
        increment,
      );

      if (!rows || rows.length === 0) {
        return {
          allowed: false,
          currentUsage: 0,
          limitValue: 0,
          reason: 'No subscription found',
        };
      }

      return {
        allowed: Boolean(rows[0].allowed),
        currentUsage: Number(rows[0].currentUsage ?? 0),
        limitValue:
          rows[0].limitValue !== null ? Number(rows[0].limitValue) : null,
        reason: String(rows[0].reason ?? ''),
      };
    } catch (error) {
      this.logger.error(
        `Error checking limit ${limitType} for user ${userId}`,
        error,
      );
      return {
        allowed: false,
        currentUsage: 0,
        limitValue: 0,
        reason: 'Error checking subscription limit',
      };
    }
  }

  /**
   * Increment usage counter for a user.
   */
  async incrementUsage(
    userId: string,
    type: LimitType,
    increment: number = 1,
  ): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT increment_usage($1::uuid, $2, $3::integer) as success',
        userId,
        type,
        increment,
      );
      return Boolean(rows?.[0]?.success);
    } catch (error) {
      this.logger.error(
        `Error incrementing usage ${type} for user ${userId}`,
        error,
      );
      return false;
    }
  }

  /**
   * Decrement usage counter for a user.
   */
  async decrementUsage(
    userId: string,
    type: LimitType,
    decrement: number = 1,
  ): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT decrement_usage($1::uuid, $2, $3::integer) as success',
        userId,
        type,
        decrement,
      );
      return Boolean(rows?.[0]?.success);
    } catch (error) {
      this.logger.error(
        `Error decrementing usage ${type} for user ${userId}`,
        error,
      );
      return false;
    }
  }
}
