import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pageId, isSyncing } = await req.json();

    if (!pageId) {
      return NextResponse.json({ error: 'Page ID is required' }, { status: 400 });
    }

    // 1. Fetch page from database to verify ownership and retrieve Page Access Token
    const { data: page, error: pgErr } = await supabase
      .from('facebook_pages')
      .select('*')
      .eq('user_id', user.id)
      .eq('page_id', pageId)
      .maybeSingle();

    if (pgErr || !page) {
      return NextResponse.json({ error: 'Page not found or access denied' }, { status: 404 });
    }

    // 2. Perform page subscription request to Meta Graph API if it's not a sandbox mock page
    const isMockPage = pageId.startsWith('page_mock');
    if (!isMockPage) {
      const subscribeUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
      const method = isSyncing ? 'POST' : 'DELETE';

      const queryParams = new URLSearchParams({
        subscribed_fields: 'leads',
        access_token: page.page_access_token,
      });

      const subRes = await fetch(`${subscribeUrl}?${queryParams.toString()}`, {
        method,
      });

      const subData = await subRes.json();

      if (!subRes.ok || subData.error) {
        console.error(`Meta webhook ${isSyncing ? 'subscription' : 'unsubscription'} failed:`, subData.error);
        return NextResponse.json(
          { error: subData.error?.message || `Failed to ${isSyncing ? 'subscribe' : 'unsubscribe'} webhook on Meta Page` },
          { status: 400 }
        );
      }
    }

    // 3. Update sync state in local database
    const { error: updateErr } = await supabase
      .from('facebook_pages')
      .update({ is_syncing: isSyncing })
      .eq('id', page.id);

    if (updateErr) throw updateErr;

    return NextResponse.json({ success: true, isSyncing });
  } catch (err: any) {
    console.error('Facebook pages toggle sync API error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
