import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;

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

    const updateData: Record<string, any> = {};
    if (retailer_id !== undefined) updateData.retailer_id = retailer_id;
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = parseFloat(price);
    if (currency !== undefined) updateData.currency = currency;
    if (image_url !== undefined) updateData.image_url = image_url;
    if (is_active !== undefined) updateData.is_active = is_active;
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('whatsapp_products')
      .update(updateData)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error) throw error;

    // Mock push updates to Meta Catalog
    console.log('[WhatsApp Products Sync] Synced product updates to Meta Catalog:', data.retailer_id);

    return NextResponse.json({ product: data });
  } catch (error) {
    console.error('[WhatsApp Products PATCH]', error);
    return NextResponse.json(
      { error: 'Failed to update product' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;

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

    const { data: product, error: fetchError } = await supabase
      .from('whatsapp_products')
      .select('retailer_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .single();

    if (fetchError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('whatsapp_products')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) throw error;

    // Mock delete from Meta Catalog
    console.log('[WhatsApp Products Sync] Removed product from Meta Catalog:', product.retailer_id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[WhatsApp Products DELETE]', error);
    return NextResponse.json(
      { error: 'Failed to delete product' },
      { status: 500 }
    );
  }
}
