import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .single();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const type = searchParams.get('type');

    let query = supabase
      .from('campaign_schedules')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }
    if (type) {
      query = query.eq('type', type);
    }

    const { data, error } = await query;

    if (error) throw error;

    return NextResponse.json({ schedules: data ?? [] });
  } catch (error) {
    console.error('[Campaign Schedules GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch schedules' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 }
    );
  }

  const body = await req.json();
  const {
    name,
    type,
    broadcast_id,
    retargeting_config,
    schedule_type,
    scheduled_at,
    recurring_pattern,
    timezone,
  } = body;

  if (!name || !type || !schedule_type || !scheduled_at) {
    return NextResponse.json(
      { error: 'name, type, schedule_type, and scheduled_at are required' },
      { status: 400 }
    );
  }

  if (type === 'broadcast' && !broadcast_id) {
    return NextResponse.json(
      { error: 'broadcast_id is required for broadcast campaigns' },
      { status: 400 }
    );
  }

  if (type === 'retargeting' && !retargeting_config) {
    return NextResponse.json(
      { error: 'retargeting_config is required for retargeting campaigns' },
      { status: 400 }
    );
  }

  if (schedule_type === 'recurring' && !recurring_pattern) {
    return NextResponse.json(
      { error: 'recurring_pattern is required for recurring schedules' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('campaign_schedules')
    .insert({
      account_id: accountId,
      name,
      type,
      broadcast_id,
      retargeting_config,
      schedule_type,
      scheduled_at,
      recurring_pattern,
      timezone: timezone || 'UTC',
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw error;

  return NextResponse.json({ schedule: data }, { status: 201 });
}
