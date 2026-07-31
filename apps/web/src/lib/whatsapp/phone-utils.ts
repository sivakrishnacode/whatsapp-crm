import { parsePhoneNumberFromString } from 'libphonenumber-js'

/**
 * Phone numbers — the web app's authority. Mirrors
 * `apps/api/src/common/phone/phone.util.ts`; the two must agree,
 * because the contacts UI writes to Supabase directly (RLS) rather
 * than through the API, so both sides are real write paths.
 *
 * ## The two formats, and which one goes where
 *
 * - **Canonical (`toE164`)** — `+<country><subscriber>`, e.g.
 *   `+919791766444`. The ONLY shape allowed in `contacts.phone`;
 *   migration 061 enforces it with a CHECK constraint, so an
 *   un-normalized insert from here fails loudly rather than
 *   re-introducing a mixed format.
 * - **Meta wire format (`sanitizePhoneForMeta`)** — digits only, no
 *   `+`. Applied at send time and nowhere else.
 *
 * `normalizePhone` (digits-only) still mirrors the
 * `contacts.phone_normalized` generated column and remains the
 * de-duplication key — canonicalizing `phone` does not change it.
 */

/**
 * App-wide fallback country (ISO 3166-1 alpha-2) for numbers typed
 * without a country code. Per-account overrides live in
 * `accounts.default_country` (migration 059) and reach components as
 * `useAuth().defaultCountry`.
 */
export const DEFAULT_COUNTRY = 'IN'

/**
 * Convert any user-typed or imported phone string to canonical
 * E.164, or null when it cannot plausibly be a phone number.
 *
 * `defaultCountry` (ISO alpha-2) resolves the ambiguous case: a bare
 * national number like `9791766444` carries no country code, so one
 * has to be assumed. Pass `useAuth().defaultCountry`.
 *
 * The four-step precedence — explicit `+`, then valid-national,
 * then valid-international, then the same two relaxed to
 * possible-only — is documented in full on the API twin. The short
 * version: a digit string with no `+` is genuinely ambiguous, so we
 * ask libphonenumber which reading yields a real number and take the
 * strictest one that does.
 */
export function toE164(
  raw: string | null | undefined,
  defaultCountry: string | null | undefined = DEFAULT_COUNTRY,
): string | null {
  if (!raw) return null

  const trimmed = String(raw).trim()
  if (!trimmed) return null

  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed)
    return parsed?.isPossible() ? parsed.number : null
  }

  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  // An ISO alpha-2 is what libphonenumber expects; anything else
  // would throw, so it is dropped and we fall through to the
  // international readings.
  const country = /^[A-Za-z]{2}$/.test(defaultCountry ?? '')
    ? (defaultCountry as string).toUpperCase()
    : undefined

  const national = country
    ? parsePhoneNumberFromString(digits, country as never)
    : undefined
  const international = parsePhoneNumberFromString(`+${digits}`)

  if (national?.isValid()) return national.number
  if (international?.isValid()) return international.number
  if (international?.isPossible()) return international.number
  if (national?.isPossible()) return national.number

  return null
}

/**
 * True when a string is already in the exact canonical storage form.
 * This is the invariant migration 061's CHECK constraint enforces.
 */
export function isCanonicalE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone)
}

/**
 * Render a stored number for display, e.g. `+919791766444` →
 * `+91 97917 66444`. Falls back to the input unchanged when it
 * cannot be parsed, so a legacy or hand-edited value still shows
 * rather than vanishing.
 *
 * Display only — never write this back to the DB.
 */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  if (!phone) return ''
  const parsed = parsePhoneNumberFromString(phone.trim())
  return parsed?.isPossible() ? parsed.formatInternational() : phone
}

/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
