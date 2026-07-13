import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { accessToken, isDemo } = await req.json();

    if (!accessToken) {
      return NextResponse.json({ error: 'Access token is required' }, { status: 400 });
    }

    if (isDemo || accessToken === 'mock_demo_user_token') {
      // Create mock connection in database
      const { data: connection, error: connErr } = await supabase
        .from('facebook_connections')
        .upsert({
          user_id: user.id,
          fb_user_id: 'demo_12345678',
          fb_user_name: 'Jane Demo (Sandbox)',
          access_token: 'mock_long_lived_demo_token',
        })
        .select()
        .single();

      if (connErr) throw connErr;

      // Create mock pages in database
      const mockPages = [
        {
          connection_id: connection.id,
          user_id: user.id,
          page_id: 'page_mock_1',
          page_name: 'Acme Corp Leads Sandbox',
          page_access_token: 'mock_page_token_1',
          is_syncing: false,
        },
        {
          connection_id: connection.id,
          user_id: user.id,
          page_id: 'page_mock_2',
          page_name: 'Instagram Growth Sandbox',
          page_access_token: 'mock_page_token_2',
          is_syncing: false,
        },
      ];

      for (const page of mockPages) {
        const { error: pgErr } = await supabase
          .from('facebook_pages')
          .upsert(page, { onConflict: 'user_id,page_id' });

        if (pgErr) throw pgErr;
      }

      return NextResponse.json({ success: true, isDemo: true });
    }

    // Real Meta OAuth flow
    const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_FACEBOOK_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return NextResponse.json(
        { error: 'Meta Developer App credentials are not configured on the server.' },
        { status: 500 }
      );
    }

    // 1. Exchange client token for long-lived user access token (valid for 60 days)
    const tokenUrl = `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${accessToken}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      console.error('Error exchanging token:', tokenData.error);
      return NextResponse.json(
        { error: tokenData.error?.message || 'Failed to exchange long-lived access token' },
        { status: 400 }
      );
    }

    const longLivedUserToken = tokenData.access_token;

    // 2. Fetch user profile to get Facebook User ID and User Name
    const meRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${longLivedUserToken}`);
    const meData = await meRes.json();

    if (!meRes.ok || meData.error) {
      console.error('Error fetching user profile:', meData.error);
      return NextResponse.json(
        { error: meData.error?.message || 'Failed to fetch user profile' },
        { status: 400 }
      );
    }

    // 3. Store connection
    const { data: connection, error: connErr } = await supabase
      .from('facebook_connections')
      .upsert({
        user_id: user.id,
        fb_user_id: meData.id,
        fb_user_name: meData.name,
        access_token: longLivedUserToken,
      })
      .select()
      .single();

    if (connErr) throw connErr;

    // 4. Fetch user's managed Facebook Pages and Page Access Tokens
    const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=${longLivedUserToken}&limit=100`);
    const pagesData = await pagesRes.json();

    if (!pagesRes.ok || pagesData.error) {
      console.error('Error fetching pages:', pagesData.error);
      return NextResponse.json(
        { error: pagesData.error?.message || 'Failed to fetch Facebook pages' },
        { status: 400 }
      );
    }

    // 5. Store retrieved pages
    const retrievedPages = pagesData.data || [];
    for (const page of retrievedPages) {
      const { error: pgErr } = await supabase
        .from('facebook_pages')
        .upsert({
          connection_id: connection.id,
          user_id: user.id,
          page_id: page.id,
          page_name: page.name,
          page_access_token: page.access_token,
        }, { onConflict: 'user_id,page_id' });

      if (pgErr) throw pgErr;
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Facebook connect API error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
