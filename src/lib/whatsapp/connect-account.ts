import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = any

export interface SaveWhatsAppConnectionArgs {
  /** User-scoped client — RLS requires the caller to be an account admin for insert/update. */
  supabase: AnySupabaseClient
  /** Service-role client — used ONLY to detect a phone_number_id already claimed by a different account (RLS would otherwise hide those rows). */
  supabaseAdmin: ReturnType<typeof createAdminClient>
  accountId: string
  userId: string
  phoneNumberId: string
  wabaId: string | null
  /** Plaintext access token — encrypted here before it touches the DB. */
  accessToken: string
  verifyToken?: string | null
  /**
   * 6-digit 2-step-verification PIN for POST /register. Omitted/null
   * skips registration the same way the manual form does when the
   * user leaves the PIN field blank (e.g. Meta test numbers).
   */
  pin?: string | null
  /**
   * True for Embedded Signup "coexistence" connections — the merchant
   * kept their number on the WhatsApp Business App. /register must
   * NEVER be called for these regardless of `pin`: the number is
   * already registered and routed by the WhatsApp Business App, and
   * calling /register would fight that registration instead of
   * complementing it.
   */
  skipRegistration?: boolean
  businessId?: string | null
  connectionMethod?: 'manual' | 'embedded_signup'
  tokenExpiresAt?: string | null
}

export type SaveWhatsAppConnectionResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true
      registered: boolean
      registration_error: string | null
      registration_skipped: boolean
      phone_info: MetaPhoneInfo
    }

/**
 * Verify, register, subscribe, and persist a WhatsApp connection into
 * `whatsapp_config`. Shared by the manual-entry route
 * (POST /api/whatsapp/config) and the Embedded Signup route
 * (POST /api/whatsapp/connect) so both paths agree on conflict
 * detection, registration retry semantics, and the response shape the
 * settings UI already knows how to render.
 */
export async function saveWhatsAppConnection(
  args: SaveWhatsAppConnectionArgs
): Promise<SaveWhatsAppConnectionResult> {
  const {
    supabase,
    supabaseAdmin,
    accountId,
    userId,
    phoneNumberId,
    wabaId,
    accessToken,
    verifyToken,
    pin,
    skipRegistration,
    businessId,
    connectionMethod = 'manual',
    tokenExpiresAt,
  } = args

  // Reject if another account has already claimed this phone_number_id.
  // See migration 013 / issue #136 — the webhook routes inbound
  // messages by phone_number_id and silently drops them if two
  // accounts share one.
  const { data: claimed, error: claimedError } = await supabaseAdmin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('Error checking phone_number_id ownership:', claimedError)
    return { ok: false, status: 500, error: 'Failed to validate configuration' }
  }

  if (claimed) {
    return {
      ok: false,
      status: 409,
      error:
        'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one Conceps WA user.',
    }
  }

  // Verify credentials with Meta BEFORE saving.
  let phoneInfo: MetaPhoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('Meta API verification failed during save:', message)
    return { ok: false, status: 400, error: `Meta API error: ${message}` }
  }

  // Encrypt sensitive tokens before storing.
  let encryptedAccessToken: string
  let encryptedVerifyToken: string | null
  try {
    encryptedAccessToken = encrypt(accessToken)
    encryptedVerifyToken = verifyToken ? encrypt(verifyToken) : null
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown encryption error'
    console.error('Encryption failed:', message)
    return {
      ok: false,
      status: 500,
      error:
        'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
    }
  }

  // Look up any pre-existing row for this account so we know whether
  // this number is already registered with Meta — if so we can skip
  // /register when the caller didn't provide a fresh PIN this time.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id, registered_at, phone_number_id')
    .eq('account_id', accountId)
    .maybeSingle()

  const sameNumber =
    existing?.phone_number_id === phoneNumberId && existing?.registered_at != null

  // Step 1: register the phone number for inbound webhooks.
  let registeredAt: string | null = existing?.registered_at ?? null
  let registrationError: string | null = null
  // True when registration was deliberately skipped (no PIN, or
  // coexistence) — not a failure, just an incomplete-but-valid save.
  let registrationSkipped = false

  if (skipRegistration) {
    // Coexistence — Meta forbids re-registering a number the WhatsApp
    // Business App already owns. Leave registered_at as whatever it
    // was (should be null on first connect).
    registrationSkipped = true
  } else {
    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers are pre-registered and
        // expose no 2FA PIN, so requiring one made them impossible to
        // connect (issue #242). Treat as best-effort: skip /register,
        // save the (already Meta-verified) credentials as connected,
        // and leave registered_at null.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({ phoneNumberId, accessToken, pin })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
        }
      }
    }
  }

  // Step 2: subscribe the WABA to this app. Idempotent on Meta's side.
  let subscribedAppsAt: string | null = null
  if (wabaId) {
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('WABA subscribed_apps failed (non-fatal):', message)
    }
  }

  const baseRow: Record<string, unknown> = {
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    access_token: encryptedAccessToken,
    verify_token: encryptedVerifyToken,
    status: registrationError ? 'disconnected' : 'connected',
    connected_at: registrationError ? null : new Date().toISOString(),
    registered_at: registrationError ? null : registeredAt,
    subscribed_apps_at: subscribedAppsAt ?? null,
    last_registration_error: registrationError,
    connection_method: connectionMethod,
    business_id: businessId || null,
    coexistence: Boolean(skipRegistration),
    token_expires_at: tokenExpiresAt ?? null,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)

    if (updateError) {
      console.error('Error updating whatsapp_config:', updateError)
      return { ok: false, status: 500, error: 'Failed to update configuration' }
    }
  } else {
    const { error: insertError } = await supabase.from('whatsapp_config').insert({
      account_id: accountId,
      user_id: userId,
      ...baseRow,
    })

    if (insertError) {
      console.error('Error inserting whatsapp_config:', insertError)
      return { ok: false, status: 500, error: 'Failed to save configuration' }
    }
  }

  return {
    ok: true,
    registered: registeredAt != null,
    registration_error: registrationError,
    registration_skipped: registrationSkipped,
    phone_info: phoneInfo,
  }
}
