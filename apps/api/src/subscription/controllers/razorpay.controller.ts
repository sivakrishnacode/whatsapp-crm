import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Plan checkout via Razorpay.
 *
 * ⚠️ EVERY ROUTE HERE IS OWNER-ONLY, and that is not tidiness.
 * `user_subscriptions` is keyed by `accounts.owner_user_id` — the whole
 * workspace's entitlement resolves through that one row — so a payment
 * made by an admin or agent used to create a SECOND subscription row
 * against their own user id. The money was taken, a row appeared, and the
 * workspace stayed locked, because nothing reads a non-owner's row. Both
 * routes now refuse, and the write below targets the owner explicitly
 * rather than the caller.
 */
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
      keySecret,
    };
  }

  /**
   * The subscription row that IS this workspace's entitlement.
   *
   * Resolved from `accounts.owner_user_id` rather than trusting the
   * caller's profile role: the owner column is the authority every
   * entitlement read already uses.
   */
  private async getOwnerUserId(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { ownerUserId: true },
    });

    if (!account) {
      throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
    }

    return account.ownerUserId;
  }

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/subscription/razorpay/create-order
   * Creates a Razorpay order for plan upgrade.
   */
  @Post('create-order')
  @RequireRole('owner')
  async createOrder(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { planName?: string; billingCycle?: string },
  ) {
    const { planName, billingCycle } = body;
    if (!planName || !billingCycle) {
      throw new HttpException(
        'Missing required fields',
        HttpStatus.BAD_REQUEST,
      );
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
   * Razorpay Checkout's success callback: the browser telling us it paid.
   *
   * ⚠️ THE SIGNATURE IS THE WHOLE SECURITY OF THIS ENDPOINT. Razorpay
   * signs `<order_id>|<payment_id>` with our key secret, which the browser
   * never has. Without that check every field here is just a claim, and
   * "I paid for GROWTH" was a claim any signed-in user could POST — a
   * self-serve free upgrade, and (once the trial-ended screen sends people
   * here) a self-serve unlock. `POST /ai/credits/verify` has always done
   * this correctly; this is the same check.
   *
   * ⚠️ A PAYMENT MUST NOT GRANT A TRIAL. This used to set
   * `status = 'trial'` and a fresh `trial_end_at` whenever the plan had
   * `trial_days`, which every selectable plan does. So paying ₹300 bought
   * a *trial*: the customer was recorded as not-yet-paying, they lapsed
   * again 15 days later, MRR did not count them, and it walked straight
   * through migration 074's one-trial-per-workspace latch. Payment now
   * lands `active` with the billing period starting today, and the trial
   * columns are left exactly as they are — they are the historical record
   * of the trial this account already had.
   */
  @Post('confirm-payment')
  @RequireRole('owner')
  async confirmPayment(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      planName?: string;
      billingCycle?: string;
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
      razorpaySignature?: string;
    },
  ) {
    const {
      planName,
      billingCycle,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    } = body;

    if (
      !planName ||
      !billingCycle ||
      !razorpayOrderId ||
      !razorpayPaymentId ||
      !razorpaySignature
    ) {
      throw new HttpException(
        'Missing required fields',
        HttpStatus.BAD_REQUEST,
      );
    }

    const validPlans = ['STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      throw new HttpException('Invalid plan name', HttpStatus.BAD_REQUEST);
    }

    const { keySecret } = this.getRazorpayInstance();
    const expected = createHmac('sha256', keySecret)
      .update(`${razorpayOrderId.trim()}|${razorpayPaymentId.trim()}`)
      .digest('hex');

    const given = Buffer.from(razorpaySignature.trim(), 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new HttpException(
        { error: 'Payment could not be verified.', code: 'bad_signature' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const [plan, ownerUserId] = await Promise.all([
        this.prisma.subscription_plans.findUnique({
          where: { name: planName },
          select: { id: true },
        }),
        this.getOwnerUserId(account.accountId),
      ]);

      if (!plan) {
        throw new HttpException('Plan not found', HttpStatus.NOT_FOUND);
      }

      // A paid period starts the moment it is paid for. No trial window is
      // written here in either branch — see the header.
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(
        periodEnd.getMonth() + (billingCycle === 'yearly' ? 12 : 1),
      );

      const paid = {
        plan_id: plan.id,
        status: 'active' as const,
        billing_cycle: billingCycle as 'monthly' | 'yearly',
        current_period_start: now,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        razorpay_subscription_id: razorpayOrderId,
        payment_method: 'razorpay' as const,
      };

      await this.prisma.user_subscriptions.upsert({
        where: { user_id: ownerUserId },
        // Only the create branch touches the trial columns, and only to
        // say there was no trial: there is no row to preserve history on.
        create: {
          user_id: ownerUserId,
          trial_start_at: null,
          trial_end_at: null,
          ...paid,
        },
        update: paid,
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
