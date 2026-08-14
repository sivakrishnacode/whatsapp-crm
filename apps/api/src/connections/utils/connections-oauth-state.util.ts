import {
  decodeSignedState,
  encodeSignedState,
  type OAuthStatePayload,
} from '../../common/security/oauth-state.util';

/**
 * Signed OAuth `state` for the app-connections flow.
 *
 * The mechanism, and why it is an HMAC rather than a nonce row, lives in
 * common/security/oauth-state.util.ts. This is the third binding of it
 * (Instagram and Ads Manager are the others).
 *
 * ⚠️ ITS OWN SECRET, NOT A SHARED ONE
 *   Instagram signs with INSTAGRAM_APP_SECRET and Ads with the Meta app
 *   secret. If this flow reused either, a state captured from one
 *   consent screen would verify in the other's callback, and the
 *   accountId inside it would be honoured — attaching a Google account
 *   to a workspace through a redirect the attacker controls. A separate
 *   CONNECTIONS_STATE_SECRET makes that structurally impossible rather
 *   than merely unlikely.
 *
 * The payload carries the extra `scopes` and `app` the connect flow
 * needs, encoded into `returnTo`'s sibling fields via the generic
 * payload's pass-through — see ConnectionsOAuthPayload.
 */

function getSigningKey(): string {
  // Read lazily: this module is imported while Nest builds its module
  // graph, which completes before ConfigModule loads .env — a
  // module-level read would capture undefined forever.
  const secret = process.env.CONNECTIONS_STATE_SECRET;
  if (!secret) {
    throw new Error(
      'CONNECTIONS_STATE_SECRET is not configured — cannot sign the OAuth state.',
    );
  }
  return secret;
}

export interface ConnectionsOAuthPayload extends OAuthStatePayload {
  /** Which provider's callback this is, so one endpoint serves all. */
  provider: string;
  /**
   * PKCE verifier.
   *
   * Carried INSIDE the signed state rather than in a server-side session
   * because the callback is a cross-site GET with no session cookie we
   * can rely on — the same constraint that made the state an HMAC in the
   * first place. The state is signed and 10-minute-lived, so a verifier
   * inside it cannot be forged or replayed past expiry. It is not
   * secret from the user's own browser, which is fine: PKCE defends
   * against an intercepted authorization CODE, not against the user.
   */
  codeVerifier: string;
}

export function encodeConnectionsState(
  payload: ConnectionsOAuthPayload,
): string {
  return encodeSignedState({ payload, secret: getSigningKey() });
}

export function decodeConnectionsState(
  state: string,
): ConnectionsOAuthPayload | null {
  let secret: string;
  try {
    secret = getSigningKey();
  } catch {
    return null; // secret missing — fail closed
  }
  // Explicit type argument, not a cast on the result: `decodeSignedState`
  // preserves provider-specific fields but cannot know their shape, and a
  // trailing `as` here was removed by eslint's --fix as "redundant",
  // which silently narrowed the payload back to the three common fields.
  const decoded = decodeSignedState<ConnectionsOAuthPayload>({
    state,
    secret,
  });
  // decodeSignedState validates accountId/userId/exp/signature. The two
  // fields it does not know about are checked here, for the same reason:
  // an HMAC proves we minted the blob, not that the blob is complete.
  if (!decoded?.provider || !decoded?.codeVerifier) return null;
  return decoded;
}
