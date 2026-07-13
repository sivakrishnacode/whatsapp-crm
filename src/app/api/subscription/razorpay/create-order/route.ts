/**
 * API route to create Razorpay order for plan upgrade
 */

import { createClient } from '@/lib/supabase/server';
import { createRazorpayOrder } from '@/lib/payment/razorpay';
import { NextRequest, NextResponse } from 'next/server';
import type { PlanName } from '@/lib/subscription/plans';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { planName, billingCycle } = body;

    if (!planName || !billingCycle) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const validPlans: PlanName[] = ['STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      return NextResponse.json({ error: 'Invalid plan name' }, { status: 400 });
    }

    const orderData = await createRazorpayOrder(user.id, planName, billingCycle as 'monthly' | 'yearly');

    if (!orderData) {
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    return NextResponse.json(orderData);
  } catch (error) {
    console.error('[API razorpay/create-order] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
