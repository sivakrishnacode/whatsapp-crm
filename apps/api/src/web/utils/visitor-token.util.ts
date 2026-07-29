import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * The visitor session token — what turns an anonymous browser into a
 * caller allowed to read and write one specific conversation.
 *
 * WHY A SIGNED TOKEN AND NOT A DATABASE SESSION ROW
 *   The alternative is a random opaque id looked up in a table on every
 *   request. That costs a DB round trip on the hottest path in the
 *   system (every keystroke's typing ping, every SSE reconnect) to
 *   establish something the token can prove by itself.
 *
 * WHY IT IS SIGNED PER ACCOUNT
 *   The key is the account's own `widget_secret`, not a global app
 *   secret. So a token minted for account A cannot verify against
 *   account B even if an attacker replays it at B's widget key — the
 *   signature simply fails. With one global secret, cross-tenant replay
 *   would come down to remembering to compare the `aid` claim on every
 *   endpoint, and forgetting once would be a tenant breach.
 *
 *   It also makes secret rotation a real remedy: rotating an account's
 *   secret invalidates every live session for that account and nobody
 *   else's.
 *
 * WHAT THE TOKEN IS NOT
 *   It is not a user identity. An anonymous visitor's `web_visitor_id`
 *   is self-asserted on first contact — anyone can mint a fresh one by
 *   clearing their browser. That is fine: it identifies a *thread*, not
 *   a person. Claiming to be a specific logged-in user on the
 *   customer's site requires the separate identity-verification HMAC,
 *   which the customer's server has to compute with the same secret.
 */

/** HS256: symmetric, and we hold both ends. No key distribution problem. */
const ALG = 'HS256';

/**
 * 30 days. Long because the token IS the visitor's ability to see their
 * own chat history when they come back — an expiry shorter than a
 * customer's sales cycle means a returning visitor silently loses the
 * thread and re-asks a question they already had answered.
 *
 * Short-lived-token reasoning does not transfer here: this grants access
 * to one conversation the holder created, not to an account.
 */
const TTL_SECONDS = 30 * 24 * 60 * 60;

export interface VisitorTokenClaims {
  /** Account the session belongs to. */
  accountId: string;
  /** `contacts.web_visitor_id` — the durable browser identity. */
  visitorId: string;
  /** The one conversation this token may read and write. */
  conversationId: string;
  /** `contacts.id`. */
  contactId: string;
  /**
   * Set when the customer's own server vouched for this visitor via the
   * identity-verification HMAC. Display and merge logic may trust it;
   * an unverified session may not claim to be anyone.
   */
  verifiedIdentity?: string;
}

export class VisitorTokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'expired' | 'invalid',
  ) {
    super(message);
    this.name = 'VisitorTokenError';
  }
}

function keyFor(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signVisitorToken(
  claims: VisitorTokenClaims,
  secret: string,
): Promise<string> {
  return new SignJWT({
    aid: claims.accountId,
    vid: claims.visitorId,
    cid: claims.conversationId,
    ctc: claims.contactId,
    ...(claims.verifiedIdentity ? { vfy: claims.verifiedIdentity } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(keyFor(secret));
}

/**
 * Verify and decode. Throws `VisitorTokenError` rather than returning
 * null so a caller cannot accidentally treat a failure as an anonymous
 * session and carry on.
 *
 * The `expired` / `invalid` split exists because the two need different
 * client behaviour: an expired token means "start a new session and keep
 * going", an invalid one means "something is wrong, do not retry in a
 * loop".
 */
export async function verifyVisitorToken(
  token: string,
  secret: string,
): Promise<VisitorTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, keyFor(secret), {
      algorithms: [ALG],
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new VisitorTokenError('This chat session has expired.', 'expired');
    }
    // Covers a bad signature, a tampered payload, an `alg: none` attempt,
    // and a token minted under a different account's secret — all of
    // which are the same answer to the caller.
    throw new VisitorTokenError('Invalid chat session.', 'invalid');
  }

  const accountId = payload.aid;
  const visitorId = payload.vid;
  const conversationId = payload.cid;
  const contactId = payload.ctc;
  const verifiedIdentity = payload.vfy;

  if (
    typeof accountId !== 'string' ||
    typeof visitorId !== 'string' ||
    typeof conversationId !== 'string' ||
    typeof contactId !== 'string'
  ) {
    // A correctly signed token with the wrong shape means our own
    // minting code changed incompatibly, not an attack. Still refuse it:
    // downstream code would otherwise read `undefined` as a tenant id.
    throw new VisitorTokenError('Malformed chat session.', 'invalid');
  }

  return {
    accountId,
    visitorId,
    conversationId,
    contactId,
    ...(typeof verifiedIdentity === 'string' ? { verifiedIdentity } : {}),
  };
}

/**
 * A durable browser identity for a visitor who has none yet.
 *
 * Minted server-side rather than accepted from the client. A
 * client-supplied id would let a visitor claim someone else's
 * `web_visitor_id` and, since that column is unique per account, be
 * handed the existing contact and its whole conversation history.
 */
export function generateVisitorId(): string {
  return crypto.randomUUID();
}
