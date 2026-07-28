import { verifyMetaWebhookSignature as verify } from '../../common/security/meta-signature.util';

/**
 * WhatsApp's binding of the shared Meta signature check.
 *
 * The implementation moved to common/security/meta-signature.util.ts
 * when Instagram landed: Instagram Login apps are a separate Meta app
 * with their own app secret and sign their webhooks with it, so the
 * secret had to become a parameter. This wrapper keeps every WhatsApp
 * call site and its tests unchanged.
 *
 * `META_APP_SECRET` is required — a missing value rejects every request
 * rather than falling open.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  return verify(
    rawBody,
    signatureHeader,
    process.env.META_APP_SECRET,
    'whatsapp',
  );
}
