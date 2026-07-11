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
      .from('whatsapp_products')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ products: data ?? [] });
  } catch (error) {
    console.error('[WhatsApp Products GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

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

    const body = await req.json();
    const { retailer_id, name, description, price, currency, image_url, is_active } = body;

    if (!retailer_id || !name || price === undefined) {
      return NextResponse.json(
        { error: 'retailer_id, name, and price are required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_products')
      .insert({
        account_id: accountId,
        retailer_id,
        name,
        description,
        price: parseFloat(price),
        currency: currency || 'INR',
        image_url,
        is_active: is_active !== false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({
          error: `A product with Retailer ID / SKU "${retailer_id}" already exists.`
        }, { status: 409 });
      }
      throw error;
    }

    // Mock push to Meta Catalog
    console.log('[WhatsApp Products Sync] Synced product to Meta Catalog:', retailer_id);

    return NextResponse.json({ product: data }, { status: 201 });
  } catch (error) {
    console.error('[WhatsApp Products POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create product' },
      { status: 500 }
    );
  }
}
