/**
 * Stripe payment integration
 * 
 * This module handles Stripe subscription creation, webhook processing,
 * and customer management.
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

function getSupabaseAdmin() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('[Stripe] Missing Supabase credentials');
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Initialize Stripe with your secret key
// In production, this should be loaded from environment variables
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

export interface StripeCheckoutSession {
  sessionId: string;
  url: string;
}

export interface StripeSubscriptionData {
  subscriptionId: string;
  customerId: string;
  status: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

/**
 * Create a Stripe checkout session for plan upgrade
 */
export async function createStripeCheckoutSession(
  userId: string,
  planName: 'STARTER' | 'GROWTH',
  billingCycle: 'monthly' | 'yearly'
): Promise<StripeCheckoutSession | null> {
  if (!stripe) {
    console.error('[Stripe] Stripe not initialized');
    return null;
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err: any) {
    console.error(err.message);
    return null;
  }

  try {
    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('user_id', userId)
      .single();

    if (!profile) {
      throw new Error('Profile not found');
    }

    // Check if customer already exists
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .single();

    let customerId: string;

    if (subscription?.stripe_subscription_id) {
      // Get existing customer from subscription
      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      customerId = stripeSub.customer as string;
    } else {
      // Create new customer
      const customer = await stripe.customers.create({
        email: profile.email,
        name: profile.full_name || undefined,
        metadata: {
          userId,
        },
      });
      customerId = customer.id;
    }

    // Get plan price ID from database
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('stripe_price_id_monthly, stripe_price_id_yearly')
      .eq('name', planName)
      .single();

    if (!plan || (!plan.stripe_price_id_monthly && !plan.stripe_price_id_yearly)) {
      throw new Error('Plan price ID not configured');
    }

    const priceId = billingCycle === 'monthly' 
      ? plan.stripe_price_id_monthly 
      : plan.stripe_price_id_yearly;

    if (!priceId) {
      throw new Error('Price ID not found for selected billing cycle');
    }

    // Create checkout session
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
      success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/pricing?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/pricing?canceled=true`,
      metadata: {
        userId,
        planName,
        billingCycle,
      },
    });

    return {
      sessionId: session.id,
      url: session.url || '',
    };
  } catch (error) {
    console.error('[Stripe] Error creating checkout session:', error);
    return null;
  }
}

/**
 * Handle Stripe webhook events
 */
export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  if (!stripe) {
    console.error('[Stripe] Stripe client not initialized');
    return;
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err: any) {
    console.error(err.message);
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const planName = session.metadata?.planName;
      const billingCycle = session.metadata?.billingCycle;

      if (!userId || !planName || !billingCycle) {
        console.error('[Stripe] Missing metadata in checkout session');
        return;
      }

      // Get plan ID
      const { data: plan } = await supabase
        .from('subscription_plans')
        .select('id, trial_days')
        .eq('name', planName)
        .single();

      if (!plan) {
        console.error('[Stripe] Plan not found:', planName);
        return;
      }

      // Get subscription details
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );

      // Calculate trial period
      const trialStart = plan.trial_days ? new Date() : null;
      const trialEnd = plan.trial_days 
        ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000) 
        : null;

      // Update or create user subscription
      const { error: upsertError } = await supabase
        .from('user_subscriptions')
        .upsert({
          user_id: userId,
          plan_id: plan.id,
          status: trialEnd ? 'trial' : 'active',
          billing_cycle: billingCycle as 'monthly' | 'yearly',
          trial_start_at: trialStart?.toISOString(),
          trial_end_at: trialEnd?.toISOString(),
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: subscription.cancel_at_period_end,
          stripe_subscription_id: subscription.id,
          payment_method: 'stripe',
        }, {
          onConflict: 'user_id',
        });

      if (upsertError) {
        console.error('[Stripe] Error upserting subscription:', upsertError);
      }

      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      // Get user ID from customer metadata
      const customer = await stripe.customers.retrieve(customerId);
      const userId = (customer as Stripe.Customer).metadata?.userId;

      if (!userId) {
        console.error('[Stripe] User ID not found in customer metadata');
        return;
      }

      // Update subscription status
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({
          status: subscription.status === 'trialing' ? 'trial' : 
                  subscription.status === 'past_due' ? 'past_due' :
                  subscription.status === 'canceled' ? 'cancelled' :
                  subscription.status === 'incomplete' ? 'expired' : 'active',
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: subscription.cancel_at_period_end,
        })
        .eq('stripe_subscription_id', subscription.id);

      if (updateError) {
        console.error('[Stripe] Error updating subscription:', updateError);
      }

      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;

      // Downgrade to FREE plan
      const { data: freePlan } = await supabase
        .from('subscription_plans')
        .select('id')
        .eq('name', 'FREE')
        .single();

      if (freePlan) {
        const { error: updateError } = await supabase
          .from('user_subscriptions')
          .update({
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
          })
          .eq('stripe_subscription_id', subscription.id);

        if (updateError) {
          console.error('[Stripe] Error downgrading subscription:', updateError);
        }
      }

      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      
      // Subscription renewed successfully - no action needed
      // The subscription.updated event will handle status updates
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      
      // Mark subscription as past_due
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', invoice.subscription as string);

      if (updateError) {
        console.error('[Stripe] Error marking subscription as past_due:', updateError);
      }

      break;
    }

    default:
      console.log(`[Stripe] Unhandled event type: ${event.type}`);
  }
}

/**
 * Cancel Stripe subscription
 */
export async function cancelStripeSubscription(userId: string): Promise<boolean> {
  if (!stripe) {
    console.error('[Stripe] Stripe not initialized');
    return false;
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err: any) {
    console.error(err.message);
    return false;
  }

  try {
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .single();

    if (!subscription?.stripe_subscription_id) {
      return false;
    }

    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    return true;
  } catch (error) {
    console.error('[Stripe] Error canceling subscription:', error);
    return false;
  }
}
