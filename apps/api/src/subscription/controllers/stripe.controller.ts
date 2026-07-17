import {
  Controller,
  Post,
  Body,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import Stripe from 'stripe';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('subscription/stripe')
@UseGuards(SupabaseAuthGuard)
export class StripeController {
  private getStripeInstance(): Stripe {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new HttpException(
        'Stripe secret key is not configured on the server.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return new Stripe(secretKey);
  }

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/subscription/stripe/create-checkout-session
   * Creates a Stripe checkout session for plan upgrade.
   */
  @Post('create-checkout-session')
  async createCheckoutSession(
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

    const stripe = this.getStripeInstance();

    try {
      // 1. Get user profile
      const profile = await this.prisma.profile.findUnique({
        where: { userId: account.userId },
        select: { email: true, fullName: true },
      });

      if (!profile) {
        throw new HttpException('User profile not found', HttpStatus.NOT_FOUND);
      }

      // 2. Get existing customer if available
      const subscription = await this.prisma.user_subscriptions.findUnique({
        where: { user_id: account.userId },
        select: { stripe_subscription_id: true },
      });

      let customerId: string;
      if (subscription?.stripe_subscription_id) {
        const stripeSub = await stripe.subscriptions.retrieve(
          subscription.stripe_subscription_id,
        );
        customerId = stripeSub.customer as string;
      } else {
        const customer = await stripe.customers.create({
          email: profile.email,
          name: profile.fullName || undefined,
          metadata: {
            userId: account.userId,
          },
        });
        customerId = customer.id;
      }

      // 3. Get plan details
      const plan = await this.prisma.subscription_plans.findUnique({
        where: { name: planName },
        select: { stripe_price_id_monthly: true, stripe_price_id_yearly: true },
      });

      if (
        !plan ||
        (!plan.stripe_price_id_monthly && !plan.stripe_price_id_yearly)
      ) {
        throw new HttpException(
          'Plan price ID is not configured in the database',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const priceId =
        billingCycle === 'monthly'
          ? plan.stripe_price_id_monthly
          : plan.stripe_price_id_yearly;

      if (!priceId) {
        throw new HttpException(
          'Price ID not found for selected billing cycle',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 4. Create Stripe checkout session
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `${appUrl}/pricing?success=true`,
        cancel_url: `${appUrl}/pricing?canceled=true`,
        metadata: {
          userId: account.userId,
          planName,
          billingCycle,
        },
      });

      return {
        sessionId: session.id,
        url: session.url || '',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to create Stripe checkout session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
