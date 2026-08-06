import crypto from 'node:crypto';

/**
 * Signed, self-contained OAuth `state` for any provider redirect flow.
 *
 * Extracted from instagram/utils/oauth-state.util.ts (which re-exports
 * a pre-bound wrapper, so existing imports are unaffected) when the Ads
 * Manager landed and needed the identical mechanism signed with a
 * different app secret. Same move as common/messaging/meta-errors.ts.
 *
 * WHY SIGNED RATHER THAN A DB ROW
 *   The state has to survive a round trip through a provider's consent
 *   screen and come back on a GET that carries no session cookie we can
 *   rely on (it is a top-level cross-site navigation). Storing a nonce
 *   row would work but adds a table, a TTL sweep and a read on a hot
 *   path. An HMAC over {accountId, userId, nonce, expiry} gives the
 *   same two guarantees — the callback is for a real request we
 *   started, and it is bound to the account that started it — with no
 *   storage.
 *
 * WHAT IT DEFENDS AGAINST
 *   Without account binding, an attacker could start a connect flow,
 *   capture the redirect, and feed the callback URL to a victim who is
 *   logged into a different tenant — attaching the attacker's provider
 *   account to the victim's CRM, or the reverse. Carrying the accountId
 *   inside the signed blob means the callback can only ever write to
 *   the account that initiated it.
 *
 *   For the Ads Manager the stakes are higher than for a channel
 *   connect: the account being attached can spend money.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes: a consent dialog, not a session

export interface OAuthStatePayload {
  accountId: string;
  userId: string;
  /** Where to send the browser once the callback completes. */
  returnTo?: string;
}

interface SignedState extends OAuthStatePayload {
  nonce: string;
  exp: number;
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

export function encodeSignedState(args: {
  payload: OAuthStatePayload;
  secret: string;
}): string {
  const signed: SignedState = {
    ...args.payload,
    nonce: crypto.randomBytes(16).toString('base64url'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(signed)).toString('base64url');
  return `${body}.${sign(body, args.secret)}`;
}

/**
 * Returns the payload, or null for anything that fails to verify:
 * malformed, tampered, or expired. Callers must treat null as "abort
 * the connect flow" — never as "proceed with defaults".
 */
export function decodeSignedState(args: {
  state: string;
  secret: string;
}): OAuthStatePayload | null {
  const { state, secret } = args;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = state.slice(0, dot);
  const signature = state.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body, secret);
  } catch {
    return null; // secret missing/unusable — fail closed
  }

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let parsed: Partial<SignedState>;
  try {
    // Cast, not trust: this is attacker-reachable input that merely
    // passed an HMAC check. The field checks below are what actually
    // validate it — `Partial` keeps the compiler honest about that.
    parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<SignedState>;
  } catch {
    return null;
  }

  if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
  if (!parsed.accountId || !parsed.userId) return null;

  return {
    accountId: parsed.accountId,
    userId: parsed.userId,
    returnTo: parsed.returnTo,
  };
}
