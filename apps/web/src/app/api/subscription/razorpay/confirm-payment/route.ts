/**
 * API route to confirm payment and update subscription immediately
 * This is called after successful Razorpay payment to update the subscription
 * without waiting for webhook
 */

import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import type { PlanName } from '@/lib/subscription/plans';

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Create server client to authenticate user session via cookies
    const supabase = await createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error('[API razorpay/confirm-payment] Authentication failed:', authError?.message);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Create service role client for privileged DB operations (bypasses RLS)
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const body = await request.json();
    const { planName, billingCycle, razorpayOrderId, razorpayPaymentId } = body;

    if (!planName || !billingCycle || !razorpayOrderId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const validPlans: PlanName[] = ['STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      return NextResponse.json({ error: 'Invalid plan name' }, { status: 400 });
    }

    // Get plan ID
    const { data: plan, error: planError } = await adminClient
      .from('subscription_plans')
      .select('id, trial_days')
      .eq('name', planName)
      .single();

    if (planError || !plan) {
      console.error('[API razorpay/confirm-payment] Plan not found or error:', planError);
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
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

    // Update or create user subscription using service role (bypasses RLS)
    const { error: upsertError, data: upsertData } = await adminClient
      .from('user_subscriptions')
      .upsert({
        user_id: user.id,
        plan_id: plan.id,
        status: trialEnd ? 'trial' : 'active',
        billing_cycle: billingCycle as 'monthly' | 'yearly',
        trial_start_at: trialStart?.toISOString(),
        trial_end_at: trialEnd?.toISOString(),
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        cancel_at_period_end: false,
        razorpay_subscription_id: razorpayOrderId,
        payment_method: 'razorpay',
      }, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error('[API razorpay/confirm-payment] Error upserting subscription:', upsertError);
      console.error('[API razorpay/confirm-payment] Details:', {
        userId: user.id,
        planId: plan.id,
        status: trialEnd ? 'trial' : 'active',
        billingCycle,
      });
      return NextResponse.json({ error: 'Failed to update subscription', details: upsertError.message }, { status: 500 });
    }

    console.log('[API razorpay/confirm-payment] Subscription updated successfully:', upsertData);
    return NextResponse.json({ success: true, planName });
  } catch (error) {
    console.error('[API razorpay/confirm-payment] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
