import {
  Controller,
  Get,
  Post,
  Body,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../services/subscription.service';

@Controller('subscription/admin')
@UseGuards(SupabaseAuthGuard)
export class SubscriptionAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Helper to verify if the caller is an owner or admin.
   */
  private async verifyAdmin(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { accountRole: true },
    });

    if (
      !profile ||
      (profile.accountRole !== 'admin' && profile.accountRole !== 'owner')
    ) {
      throw new HttpException('Insufficient permissions', HttpStatus.FORBIDDEN);
    }
  }

  /**
   * GET /api/subscription/admin/users
   * Lists all profiles with their active subscriptions.
   */
  @Get('users')
  async getUsers(@CurrentAccount() account: SupabaseAccountContext) {
    await this.verifyAdmin(account.userId);

    try {
      const users = await this.prisma.profile.findMany({
        select: {
          id: true,
          userId: true,
          email: true,
          fullName: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const usersWithSubs = await Promise.all(
        users.map(async (user) => {
          const sub = await this.subscriptionService.getUserSubscription(
            user.userId,
          );
          return {
            id: user.id,
            user_id: user.userId,
            email: user.email,
            full_name: user.fullName,
            created_at: user.createdAt,
            subscription: sub,
          };
        }),
      );

      return { users: usersWithSubs };
    } catch (error) {
      throw new HttpException(
        'Failed to fetch users and subscriptions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/subscription/admin/assign-plan
   * Manually assigns a plan (STARTER, GROWTH, ENTERPRISE) to a user.
   *
   * FREE is not assignable — migration 066 retired it. To remove a
   * user's entitlement, cancel the subscription rather than downgrading
   * them onto a tier that no longer exists.
   */
  @Post('assign-plan')
  async assignPlan(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { targetUserId?: string; planName?: string },
  ) {
    await this.verifyAdmin(account.userId);

    const { targetUserId, planName } = body;
    if (!targetUserId || !planName) {
      throw new HttpException(
        'Missing targetUserId or planName',
        HttpStatus.BAD_REQUEST,
      );
    }

    const validPlans = ['STARTER', 'GROWTH', 'ENTERPRISE'];
    if (!validPlans.includes(planName)) {
      throw new HttpException('Invalid plan name', HttpStatus.BAD_REQUEST);
    }

    try {
      // 1. Get plan details
      const plan = await this.prisma.subscription_plans.findUnique({
        where: { name: planName },
        select: { id: true, trial_days: true },
      });

      if (!plan) {
        throw new HttpException('Plan not found', HttpStatus.NOT_FOUND);
      }

      // 2. Calculate dates
      const trialStart = plan.trial_days ? new Date() : null;
      const trialEnd = plan.trial_days
        ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000)
        : null;

      const now = new Date();
      const periodStart = trialEnd || now;
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 30); // 30 days default manual cycle

      // 3. Upsert user subscription
      await this.prisma.user_subscriptions.upsert({
        where: { user_id: targetUserId },
        create: {
          user_id: targetUserId,
          plan_id: plan.id,
          status: trialEnd ? 'trial' : 'active',
          billing_cycle: 'monthly',
          trial_start_at: trialStart,
          trial_end_at: trialEnd,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          stripe_subscription_id: null,
          razorpay_subscription_id: null,
          payment_method: 'manual',
          manually_assigned_by: account.userId,
        },
        update: {
          plan_id: plan.id,
          status: trialEnd ? 'trial' : 'active',
          billing_cycle: 'monthly',
          trial_start_at: trialStart,
          trial_end_at: trialEnd,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          stripe_subscription_id: null,
          razorpay_subscription_id: null,
          payment_method: 'manual',
          manually_assigned_by: account.userId,
        },
      });

      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to manually assign plan',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/subscription/admin/cancel
   * Ends the user's entitlement.
   *
   * Since migration 066 retired FREE there is no tier to downgrade onto,
   * so this marks the subscription cancelled and leaves plan_id pointing
   * at what they had — that row is the only record of the cancelled
   * plan, and the admin panel joins through it. The dashboard gate
   * routes a cancelled account back to /welcome to choose again.
   */
  @Post('cancel')
  async cancel(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { targetUserId?: string },
  ) {
    await this.verifyAdmin(account.userId);

    const { targetUserId } = body;
    if (!targetUserId) {
      throw new HttpException('Missing targetUserId', HttpStatus.BAD_REQUEST);
    }

    try {
      await this.prisma.user_subscriptions.update({
        where: { user_id: targetUserId },
        data: {
          status: 'cancelled',
          billing_cycle: null,
          trial_start_at: null,
          trial_end_at: null,
          current_period_end: new Date(),
          cancel_at_period_end: false,
          stripe_subscription_id: null,
          razorpay_subscription_id: null,
          payment_method: 'manual',
          manually_assigned_by: account.userId,
        },
      });

      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to cancel user subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
