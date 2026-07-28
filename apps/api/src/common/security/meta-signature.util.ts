import crypto from 'node:crypto';

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with the app secret and sends the
 * result in `x-hub-signature-256: sha256=<hex>`. Without verification,
 * anyone who knows the webhook URL can POST fabricated messages and
 * status updates.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * WHY THE SECRET IS A PARAMETER
 *   This started life reading `META_APP_SECRET` directly. Instagram
 *   Login apps are a *separate app* in the Meta dashboard with their
 *   own Instagram App Secret, and their webhooks are signed with that
 *   one. Hard-coding the env var would have meant every Instagram
 *   webhook failing verification with no symptom other than a 401 —
 *   so the caller now supplies the secret for its own surface.
 *
 * FAIL CLOSED
 *   A missing secret rejects every request. An earlier version fell
 *   open with a warning, which means anyone who forgets the env var is
 *   running a fully spoofable webhook without knowing it.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
  /** Names the surface in the failure log — 'whatsapp' | 'instagram'. */
  surface = 'meta',
): boolean {
  if (!appSecret) {
    console.error(
      `[${surface}-webhook] app secret is not set — rejecting request. ` +
        'Configure the env var to enable signature verification.',
    );
    return false;
  }

  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
