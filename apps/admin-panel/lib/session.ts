import { SignJWT, jwtVerify } from 'jose';

import { sessionSecret, sessionTtlHours } from '@/lib/env';
import { isStaffRole, type StaffRole } from '@/lib/staff/roles';

/**
 * Session token plumbing — signing and verifying only, no cookie access and
 * no database.
 *
 * Kept free of `next/headers` and Prisma so proxy.ts can verify a token
 * straight off `request.cookies` at the edge of every request. That check is
 * only "a validly signed cookie was presented": whether the staff member is
 * still active, still holds that role and has not had their sessions revoked
 * is decided by `getStaff()` in lib/auth.ts, which reads the row.
 */

export const SESSION_COOKIE = 'admin_session';

/** The subject of a break-glass session — the env credential, not a row. */
export const BREAK_GLASS_SUBJECT = 'env';

export type AdminSession = {
  /** `admin_staff.id`, or BREAK_GLASS_SUBJECT for the env credential. */
  subject: string;
  /** Role at the time the token was minted. Re-read from the row on use. */
  role: StaffRole;
  /** `admin_staff.session_version` the token was minted under. */
  version: number;
  /** Unix seconds. Mirrors the JWT `exp` claim for convenient display. */
  expiresAt: number;
};

export async function signSession(input: {
  subject: string;
  role: StaffRole;
  version: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + sessionTtlHours() * 60 * 60 * 1000);

  const token = await new SignJWT({ role: input.role, ver: input.version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(sessionSecret());

  return { token, expiresAt };
}

/**
 * Returns null for anything that isn't a currently-valid token — expired,
 * tampered with, signed under a rotated secret, minted by the pre-C2.0 panel
 * (no `role` claim), or absent. Callers treat null as "not logged in".
 */
export async function verifySessionToken(
  token: string | undefined
): Promise<AdminSession | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      algorithms: ['HS256'],
    });

    if (
      typeof payload.sub !== 'string' ||
      !isStaffRole(payload.role) ||
      typeof payload.ver !== 'number' ||
      !payload.exp
    ) {
      return null;
    }

    return {
      subject: payload.sub,
      role: payload.role,
      version: payload.ver,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}
