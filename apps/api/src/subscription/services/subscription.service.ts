import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type LimitType = 'contacts' | 'messages' | 'broadcasts' | 'flows' | 'team_members' | 'storage';

export interface LimitCheckResult {
  allowed: boolean;
  currentUsage: number;
  limitValue: number | null;
  reason: string;
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
      this.logger.error(`Error fetching subscription for user ${userId}`, error);
      throw error;
    }
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
        limitValue: rows[0].limitValue !== null ? Number(rows[0].limitValue) : null,
        reason: String(rows[0].reason ?? ''),
      };
    } catch (error) {
      this.logger.error(`Error checking limit ${limitType} for user ${userId}`, error);
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
      this.logger.error(`Error incrementing usage ${type} for user ${userId}`, error);
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
      this.logger.error(`Error decrementing usage ${type} for user ${userId}`, error);
      return false;
    }
  }
}
