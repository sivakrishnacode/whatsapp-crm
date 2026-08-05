import { SignJWT, jwtVerify } from 'jose';

import { sessionSecret, sessionTtlHours } from '@/lib/env';

/**
 * Session token plumbing — signing and verifying only, no cookie access.
 *
 * Kept free of `next/headers` so proxy.ts can verify a token straight off
 * `request.cookies`. Cookie reading/writing lives in lib/auth.ts, which is
 * server-component-only.
 */

export const SESSION_COOKIE = 'admin_session';

export type AdminSession = {
  /** The configured admin username this session was issued to. */
  username: string;
  /** Unix seconds. Mirrors the JWT `exp` claim for convenient display. */
  expiresAt: number;
};

export async function signSession(
  username: string
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + sessionTtlHours() * 60 * 60 * 1000);

  const token = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(sessionSecret());

  return { token, expiresAt };
}

/**
 * Returns null for anything that isn't a currently-valid token — expired,
 * tampered with, signed under a rotated secret, or absent. Callers treat null
 * as "not logged in"; there is no distinction worth surfacing.
 */
export async function verifySessionToken(
  token: string | undefined
): Promise<AdminSession | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      algorithms: ['HS256'],
    });

    if (typeof payload.username !== 'string' || !payload.exp) return null;

    return { username: payload.username, expiresAt: payload.exp };
  } catch {
    return null;
  }
}
