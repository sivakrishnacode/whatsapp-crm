import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { adminPassword, adminUsername } from '@/lib/env';
import {
  SESSION_COOKIE,
  type AdminSession,
  signSession,
  verifySessionToken,
} from '@/lib/session';

/**
 * The panel's data access layer for auth.
 *
 * proxy.ts already bounces anonymous requests at the edge, but that check is
 * optimistic — it only proves a signed cookie was present. Every page, every
 * Server Action and every read goes through `requireAdmin()` as well, because
 * Server Actions are reachable by direct POST regardless of what the proxy did.
 */

/**
 * Compares two strings without leaking, through timing, how far the comparison
 * got. Both sides are hashed first so the buffers are always the same length —
 * `timingSafeEqual` throws on a length mismatch, and the length of the real
 * password is itself worth not leaking.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Username is matched case-insensitively (it is an identifier, not a secret);
 * password exactly. Both run every time so a wrong username costs the same as
 * a wrong password.
 */
export function checkCredentials(username: string, password: string): boolean {
  const userMatches = safeEqual(
    username.trim().toLowerCase(),
    adminUsername().trim().toLowerCase()
  );
  const passwordMatches = safeEqual(password, adminPassword());
  return userMatches && passwordMatches;
}

export async function startSession(username: string): Promise<void> {
  const { token, expiresAt } = await signSession(username);
  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Off in dev so the cookie survives plain http://localhost:3002.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Memoised for the render pass so a layout and five components asking "who is
 * this?" verify the JWT once.
 */
export const getSession = cache(async (): Promise<AdminSession | null> => {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value);
});

export async function requireAdmin(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}
