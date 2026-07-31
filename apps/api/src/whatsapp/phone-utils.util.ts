/**
 * Re-export shim. The implementation moved to
 * `src/common/phone/phone.util.ts` when contact phone storage was
 * canonicalized to E.164 — this file and `src/v1/utils/phone.util.ts`
 * had been byte-identical copies, and a copy is what let the
 * dashboard and public-API surfaces store different formats for the
 * same number.
 *
 * Kept as a shim so the WhatsApp module's existing imports resolve
 * unchanged. Import from `common/phone` in new code.
 */
export {
  DEFAULT_COUNTRY,
  toE164,
  sanitizePhoneForMeta,
  normalizePhone,
  phonesMatch,
  isValidE164,
  isCanonicalE164,
  phoneVariants,
  metaVariantToE164,
  isRecipientNotAllowedError,
} from '../common/phone/phone.util';
