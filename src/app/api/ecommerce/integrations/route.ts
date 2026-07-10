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

    const { data, error } = await supabase
      .from('ecommerce_integrations')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ integrations: data ?? [] });
  } catch (error) {
    console.error('[E-commerce Integrations GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch integrations' },
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
  const { platform, store_url, api_key, api_secret, access_token } = body;

  if (!platform || !store_url) {
    return NextResponse.json(
      { error: 'platform and store_url are required' },
      { status: 400 }
    );
  }

  if (!['shopify', 'woocommerce'].includes(platform)) {
    return NextResponse.json(
      { error: 'Invalid platform. Must be shopify or woocommerce' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('ecommerce_integrations')
    .insert({
      account_id: accountId,
      platform,
      store_url,
      api_key,
      api_secret,
      access_token,
      status: 'disconnected',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ 
        error: `You already have a ${platform} integration. Please delete it first or edit the existing one.` 
      }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ integration: data }, { status: 201 });
}
