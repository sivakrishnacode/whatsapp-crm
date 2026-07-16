import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { exchangeEmbeddedSignupCode } from '@/lib/whatsapp/meta-api'
import { saveWhatsAppConnection } from '@/lib/whatsapp/connect-account'

/** Mirrors the helper in /api/whatsapp/config/route.ts — see that file for why this is inlined rather than shared. */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/connect
 *
 * Completes the WhatsApp Embedded Signup flow. The frontend's
 * `WhatsAppEmbeddedSignupButton` posts here with the OAuth `code` from
 * FB.login plus the waba_id/phone_number_id/business_id Meta delivered
 * via postMessage during the popup flow (Meta never puts those in the
 * FB.login callback itself).
 *
 * This mirrors POST /api/whatsapp/config (manual entry) from the point
 * a valid access_token exists onward — both call
 * `saveWhatsAppConnection` so conflict detection, /register retry
 * semantics, and the response shape the settings UI renders stay
 * identical regardless of how the token was obtained.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { code, waba_id, phone_number_id, business_id, coexistence } = body

    if (!code || !waba_id || !phone_number_id) {
      return NextResponse.json(
        { error: 'code, waba_id and phone_number_id are required' },
        { status: 400 }
      )
    }

    const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_FACEBOOK_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return NextResponse.json(
        { error: 'Meta App credentials are not configured on the server.' },
        { status: 500 }
      )
    }

    let accessToken: string
    let tokenExpiresAt: string | null = null
    try {
      const exchanged = await exchangeEmbeddedSignupCode({ code, appId, appSecret })
      accessToken = exchanged.accessToken
      if (exchanged.expiresIn) {
        tokenExpiresAt = new Date(Date.now() + exchanged.expiresIn * 1000).toISOString()
      }
    } catch (err) {
      // Covers: user cancelled before a code was ever issued, code
      // already used/expired (a double-submit or a stale retry), or
      // app secret mismatch.
      const message = err instanceof Error ? err.message : 'Unknown error exchanging code'
      console.error('[whatsapp/connect] token exchange failed:', message)
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const isCoexistence = Boolean(coexistence)

    // Cloud API requires a 2-step-verification PIN on /register for any
    // number being registered for the first time. Embedded Signup hands
    // us a brand-new number with no PIN set, so we generate one and let
    // Meta adopt it as the number's PIN — the merchant is never shown
    // it and never needs it (Meta's own onboarding sample does the
    // same). Not used at all for coexistence numbers.
    const generatedPin = String(crypto.randomInt(100000, 1000000))

    const result = await saveWhatsAppConnection({
      supabase,
      supabaseAdmin: supabaseAdmin(),
      accountId,
      userId: user.id,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
      accessToken,
      pin: isCoexistence ? null : generatedPin,
      // Coexistence = the merchant chose to keep using the WhatsApp
      // Business App instead of fully migrating that number to the
      // Cloud API. Meta already owns registration/routing for the
      // number in that mode — calling /register would fight it rather
      // than complement it.
      // https://developers.facebook.com/docs/whatsapp/embedded-signup/embed-the-flow#coexistence
      skipRegistration: isCoexistence,
      businessId: business_id || null,
      connectionMethod: 'embedded_signup',
      tokenExpiresAt,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: result.registered,
      registration_error: result.registration_error,
      registration_skipped: result.registration_skipped,
      phone_info: result.phone_info,
    })
  } catch (error) {
    console.error('Error in WhatsApp connect POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
