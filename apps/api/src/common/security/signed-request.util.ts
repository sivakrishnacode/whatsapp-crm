import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta's `signed_request` format.
 *
 * Used by the data-deletion and deauthorize callbacks: Meta POSTs a single
 * form field containing `<base64url signature>.<base64url payload>` signed
 * with the app secret. It is NOT a JWT — the algorithm lives in the
 * payload rather than a header, and the signature covers the raw encoded
 * payload string.
 *
 * WHY THIS IS THE WHOLE AUTHORISATION
 *   The callback has no session, no bearer token and no way to be
 *   authenticated other than this signature. So a failure to verify must
 *   mean "reject", never "proceed with defaults" — an unverified request
 *   here would let anyone delete any workspace's ad connection by guessing
 *   a user id.
 *
 * Deliberately separate from `oauth-state.util.ts` alongside it: that one
 * is a blob WE mint and verify, this one is a blob META mints. They share
 * only the idea of an HMAC.
 *
 * Lives in `common/security` rather than under one feature because two
 * surfaces receive these callbacks with DIFFERENT secrets — Ads signs with
 * the app secret, Instagram with the Instagram app secret — so the secret
 * is a parameter and neither module owns the parser.
 */

export interface SignedRequestPayload {
  /** Meta's app-scoped user id. */
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
  [key: string]: unknown;
}

/**
 * Verify and decode. Returns null for anything that fails, with no
 * distinction between "malformed" and "bad signature" — the caller has
 * nothing useful to do differently, and telling an attacker which one it
 * was is free information.
 */
export function parseSignedRequest(
  signedRequest: string,
  appSecret: string,
): SignedRequestPayload | null {
  const dot = signedRequest.indexOf('.');
  if (dot <= 0) return null;

  const encodedSignature = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);

  let payload: SignedRequestPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as SignedRequestPayload;
  } catch {
    return null;
  }

  // Meta only ever sends HMAC-SHA256 here. Refusing anything else stops an
  // algorithm-confusion attempt — the same class of bug as accepting
  // `alg: none` on a JWT.
  if (payload.algorithm?.toUpperCase() !== 'HMAC-SHA256') return null;

  const expected = createHmac('sha256', appSecret)
    // The signature covers the ENCODED payload, not the decoded JSON.
    // Re-encoding the parsed object would produce a different string and
    // never match.
    .update(encodedPayload)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }

  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return payload;
}
