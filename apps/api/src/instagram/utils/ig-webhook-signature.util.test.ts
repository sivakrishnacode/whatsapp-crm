import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyInstagramWebhookSignature } from './ig-webhook-signature.util';

const SECRET = '7d665894a0c927f3708956a804cffe06';
const OTHER_SECRET = 'a'.repeat(32);

function sign(body: string, secret: string): string {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

const BODY = JSON.stringify({
  object: 'instagram',
  entry: [{ id: '17841445515874274', messaging: [] }],
});

describe('verifyInstagramWebhookSignature', () => {
  const original = process.env.INSTAGRAM_APP_SECRET;

  beforeEach(() => {
    process.env.INSTAGRAM_APP_SECRET = SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.INSTAGRAM_APP_SECRET = original;
    vi.restoreAllMocks();
  });

  it('accepts a correctly signed body', () => {
    expect(verifyInstagramWebhookSignature(BODY, sign(BODY, SECRET))).toBe(
      true,
    );
  });

  it('rejects a body that was modified after signing', () => {
    const signature = sign(BODY, SECRET);
    const tampered = BODY.replace('17841445515874274', '99999999999999999');
    expect(verifyInstagramWebhookSignature(tampered, signature)).toBe(false);
  });

  it('rejects a signature made with the wrong app secret', () => {
    // The single most likely misconfiguration: using META_APP_SECRET
    // (the WhatsApp app) instead of INSTAGRAM_APP_SECRET. They are
    // different apps and Instagram signs with its own.
    expect(
      verifyInstagramWebhookSignature(BODY, sign(BODY, OTHER_SECRET)),
    ).toBe(false);
  });

  it('fails closed when the secret is not configured', () => {
    delete process.env.INSTAGRAM_APP_SECRET;
    // Not merely "returns false for a bad signature" — it must reject a
    // *valid-looking* one too, so an unset env var can never leave a
    // spoofable webhook running.
    expect(verifyInstagramWebhookSignature(BODY, sign(BODY, SECRET))).toBe(
      false,
    );
  });

  it('rejects a missing signature header', () => {
    expect(verifyInstagramWebhookSignature(BODY, null)).toBe(false);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const raw = sign(BODY, SECRET).replace('sha256=', '');
    expect(verifyInstagramWebhookSignature(BODY, raw)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    // timingSafeEqual throws on length mismatch — the length guard has
    // to run first or a short header becomes a 500 instead of a 401.
    const truncated = sign(BODY, SECRET).slice(0, 20);
    expect(() =>
      verifyInstagramWebhookSignature(BODY, truncated),
    ).not.toThrow();
    expect(verifyInstagramWebhookSignature(BODY, truncated)).toBe(false);
  });

  it('rejects an empty body signed as empty when the real body differs', () => {
    expect(verifyInstagramWebhookSignature(BODY, sign('', SECRET))).toBe(false);
  });
});
