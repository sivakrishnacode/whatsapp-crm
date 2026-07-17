import {
  Controller,
  Post,
  Req,
  Res,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as express from 'express';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('webhooks')
export class SubscriptionWebhooksController {
  private readonly logger = new Logger(SubscriptionWebhooksController.name);

  constructor(private readonly prisma: PrismaService) {}

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
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Missing signature' });
    }

    const rawBody = req.rawBody ?? Buffer.from('');
    const bodyStr = rawBody.toString('utf8');

    // Verify webhook signature with timingSafeEqual
    if (webhookSecret) {
      const expected = createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      const isValid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

      if (!isValid) {
        this.logger.warn('Razorpay webhook signature verification failed');
        return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid signature' });
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

          if (
            !notes ||
            !notes.userId ||
            !notes.planName ||
            !notes.billingCycle
          ) {
            this.logger.error('Razorpay webhook: Missing metadata in payment/order');
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

          // Calculate period dates
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

          // Update or create user subscription
          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            create: {
              user_id: userId,
              plan_id: plan.id,
              status: trialEnd ? 'trial' : 'active',
              billing_cycle: billingCycle,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              cancel_at_period_end: false,
              razorpay_subscription_id: payment.order_id || payment.id,
              payment_method: 'razorpay',
            },
            update: {
              plan_id: plan.id,
              status: trialEnd ? 'trial' : 'active',
              billing_cycle: billingCycle,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              cancel_at_period_end: false,
              razorpay_subscription_id: payment.order_id || payment.id,
              payment_method: 'razorpay',
            },
          });

          this.logger.log(`Razorpay subscription updated for user: ${userId}`);
          break;
        }

        case 'subscription.activated':
        case 'subscription.authenticated': {
          const subscription = event.payload.subscription.entity;
          const userId = subscription.notes?.userId;
          const planName = subscription.notes?.planName;
          const billingCycle = subscription.notes?.billingCycle;

          if (!userId || !planName || !billingCycle) {
            this.logger.error('Razorpay webhook: Missing metadata in subscription');
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

          const trialStart = plan.trial_days ? new Date() : null;
          const trialEnd = plan.trial_days
            ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000)
            : null;

          // Update or create user subscription
          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            create: {
              user_id: userId,
              plan_id: plan.id,
              status: trialEnd ? 'trial' : 'active',
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
              status: trialEnd ? 'trial' : 'active',
              billing_cycle: billingCycle,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: new Date(subscription.current_start * 1000),
              current_period_end: new Date(subscription.current_end * 1000),
              cancel_at_period_end: false,
              razorpay_subscription_id: subscription.id,
              payment_method: 'razorpay',
            },
          });

          this.logger.log(`Razorpay subscription activated for user: ${userId}`);
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

          // Downgrade to FREE plan
          const freePlan = await this.prisma.subscription_plans.findUnique({
            where: { name: 'FREE' },
            select: { id: true },
          });

          if (freePlan) {
            await this.prisma.user_subscriptions.updateMany({
              where: { razorpay_subscription_id: subscription.id },
              data: {
                plan_id: freePlan.id,
                status: 'active',
                billing_cycle: null,
                trial_start_at: null,
                trial_end_at: null,
                current_period_start: null,
                current_period_end: null,
                cancel_at_period_end: false,
                razorpay_subscription_id: null,
                payment_method: 'manual',
              },
            });
            this.logger.log(`Razorpay subscription cancelled and downgraded: ${subscription.id}`);
          }
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
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Missing signature' });
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
      this.logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid signature' });
    }

    try {
      this.logger.log(`Received Stripe webhook event: ${event.type}`);

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.metadata?.userId;
          const planName = session.metadata?.planName;
          const billingCycle = session.metadata?.billingCycle;

          if (!userId || !planName || !billingCycle) {
            this.logger.error('Stripe webhook: Missing metadata in checkout session');
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

          const trialStart = plan.trial_days ? new Date() : null;
          const trialEnd = plan.trial_days
            ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000)
            : null;

          // Update or create user subscription
          await this.prisma.user_subscriptions.upsert({
            where: { user_id: userId },
            create: {
              user_id: userId,
              plan_id: plan.id,
              status: trialEnd ? 'trial' : 'active',
              billing_cycle: billingCycle as any,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: new Date(subscription.current_period_start * 1000),
              current_period_end: new Date(subscription.current_period_end * 1000),
              cancel_at_period_end: subscription.cancel_at_period_end,
              stripe_subscription_id: subscription.id,
              payment_method: 'stripe',
            },
            update: {
              plan_id: plan.id,
              status: trialEnd ? 'trial' : 'active',
              billing_cycle: billingCycle as any,
              trial_start_at: trialStart,
              trial_end_at: trialEnd,
              current_period_start: new Date(subscription.current_period_start * 1000),
              current_period_end: new Date(subscription.current_period_end * 1000),
              cancel_at_period_end: subscription.cancel_at_period_end,
              stripe_subscription_id: subscription.id,
              payment_method: 'stripe',
            },
          });

          this.logger.log(`Stripe subscription checkout completed for user: ${userId}`);
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;

          // Retrieve Stripe customer metadata to find userId
          const customer = await stripe.customers.retrieve(customerId);
          const userId = (customer as Stripe.Customer).metadata?.userId;

          if (!userId) {
            this.logger.error('Stripe webhook: User ID not found in customer metadata');
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
              current_period_start: new Date(subscription.current_period_start * 1000),
              current_period_end: new Date(subscription.current_period_end * 1000),
              cancel_at_period_end: subscription.cancel_at_period_end,
            },
          });

          this.logger.log(`Stripe subscription updated: ${subscription.id}`);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;

          // Downgrade to FREE plan
          const freePlan = await this.prisma.subscription_plans.findUnique({
            where: { name: 'FREE' },
            select: { id: true },
          });

          if (freePlan) {
            await this.prisma.user_subscriptions.updateMany({
              where: { stripe_subscription_id: subscription.id },
              data: {
                plan_id: freePlan.id,
                status: 'active',
                billing_cycle: null,
                trial_start_at: null,
                trial_end_at: null,
                current_period_start: null,
                current_period_end: null,
                cancel_at_period_end: false,
                stripe_subscription_id: null,
                payment_method: 'manual',
              },
            });
            this.logger.log(`Stripe subscription deleted and downgraded: ${subscription.id}`);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;

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
