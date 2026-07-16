import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const REDIRECT_URI = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/ecommerce/shopify/callback`;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const shop = searchParams.get('shop');
  const hmac = searchParams.get('hmac');

  if (!code || !state || !shop) {
    return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
  }

  // Verify HMAC for security
  const crypto = require('crypto');
  
  // Remove hmac from params for verification
  const params = new URLSearchParams(searchParams.toString());
  params.delete('hmac');
  
  // Sort parameters alphabetically and join with &
  const sortedParams = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  
  const hmacCalculated = crypto
    .createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(sortedParams)
    .digest('hex');

  if (hmac !== hmacCalculated) {
    console.error('HMAC verification failed:', { received: hmac, calculated: hmacCalculated });
    return NextResponse.json({ error: 'Invalid HMAC' }, { status: 400 });
  }

  // Decode state to get integration_id
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString());
  } catch {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }

  const { integrationId } = stateData;

  const supabase = await createClient();

  // Exchange authorization code for access token
  let tokenResponse;
  try {
    tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
  } catch (error) {
    console.error('[Shopify OAuth] Token exchange failed:', error);
    return NextResponse.json({ error: 'Failed to connect to Shopify' }, { status: 500 });
  }

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('[Shopify OAuth] Token exchange error:', tokenResponse.status, errorText);
    return NextResponse.json({ error: `Failed to exchange token: ${errorText}` }, { status: 500 });
  }

  const tokenData = await tokenResponse.json();
  console.log('[Shopify OAuth] Token received successfully');

  // Update integration with access token and mark as connected
  const { error } = await supabase
    .from('ecommerce_integrations')
    .update({
      access_token: tokenData.access_token,
      status: 'connected',
      sync_error: null,
    })
    .eq('id', integrationId);

  if (error) {
    console.error('[Shopify OAuth] Database update failed:', error);
    return NextResponse.json({ error: 'Failed to update integration' }, { status: 500 });
  }

  console.log('[Shopify OAuth] Integration updated successfully');

  // Redirect to ecommerce page with success
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return NextResponse.redirect(`${baseUrl}/ecommerce`);
}
