import { Controller, Post, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as express from 'express';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCreditsService } from '../../ai/credits/ai-credits.service';

@Controller('webhooks')
export class SubscriptionWebhooksController {
  private readonly logger = new Logger(SubscriptionWebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiCredits: AiCreditsService,
  ) {}

  /**
   * POST /api/webhooks/razorpay
   * Handles Razorpay webhook events (payment, subscription lifecycle).
   */
  @Post('razorpay')
  async handleRazorpayWebhook(
    @Req() req: RawBodyRequest<express.Request>,
    @Res() res: express.Response,
  ) {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

    if (!signature) {
      this.logger.warn('Razorpay webhook: Missing x-razorpay-signature');
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Missing signature' });
    }

    const rawBody = req.rawBody ?? Buffer.from('');
    const bodyStr = rawBody.toString('utf8');

    // Verify webhook signature with timingSafeEqual
    if (webhookSecret) {
      const expected = createHmac('sha256', webhookSecret)
        .update(bodyStr)
        .digest('hex');
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      const isValid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

      if (!isValid) {
        this.logger.warn('Razorpay webhook signature verification failed');
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'Invalid signature' });
      }
    }

    try {
      const event = JSON.parse(bodyStr);
      this.logger.log(`Received Razorpay webhook event: ${event.event}`);

      switch (event.event) {
        case 'payment.authorized':
        case 'payment.captured':
        case 'order.paid': {
          const payment =
            event.payload.payment?.entity || event.payload.order?.entity;
          const notes = payment?.notes;

          // An AI credit top-up is a one-time payment on the same
          // webhook as plan payments, told apart by the `kind` note we
          // set when creating the order. It must be handled BEFORE the
          // plan-metadata check below, which would otherwise dismiss it
          // as a malformed subscription payment and drop the credits on
          // the floor for anyone who closed the tab.
          if (notes?.kind === 'ai_credits') {
            const gatewayOrderId = payment.order_id || payment.id;
            const credited = await this.aiCredits.creditByGatewayOrderId(
              gatewayOrderId,
              payment.id,
            );
            this.logger.log(
              credited
                ? `AI credits granted for Razorpay order ${gatewayOrderId}`
                : `Razorpay webhook: no AI credit order for ${gatewayOrderId}`,
            );
            return res.status(HttpStatus.OK).json({ received: true });
          }

          if (
            !notes ||
            !notes.userId ||
            !notes.planName ||
            !notes.billingCycle
          ) {
            this.logger.error(
              'Razorpay webhook: Missing metadata in payment/order',
            );
            return res.status(HttpStatus.OK).json({ received: true });
          }

          const { userId, planName, billingCycle } = notes;

          // Get plan ID
          const plan = await this.prisma.subscription_plans.findUnique({
            where: { name: planName },
            select: { id: true, trial_days: true },
          });

          if (!plan) {
            this.logger.error(`Razorpay webhook: Plan not found: ${planName}`);
            return res.status(HttpStatus.OK).json({ received: true });
          }

          /**
           * ⚠️ MONEY ARRIVED, SO THE STATUS IS `active`. FULL STOP.
           *
           * This block used to run the same status maths as a plan CHANGE:
           * grant a trial if the workspace had not used one, otherwise carry
           * the old window forward and land `expired` if it had lapsed. On a
           * plan change with no money involved that is right. Here it was
           * catastrophic, twice over:
           *
           *   - A lapsed customer paying to get back in was set straight
           *     back to `expired` by their own successful payment — and this
           *     webhook lands seconds AFTER the browser's confirm-payment,
           *     so it overwrote the `active` that had just let them in. Pay,
           *     get in, get thrown out.
           *   - A first-time payer with no trial yet was marked `trial` with
           *     a fresh 15-day window, so the subscription sweep expired
           *     them a fortnight after they paid, and MRR never counted
           *     them.
           *
           * Neither trial column is written here at all: they are the record
           * of whatever trial this workspace already had, and paying does
           * not change that history. `trial_granted_at` is likewise left
           * alone — this path no longer grants a trial, so it has no latch
           * to set.
           */
          const now = new Date();
          const periodEnd = new Date(now);
          periodEnd.setMonth(
            periodEnd.getMonth() + (billingCycle === 'yearly' ? 12 : 1),
          );

          const paid = {
            plan_id: plan.id,
            status: 'active' as const,
            billing_cycle: billingCycle,
            current_period_start: now,
            current_period_end: periodEnd,
            cancel_at_period_end: false,
            razorpay_subscription_id: payment.order_id || payment.id,
            payment_method: 'razorpay' as const,
          };

          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            // Only the create branch mentions the trial columns, and only to
            // say there was no trial: there is no history to preserve.
            create: {
              user_id: userId,
              trial_start_at: null,
              trial_end_at: null,
              ...paid,
            },
            update: paid,
          });

          this.logger.log(`Razorpay payment recorded for user: ${userId}`);
          break;
        }

        case 'subscription.activated':
        case 'subscription.authenticated': {
          const subscription = event.payload.subscription.entity;
          const userId = subscription.notes?.userId;
          const planName = subscription.notes?.planName;
          const billingCycle = subscription.notes?.billingCycle;

          if (!userId || !planName || !billingCycle) {
            this.logger.error(
              'Razorpay webhook: Missing metadata in subscription',
            );
            return res.status(HttpStatus.OK).json({ received: true });
          }

          // Get plan ID
          const plan = await this.prisma.subscription_plans.findUnique({
            where: { name: planName },
            select: { id: true, trial_days: true },
          });

          if (!plan) {
            this.logger.error(`Razorpay webhook: Plan not found: ${planName}`);
            return res.status(HttpStatus.OK).json({ received: true });
          }

          // ONE TRIAL PER WORKSPACE, EVER (migration 074). Check if trial was
          // already granted before giving out another one on plan change.
          const [existing, profile] = await Promise.all([
            this.prisma.user_subscriptions.findUnique({
              where: { user_id: userId },
              select: { trial_start_at: true, trial_end_at: true },
            }),
            this.prisma.profile.findUnique({
              where: { userId },
              select: { accountId: true },
            }),
          ]);

          const onboarding = profile
            ? await this.prisma.account_onboarding.findUnique({
                where: { account_id: profile.accountId },
                select: { trial_granted_at: true },
              })
            : null;

          const trialAlreadyUsed =
            onboarding?.trial_granted_at != null ||
            existing?.trial_start_at != null;
          const grantTrial = (plan.trial_days ?? 0) > 0 && !trialAlreadyUsed;

          const trialStart = grantTrial ? new Date() : null;
          const trialEnd = grantTrial
            ? new Date(
                Date.now() + (plan.trial_days ?? 0) * 24 * 60 * 60 * 1000,
              )
            : (existing?.trial_end_at ?? null);

          /**
           * ⚠️ NEVER `expired` HERE. Razorpay has activated a subscription
           * and is charging the customer; the old maths landed `expired`
           * whenever the workspace had already used its trial, which turned
           * a live paying mandate into a locked-out account. The trial branch
           * stays — a gateway subscription may legitimately open with one,
           * and the subscription sweep leaves gateway-backed rows alone — but
           * the fallback for "no trial to grant" is that they are paying.
           */
          const status = grantTrial ? 'trial' : 'active';

          // Update or create user subscription
          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            create: {
              user_id: userId,
              plan_id: plan.id,
              status,
              billing_cycle: billingCycle,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: new Date(subscription.current_start * 1000),
              current_period_end: new Date(subscription.current_end * 1000),
              cancel_at_period_end: false,
              razorpay_subscription_id: subscription.id,
              payment_method: 'razorpay',
            },
            update: {
              plan_id: plan.id,
              status,
              billing_cycle: billingCycle,
              ...(grantTrial
                ? {
                    trial_start_at: trialStart,
                    trial_end_at: trialEnd,
                  }
                : {}),
              current_period_start: new Date(subscription.current_start * 1000),
              current_period_end: new Date(subscription.current_end * 1000),
              cancel_at_period_end: false,
              razorpay_subscription_id: subscription.id,
              payment_method: 'razorpay',
            },
          });

          if (grantTrial && profile && !onboarding?.trial_granted_at) {
            await this.prisma.account_onboarding.upsert({
              where: { account_id: profile.accountId },
              create: {
                account_id: profile.accountId,
                trial_granted_at: new Date(),
              },
              update: { trial_granted_at: new Date() },
            });
          }

          this.logger.log(
            `Razorpay subscription activated for user: ${userId}`,
          );
          break;
        }

        case 'subscription.updated': {
          const subscription = event.payload.subscription.entity;

          const dbStatus =
            subscription.status === 'active'
              ? 'active'
              : subscription.status === 'completed'
                ? 'active'
                : subscription.status === 'cancelled'
                  ? 'cancelled'
                  : subscription.status === 'pending'
                    ? 'past_due'
                    : 'active';

          await this.prisma.user_subscriptions.updateMany({
            where: { razorpay_subscription_id: subscription.id },
            data: {
              status: dbStatus,
              current_period_start: new Date(subscription.current_start * 1000),
              current_period_end: new Date(subscription.current_end * 1000),
            },
          });

          this.logger.log(`Razorpay subscription updated: ${subscription.id}`);
          break;
        }

        case 'subscription.cancelled': {
          const subscription = event.payload.subscription.entity;

          // There is no free tier to fall back to (migration 066
          // deactivated FREE), so cancellation ends entitlement rather
          // than downgrading. `plan_id` is left pointing at whatever
          // they had: it is the only record of what was cancelled, and
          // the admin panel's history joins through it.
          //
          // The dashboard gate treats a non-active/non-trial
          // subscription as "must choose a plan" and routes them back
          // to /welcome.
          await this.prisma.user_subscriptions.updateMany({
            where: { razorpay_subscription_id: subscription.id },
            data: {
              status: 'cancelled',
              billing_cycle: null,
              trial_start_at: null,
              trial_end_at: null,
              current_period_end: new Date(),
              cancel_at_period_end: false,
              razorpay_subscription_id: null,
              payment_method: 'manual',
            },
          });
          this.logger.log(
            `Razorpay subscription cancelled: ${subscription.id}`,
          );
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.payload.invoice.entity;

          await this.prisma.user_subscriptions.updateMany({
            where: { razorpay_subscription_id: invoice.subscription_id },
            data: { status: 'past_due' },
          });

          this.logger.log(`Razorpay invoice payment failed: ${invoice.id}`);
          break;
        }

        default:
          this.logger.log(`Unhandled Razorpay event: ${event.event}`);
      }

      return res.status(HttpStatus.OK).json({ received: true });
    } catch (error) {
      this.logger.error('Razorpay webhook handler error', error);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Webhook handler failed' });
    }
  }

  /**
   * POST /api/webhooks/stripe
   * Handles Stripe webhook events (payment, subscription lifecycle).
   */
  @Post('stripe')
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<express.Request>,
    @Res() res: express.Response,
  ) {
    const signature = req.headers['stripe-signature'] as string | undefined;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

    if (!signature) {
      this.logger.warn('Stripe webhook: Missing stripe-signature');
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Missing signature' });
    }

    if (!stripeSecretKey) {
      this.logger.error('Stripe webhook: Stripe secret key is not configured');
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Stripe not configured' });
    }

    const stripe = new Stripe(stripeSecretKey);
    const rawBody = req.rawBody ?? Buffer.from('');

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      this.logger.warn(
        `Stripe webhook signature verification failed: ${err.message}`,
      );
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid signature' });
    }

    try {
      this.logger.log(`Received Stripe webhook event: ${event.type}`);

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const userId = session.metadata?.userId;
          const planName = session.metadata?.planName;
          const billingCycle = session.metadata?.billingCycle;

          if (!userId || !planName || !billingCycle) {
            this.logger.error(
              'Stripe webhook: Missing metadata in checkout session',
            );
            return res.status(HttpStatus.OK).json({ received: true });
          }

          // Get plan ID
          const plan = await this.prisma.subscription_plans.findUnique({
            where: { name: planName },
            select: { id: true, trial_days: true },
          });

          if (!plan) {
            this.logger.error(`Stripe webhook: Plan not found: ${planName}`);
            return res.status(HttpStatus.OK).json({ received: true });
          }

          // Get subscription details from Stripe API
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription as string,
          );

          // ONE TRIAL PER WORKSPACE, EVER (migration 074). Check if trial was
          // already granted before giving out another one on plan change.
          const [existing, profile] = await Promise.all([
            this.prisma.user_subscriptions.findUnique({
              where: { user_id: userId },
              select: { trial_start_at: true, trial_end_at: true },
            }),
            this.prisma.profile.findUnique({
              where: { userId },
              select: { accountId: true },
            }),
          ]);

          const onboarding = profile
            ? await this.prisma.account_onboarding.findUnique({
                where: { account_id: profile.accountId },
                select: { trial_granted_at: true },
              })
            : null;

          const trialAlreadyUsed =
            onboarding?.trial_granted_at != null ||
            existing?.trial_start_at != null;
          const grantTrial = (plan.trial_days ?? 0) > 0 && !trialAlreadyUsed;

          const trialStart = grantTrial ? new Date() : null;
          const trialEnd = grantTrial
            ? new Date(
                Date.now() + (plan.trial_days ?? 0) * 24 * 60 * 60 * 1000,
              )
            : (existing?.trial_end_at ?? null);

          /**
           * ⚠️ NEVER `expired` HERE — same fix as the Razorpay subscription
           * branch above. Stripe has completed a checkout, so the customer is
           * paying; landing `expired` because the workspace had already used
           * its free trial locked out the very people who had just paid.
           */
          const status = grantTrial ? 'trial' : 'active';

          // Update or create user subscription
          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            create: {
              user_id: userId,
              plan_id: plan.id,
              status,
              billing_cycle: billingCycle as any,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: new Date(
                subscription.current_period_start * 1000,
              ),
              current_period_end: new Date(
                subscription.current_period_end * 1000,
              ),
              cancel_at_period_end: subscription.cancel_at_period_end,
              stripe_subscription_id: subscription.id,
              payment_method: 'stripe',
            },
            update: {
              plan_id: plan.id,
              status,
              billing_cycle: billingCycle as any,
              ...(grantTrial
                ? {
                    trial_start_at: trialStart,
                    trial_end_at: trialEnd,
                  }
                : {}),
              current_period_start: new Date(
                subscription.current_period_start * 1000,
              ),
              current_period_end: new Date(
                subscription.current_period_end * 1000,
              ),
              cancel_at_period_end: subscription.cancel_at_period_end,
              stripe_subscription_id: subscription.id,
              payment_method: 'stripe',
            },
          });

          if (grantTrial && profile && !onboarding?.trial_granted_at) {
            await this.prisma.account_onboarding.upsert({
              where: { account_id: profile.accountId },
              create: {
                account_id: profile.accountId,
                trial_granted_at: new Date(),
              },
              update: { trial_granted_at: new Date() },
            });
          }

          this.logger.log(
            `Stripe subscription checkout completed for user: ${userId}`,
          );
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const customerId = subscription.customer as string;

          // Retrieve Stripe customer metadata to find userId
          const customer = await stripe.customers.retrieve(customerId);
          const userId = (customer as Stripe.Customer).metadata?.userId;

          if (!userId) {
            this.logger.error(
              'Stripe webhook: User ID not found in customer metadata',
            );
            return res.status(HttpStatus.OK).json({ received: true });
          }

          const dbStatus =
            subscription.status === 'trialing'
              ? 'trial'
              : subscription.status === 'past_due'
                ? 'past_due'
                : subscription.status === 'canceled'
                  ? 'cancelled'
                  : subscription.status === 'incomplete'
                    ? 'expired'
                    : 'active';

          await this.prisma.user_subscriptions.updateMany({
            where: { stripe_subscription_id: subscription.id },
            data: {
              status: dbStatus as any,
              current_period_start: new Date(
                subscription.current_period_start * 1000,
              ),
              current_period_end: new Date(
                subscription.current_period_end * 1000,
              ),
              cancel_at_period_end: subscription.cancel_at_period_end,
            },
          });

          this.logger.log(`Stripe subscription updated: ${subscription.id}`);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;

          // Same reasoning as the Razorpay cancellation above: no free
          // tier exists to land on, so entitlement ends and the account
          // is sent back through the plan picker.
          await this.prisma.user_subscriptions.updateMany({
            where: { stripe_subscription_id: subscription.id },
            data: {
              status: 'cancelled',
              billing_cycle: null,
              trial_start_at: null,
              trial_end_at: null,
              current_period_end: new Date(),
              cancel_at_period_end: false,
              stripe_subscription_id: null,
              payment_method: 'manual',
            },
          });
          this.logger.log(`Stripe subscription deleted: ${subscription.id}`);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;

          await this.prisma.user_subscriptions.updateMany({
            where: { stripe_subscription_id: invoice.subscription as string },
            data: { status: 'past_due' },
          });

          this.logger.log(`Stripe invoice payment failed: ${invoice.id}`);
          break;
        }

        default:
          this.logger.log(`Unhandled Stripe event: ${event.type}`);
      }

      return res.status(HttpStatus.OK).json({ received: true });
    } catch (error) {
      this.logger.error('Stripe webhook handler error', error);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Webhook handler failed' });
    }
  }
}
