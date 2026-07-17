import {
  Controller,
  Post,
  Body,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import Razorpay from 'razorpay';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('subscription/razorpay')
@UseGuards(SupabaseAuthGuard)
export class RazorpayController {
  private getRazorpayInstance() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new HttpException(
        'Razorpay keys are not configured on the server.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      razorpay: new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      }),
      keyId,
    };
  }

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/subscription/razorpay/create-order
   * Creates a Razorpay order for plan upgrade.
   */
  @Post('create-order')
  async createOrder(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { planName?: string; billingCycle?: string },
  ) {
    const { planName, billingCycle } = body;
    if (!planName || !billingCycle) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }

    const validPlans = ['STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      throw new HttpException('Invalid plan name', HttpStatus.BAD_REQUEST);
    }

    const { razorpay, keyId } = this.getRazorpayInstance();

    try {
      // 1. Get plan details
      const plan = await this.prisma.subscription_plans.findUnique({
        where: { name: planName },
        select: { price_monthly: true, price_yearly: true },
      });

      if (!plan) {
        throw new HttpException('Plan not found', HttpStatus.NOT_FOUND);
      }

      const amount =
        billingCycle === 'monthly'
          ? Number(plan.price_monthly ?? 0)
          : Number(plan.price_yearly ?? 0);
      const amountInPaise = Math.round(amount * 100);

      // 2. Create order via SDK
      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `ord_${account.userId.substring(0, 8)}_${Date.now().toString().slice(-6)}`,
        notes: {
          userId: account.userId,
          planName,
          billingCycle,
        },
      });

      return {
        orderId: order.id,
        amount: Number(order.amount),
        currency: order.currency,
        keyId,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to create Razorpay order',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/subscription/razorpay/confirm-payment
   * Confirms payment and updates subscription immediately.
   */
  @Post('confirm-payment')
  async confirmPayment(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      planName?: string;
      billingCycle?: string;
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
    },
  ) {
    const { planName, billingCycle, razorpayOrderId, razorpayPaymentId } = body;

    if (!planName || !billingCycle || !razorpayOrderId) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }

    const validPlans = ['STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      throw new HttpException('Invalid plan name', HttpStatus.BAD_REQUEST);
    }

    try {
      // 1. Get plan ID
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
      periodEnd.setMonth(
        periodEnd.getMonth() + (billingCycle === 'yearly' ? 12 : 1),
      );

      // 3. Upsert user subscription
      await this.prisma.user_subscriptions.upsert({
        where: { user_id: account.userId },
        create: {
          user_id: account.userId,
          plan_id: plan.id,
          status: trialEnd ? 'trial' : 'active',
          billing_cycle: billingCycle as 'monthly' | 'yearly',
          trial_start_at: trialStart,
          trial_end_at: trialEnd,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          razorpay_subscription_id: razorpayOrderId,
          payment_method: 'razorpay',
        },
        update: {
          plan_id: plan.id,
          status: trialEnd ? 'trial' : 'active',
          billing_cycle: billingCycle as 'monthly' | 'yearly',
          trial_start_at: trialStart,
          trial_end_at: trialEnd,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          razorpay_subscription_id: razorpayOrderId,
          payment_method: 'razorpay',
        },
      });

      return { success: true, planName };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to confirm Razorpay payment',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
