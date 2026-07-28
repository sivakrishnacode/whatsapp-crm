import { verifyMetaWebhookSignature as verify } from '../../common/security/meta-signature.util';

/**
 * Instagram's binding of the shared Meta signature check.
 *
 * ⚠️ `INSTAGRAM_APP_SECRET`, **not** `META_APP_SECRET`. An Instagram
 * Login app is a distinct app in the Meta dashboard (Instagram → API
 * setup with Instagram login) with its own App ID and Secret, and Meta
 * signs Instagram webhooks with that one. Using the WhatsApp secret
 * here produces a 100% rejection rate whose only symptom is a silent
 * absence of messages — worth the separate wrapper to make the
 * distinction impossible to miss at the call site.
 */
export function verifyInstagramWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  return verify(
    rawBody,
    signatureHeader,
    process.env.INSTAGRAM_APP_SECRET,
    'instagram',
  );
}
