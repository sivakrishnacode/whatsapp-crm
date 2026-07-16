/**
 * API route for admin to get all users with subscriptions
 * GET: Get all users with their subscriptions
 */

import { createClient } from '@/lib/supabase/server';
import { getAllUsersWithSubscriptions } from '@/lib/subscription/admin';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await getAllUsersWithSubscriptions(user.id);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ users: result.data });
  } catch (error) {
    console.error('[API admin/users] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
