import {
  decodeSignedState,
  encodeSignedState,
  type OAuthStatePayload,
} from '../../common/security/oauth-state.util';
import { adsAppCredentials } from '../ads.config';

/**
 * Signed OAuth `state` for the Ads Manager connect flow.
 *
 * The Ads binding of common/security/oauth-state.util.ts — see that
 * file for why the state is signed rather than stored, and what the
 * account binding defends against.
 *
 * Signed with the ads app secret specifically, so a state minted for
 * the Instagram connect flow cannot be replayed into this callback and
 * attach an ad account to the wrong workspace.
 */

export function encodeAdsOAuthState(payload: OAuthStatePayload): string {
  return encodeSignedState({
    payload,
    secret: adsAppCredentials().appSecret,
  });
}

export function decodeAdsOAuthState(state: string): OAuthStatePayload | null {
  let secret: string;
  try {
    secret = adsAppCredentials().appSecret;
  } catch {
    return null; // not configured — fail closed
  }
  return decodeSignedState({ state, secret });
}

export type { OAuthStatePayload };
