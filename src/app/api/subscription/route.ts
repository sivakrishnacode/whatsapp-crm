/**
 * API route for subscription management
 * GET: Get current user's subscription
 */

import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: subscription, error } = await supabase.rpc('get_user_subscription', {
      p_user_id: user.id,
    });

    if (error) {
      console.error('[API subscription] Error:', error);
      return NextResponse.json({ error: 'Failed to fetch subscription' }, { status: 500 });
    }

    return NextResponse.json({ subscription: subscription?.[0] || null });
  } catch (error) {
    console.error('[API subscription] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
