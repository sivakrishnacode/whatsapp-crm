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
    const { status } = body;

    if (!status || !['pending', 'confirmed', 'cancelled', 'fulfilled'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid order status' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_orders')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*, contact:contacts(id, name, phone)')
      .single();

    if (error) throw error;

    // Send automated status template message if order is confirmed/fulfilled/cancelled
    console.log(`[WhatsApp Order Status] Order status updated to "${status}" for order ID ${id}`);

    return NextResponse.json({ order: data });
  } catch (error) {
    console.error('[WhatsApp Orders PATCH]', error);
    return NextResponse.json(
      { error: 'Failed to update order' },
      { status: 500 }
    );
  }
}
