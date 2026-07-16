import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { campaign_id, contact_id, conversation_id, user_agent, referrer, ip_address } = body;

    if (!campaign_id) {
      return NextResponse.json({ error: 'Campaign ID is required' }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('ctwa_clicks')
      .insert({
        campaign_id,
        contact_id,
        conversation_id,
        user_agent,
        referrer,
        ip_address,
        converted: false,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ click: data }, { status: 201 });
  } catch (error) {
    console.error('[CTWA Track POST]', error);
    return NextResponse.json(
      { error: 'Failed to track click' },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { click_id, conversation_id } = body;

    if (!click_id) {
      return NextResponse.json({ error: 'Click ID is required' }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('ctwa_clicks')
      .update({
        conversation_id,
        converted: true,
        converted_at: new Date().toISOString(),
      })
      .eq('id', click_id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ click: data });
  } catch (error) {
    console.error('[CTWA Track PATCH]', error);
    return NextResponse.json(
      { error: 'Failed to update click' },
      { status: 500 }
    );
  }
}
