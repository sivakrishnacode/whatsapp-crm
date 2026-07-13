/**
 * API route for admin to manually assign a plan to a user
 * POST: Assign a plan to a user
 */

import { createClient } from '@/lib/supabase/server';
import { assignPlanToUser } from '@/lib/subscription/admin';
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
    const { targetUserId, planName } = body;

    if (!targetUserId || !planName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const validPlans: PlanName[] = ['FREE', 'STARTER', 'GROWTH'];
    if (!validPlans.includes(planName)) {
      return NextResponse.json({ error: 'Invalid plan name' }, { status: 400 });
    }

    const result = await assignPlanToUser(user.id, targetUserId, planName);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API admin/assign-plan] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
