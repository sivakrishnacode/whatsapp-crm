import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone numbers — the single authority for the API.
 *
 * `src/whatsapp/phone-utils.util.ts` and `src/v1/utils/phone.util.ts`
 * were byte-identical copies of each other; both are now re-export
 * shims over this module so the two API surfaces can never drift.
 *
 * ## The two formats, and which one goes where
 *
 * - **Canonical (`toE164`)** — `+<country><subscriber>`, e.g.
 *   `+919791766444`. This is the ONLY shape allowed in
 *   `contacts.phone`; migration 061 enforces it with a CHECK
 *   constraint. Every write path must run its input through
 *   `toE164` first.
 * - **Meta wire format (`sanitizePhoneForMeta`)** — digits only, no
 *   `+`, e.g. `919791766444`. Meta's Cloud API rejects the `+`, so
 *   this is applied at the moment of the send and nowhere else.
 *
 * Before this split the two were conflated: the public v1 API
 * validated a number as E.164 and then stored the Meta-sanitized
 * form, and the WhatsApp webhook stored Meta's inbound `from` value
 * verbatim. Both dropped the `+`, so the same person appeared as
 * `+919791766444`, `919791766444`, or `9791766444` depending on
 * which channel first saw them.
 *
 * `phone_normalized` (the digits-only generated column that backs
 * per-account de-duplication, migration 022) is unaffected by any of
 * this — it strips non-digits either way.
 */

/**
 * App-wide fallback country (ISO 3166-1 alpha-2) for numbers typed
 * without a country code. Per-account overrides live in
 * `accounts.default_country` (migration 059); this constant is the
 * value that column defaults to and the narrowing used when no
 * account context is available.
 */
export const DEFAULT_COUNTRY = 'IN';

/**
 * Convert any user-, webhook-, or import-supplied phone string to
 * canonical E.164, or null when it cannot plausibly be a phone
 * number.
 *
 * `defaultCountry` (ISO alpha-2) resolves the genuinely ambiguous
 * case: a bare national number like `9791766444` carries no country
 * code, so *some* country has to be assumed. Pass the account's
 * `default_country` — see `resolveAccountCountry`.
 *
 * ## Why the four-step precedence
 *
 * A string of digits with no `+` is ambiguous: `918300070574` could
 * be India's country code plus a subscriber number, or a national
 * number in some country that happens to start with 91. Neither
 * reading is knowable from the digits alone, so we ask
 * libphonenumber which one produces a real number, strict readings
 * first:
 *
 *   1. `+` present — the caller has already committed to a country
 *      code. Trust it; only length is checked.
 *   2. Valid as a national number in `defaultCountry`. libphonenumber
 *      handles a leading country code or trunk `0` here, so this one
 *      step covers `9791766444`, `07810032625` and `918300070574`
 *      for an IN account.
 *   3. Valid as an international number once a `+` is prepended —
 *      this is the foreign number written without one, e.g. a UK
 *      `447911123456` landing in an IN account.
 *   4/5. The same two readings again, relaxed to "possible" (length
 *      only). Meta accepts numbers whose prefixes libphonenumber's
 *      metadata does not yet know about, and rejecting a number the
 *      carrier will happily deliver to is the worse failure.
 *
 * Steps 2 and 3 are deliberately `isValid` before either falls back
 * to `isPossible`: checking possible-national before valid-
 * international would swallow `447911123456` into
 * `+91447911123456`, since India's *possible* lengths are loose
 * enough to admit it.
 */
export function toE164(
  raw: string | null | undefined,
  defaultCountry: string | null | undefined = DEFAULT_COUNTRY,
): string | null {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    return parsed?.isPossible() ? parsed.number : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // An ISO alpha-2 is what libphonenumber expects; anything else
  // (a calling code, a stale value) would throw, so it is dropped
  // and we fall through to the international readings.
  const country = /^[A-Za-z]{2}$/.test(defaultCountry ?? '')
    ? (defaultCountry as string).toUpperCase()
    : undefined;

  const national = country
    ? parsePhoneNumberFromString(digits, country as never)
    : undefined;
  const international = parsePhoneNumberFromString(`+${digits}`);

  if (national?.isValid()) return national.number;
  if (international?.isValid()) return international.number;
  if (international?.isPossible()) return international.number;
  if (national?.isPossible()) return national.number;

  return null;
}

/**
 * Sanitize a phone number for the Meta WhatsApp Cloud API, which
 * requires digits only — no `+`, spaces, or dashes.
 * e.g. "+370 63949836" → "37063949836".
 *
 * Send-time only. Never store this form — see the module comment.
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

/**
 * Normalize a phone number by removing all non-digit characters.
 * Mirrors the `contacts.phone_normalized` generated column, so this
 * is the key to compare numbers across formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without)
 * by comparing the last 8 digits.
 *
 * Accepts null because `contacts.phone` is nullable — Instagram-only
 * contacts have an IGSID and no phone. A missing phone matches
 * nothing, which is what callers scanning for a phone-keyed contact
 * want; making that explicit here beats a null guard at each call
 * site.
 */
export function phonesMatch(
  phone1: string | null | undefined,
  phone2: string | null | undefined,
): boolean {
  if (!phone1 || !phone2) return false;
  const n1 = normalizePhone(phone1);
  const n2 = normalizePhone(phone2);
  if (n1 === n2) return true;
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8);
  }
  return false;
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting
 * with non-zero). Accepts with or without `+` prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone);
}

/**
 * True when a string is already in the exact canonical storage form:
 * a leading `+` followed by 7-15 digits. This is the invariant
 * migration 061's CHECK constraint enforces on `contacts.phone`.
 */
export function isCanonicalE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed
 * list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836"
 * international). But some sandboxes register the number with the
 * trunk 0 included, causing sends to the correct international
 * format to fail.
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
  if (!sanitized) return [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v);
  };

  // 1. Original
  push(sanitized);

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue;
    const cc = sanitized.slice(0, ccLen);
    const rest = sanitized.slice(ccLen);
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest);
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue;
    const cc = sanitized.slice(0, ccLen);
    const rest = sanitized.slice(ccLen);
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1));
    }
  }

  return [...seen];
}

/**
 * Convert a Meta-accepted variant (digits only, from
 * {@link phoneVariants}) back to canonical storage form, or null if
 * the result would not be storable.
 *
 * The send paths retry a rejected number against trunk-prefix
 * variants and, when one succeeds, write it back to the contact so
 * the next send goes straight through. That write-back used to store
 * the digits-only variant — a correction that fixed deliverability
 * and broke the format at the same time.
 *
 * Prepending `+` rather than re-running `toE164` is deliberate: the
 * variant is by construction a full international number that Meta
 * has just delivered to, so there is no country to infer, and a
 * re-parse could "helpfully" strip the very trunk digit that made the
 * send work.
 */
export function metaVariantToE164(variant: string): string | null {
  const digits = normalizePhone(variant);
  if (!digits) return null;
  const candidate = `+${digits}`;
  return isCanonicalE164(candidate) ? candidate : null;
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message);
}
