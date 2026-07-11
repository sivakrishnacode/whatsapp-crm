import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

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
      .from('whatsapp_orders')
      .select('*, contact:contacts(id, name, phone)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ orders: data ?? [] });
  } catch (error) {
    console.error('[WhatsApp Orders GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch orders' },
      { status: 500 }
    );
  }
}
