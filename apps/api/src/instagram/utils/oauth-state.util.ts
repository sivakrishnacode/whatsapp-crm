import {
  decodeSignedState,
  encodeSignedState,
  type OAuthStatePayload,
} from '../../common/security/oauth-state.util';

/**
 * Signed OAuth `state` for the Instagram connect flow.
 *
 * The mechanism (and the reasoning for signing rather than storing a
 * nonce row) now lives in common/security/oauth-state.util.ts — the Ads
 * Manager needs the identical thing signed with a different app secret.
 * This file is the Instagram binding: it supplies the secret, so every
 * existing `encodeOAuthState` / `decodeOAuthState` call site is
 * unchanged.
 *
 * The secret is per-provider on purpose rather than one shared signing
 * key: a state minted for the Instagram flow must not verify in the ads
 * callback, or a captured redirect could be replayed across surfaces.
 */

function getSigningKey(): string {
  // Read lazily: this module is imported during Nest's synchronous
  // module graph construction, which completes before ConfigModule
  // loads .env — a module-level read would capture undefined forever.
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) {
    throw new Error(
      'INSTAGRAM_APP_SECRET is not configured — cannot sign the OAuth state.',
    );
  }
  return secret;
}

export function encodeOAuthState(payload: OAuthStatePayload): string {
  return encodeSignedState({ payload, secret: getSigningKey() });
}

export function decodeOAuthState(state: string): OAuthStatePayload | null {
  let secret: string;
  try {
    secret = getSigningKey();
  } catch {
    return null; // secret missing — fail closed, as before
  }
  return decodeSignedState({ state, secret });
}

export type { OAuthStatePayload };
