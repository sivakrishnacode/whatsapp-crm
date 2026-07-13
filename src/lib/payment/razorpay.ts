/**
 * Razorpay payment integration
 * 
 * This module handles Razorpay subscription creation, webhook processing,
 * and customer management.
 */

import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

function getSupabaseAdmin() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('[Razorpay] Missing Supabase credentials');
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Initialize Razorpay with your keys
// In production, these should be loaded from environment variables
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_TCs9rejtWDeydM';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '9tq5Z9DoY15XhiRHyDauIPgt';
const razorpay = razorpayKeyId && razorpayKeySecret ? new Razorpay({
  key_id: razorpayKeyId,
  key_secret: razorpayKeySecret,
}) : null;

export interface RazorpayOrderData {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

export interface RazorpaySubscriptionData {
  subscriptionId: string;
  status: string;
  currentStart: number;
  currentEnd: number;
}

/**
 * Create a Razorpay order for one-time payment (plan upgrade)
 */
export async function createRazorpayOrder(
  userId: string,
  planName: 'STARTER' | 'GROWTH',
  billingCycle: 'monthly' | 'yearly'
): Promise<RazorpayOrderData | null> {
  if (!razorpay) {
    console.error('[Razorpay] Razorpay not initialized');
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
    // Get plan details
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('price_monthly, price_yearly')
      .eq('name', planName)
      .single();

    if (!plan) {
      throw new Error('Plan not found');
    }

    const amount = billingCycle === 'monthly' ? plan.price_monthly : plan.price_yearly;
    const amountInPaise = Math.round(amount * 100); // Razorpay uses smallest currency unit

    // Create order
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `ord_${userId.substring(0, 8)}_${Date.now().toString().slice(-6)}`,
      notes: {
        userId,
        planName,
        billingCycle,
      },
    });

    return {
      orderId: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      keyId: razorpayKeyId,
    };
  } catch (error) {
    console.error('[Razorpay] Error creating order:', error);
    return null;
  }
}

/**
 * Create a Razorpay subscription for recurring payments
 */
export async function createRazorpaySubscription(
  userId: string,
  planName: 'STARTER' | 'GROWTH',
  billingCycle: 'monthly' | 'yearly'
): Promise<RazorpaySubscriptionData | null> {
  if (!razorpay) {
    console.error('[Razorpay] Razorpay not initialized');
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
    // Get plan details
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('price_monthly, price_yearly, trial_days, razorpay_plan_id')
      .eq('name', planName)
      .single();

    if (!plan) {
      throw new Error('Plan not found');
    }

    const amount = billingCycle === 'monthly' ? plan.price_monthly : plan.price_yearly;
    const amountInPaise = Math.round(amount * 100);

    // Calculate subscription period
    const period = billingCycle === 'monthly' ? 'monthly' : 'yearly';

    // Create subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpay_plan_id || '', // This needs to be configured in Razorpay dashboard
      total_count: 12, // 12 billing cycles
      customer_notify: true,
      notes: {
        userId,
        planName,
        billingCycle,
      },
    });

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      currentStart: Number(subscription.current_start || 0),
      currentEnd: Number(subscription.current_end || 0),
    };
  } catch (error) {
    console.error('[Razorpay] Error creating subscription:', error);
    return null;
  }
}

/**
 * Verify Razorpay webhook signature
 */
export function verifyRazorpayWebhook(
  webhookBody: string,
  webhookSignature: string,
  webhookSecret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(webhookBody)
    .digest('hex');

  return expectedSignature === webhookSignature;
}

/**
 * Handle Razorpay webhook events
 */
export async function handleRazorpayWebhook(event: any): Promise<void> {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
    // Decode the key for debugging to see which role/claims it has
    if (supabaseServiceKey) {
      const parts = supabaseServiceKey.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('[Razorpay Debug] Webhook executing with service key. Role claim:', payload.role);
      }
    }
  } catch (err: any) {
    console.error('[Razorpay] Error initializing client:', err.message);
    return;
  }

  switch (event.event) {
    case 'payment.authorized':
    case 'payment.captured':
    case 'order.paid': {
      const payment = event.payload.payment?.entity || event.payload.order?.entity;
      const notes = payment?.notes;

      if (!notes || !notes.userId || !notes.planName || !notes.billingCycle) {
        console.error('[Razorpay] Missing metadata in payment/order');
        return;
      }

      const { userId, planName, billingCycle } = notes;

      // Get plan ID
      const { data: plan } = await supabase
        .from('subscription_plans')
        .select('id, trial_days')
        .eq('name', planName)
        .single();

      if (!plan) {
        console.error('[Razorpay] Plan not found:', planName);
        return;
      }

      // Calculate trial period
      const trialStart = plan.trial_days ? new Date() : null;
      const trialEnd = plan.trial_days
        ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000)
        : null;

      // Calculate billing period
      const now = new Date();
      const periodStart = trialEnd || now;
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === 'yearly' ? 12 : 1));

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
          current_period_start: periodStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          cancel_at_period_end: false,
          razorpay_subscription_id: payment.order_id || payment.id,
          payment_method: 'razorpay',
        }, {
          onConflict: 'user_id',
        });

      if (upsertError) {
        console.error('[Razorpay] Error upserting subscription:', upsertError);
      } else {
        console.log('[Razorpay] Subscription updated successfully for user:', userId);
      }

      break;
    }

    case 'subscription.activated':
    case 'subscription.authenticated': {
      const subscription = event.payload.subscription.entity;
      const userId = subscription.notes?.userId;
      const planName = subscription.notes?.planName;
      const billingCycle = subscription.notes?.billingCycle;

      if (!userId || !planName || !billingCycle) {
        console.error('[Razorpay] Missing metadata in subscription');
        return;
      }

      // Get plan ID
      const { data: plan } = await supabase
        .from('subscription_plans')
        .select('id, trial_days')
        .eq('name', planName)
        .single();

      if (!plan) {
        console.error('[Razorpay] Plan not found:', planName);
        return;
      }

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
          current_period_start: new Date(subscription.current_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_end * 1000).toISOString(),
          cancel_at_period_end: false,
          razorpay_subscription_id: subscription.id,
          payment_method: 'razorpay',
        }, {
          onConflict: 'user_id',
        });

      if (upsertError) {
        console.error('[Razorpay] Error upserting subscription:', upsertError);
      }

      break;
    }

    case 'subscription.updated': {
      const subscription = event.payload.subscription.entity;

      // Update subscription status
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({
          status: subscription.status === 'active' ? 'active' : 
                  subscription.status === 'completed' ? 'active' :
                  subscription.status === 'cancelled' ? 'cancelled' :
                  subscription.status === 'pending' ? 'past_due' : 'active',
          current_period_start: new Date(subscription.current_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_end * 1000).toISOString(),
        })
        .eq('razorpay_subscription_id', subscription.id);

      if (updateError) {
        console.error('[Razorpay] Error updating subscription:', updateError);
      }

      break;
    }

    case 'subscription.cancelled': {
      const subscription = event.payload.subscription.entity;

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
            razorpay_subscription_id: null,
            payment_method: 'manual',
          })
          .eq('razorpay_subscription_id', subscription.id);

        if (updateError) {
          console.error('[Razorpay] Error downgrading subscription:', updateError);
        }
      }

      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.payload.invoice.entity;
      
      // Mark subscription as past_due
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({ status: 'past_due' })
        .eq('razorpay_subscription_id', invoice.subscription_id);

      if (updateError) {
        console.error('[Razorpay] Error marking subscription as past_due:', updateError);
      }

      break;
    }

    default:
      console.log(`[Razorpay] Unhandled event type: ${event.event}`);
  }
}

/**
 * Cancel Razorpay subscription
 */
export async function cancelRazorpaySubscription(userId: string): Promise<boolean> {
  if (!razorpay) {
    console.error('[Razorpay] Razorpay not initialized');
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
      .select('razorpay_subscription_id')
      .eq('user_id', userId)
      .single();

    if (!subscription?.razorpay_subscription_id) {
      return false;
    }

    await razorpay.subscriptions.cancel(subscription.razorpay_subscription_id);

    return true;
  } catch (error) {
    console.error('[Razorpay] Error canceling subscription:', error);
    return false;
  }
}
