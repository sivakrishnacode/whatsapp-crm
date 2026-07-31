/**
 * Re-export shim — see `src/common/phone/phone.util.ts` for the
 * implementation and for why the duplicate copies were collapsed.
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
} from '../../common/phone/phone.util';
