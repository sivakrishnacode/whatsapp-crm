'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkCredentials, endSession, startSession } from '@/lib/auth';

export type LoginState = { error?: string };

/**
 * Attempt throttling.
 *
 * The whole login is one username and one password from an env file, so it is
 * exactly the shape of thing that gets credential-stuffed if it is ever
 * reachable from the internet. This is an in-memory sliding window: it resets
 * on restart and is per-process, which is honest about what it is — a speed
 * bump, not a distributed rate limiter. For a single-container internal panel
 * that is the right amount of machinery; behind more than one replica, put the
 * real limit in the reverse proxy.
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function clientKey(forwardedFor: string | null, realIp: string | null): string {
  const ip = forwardedFor?.split(',')[0]?.trim() || realIp?.trim();
  return ip || 'unknown';
}

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

function recordAttempt(key: string): void {
  const recent = attempts.get(key) ?? [];
  recent.push(Date.now());
  attempts.set(key, recent);

  // Keep the map from growing without bound on a long-lived process.
  if (attempts.size > 1000) {
    const now = Date.now();
    for (const [entryKey, times] of attempts) {
      if (times.every((at) => now - at >= WINDOW_MS)) attempts.delete(entryKey);
    }
  }
}

/**
 * Only same-origin paths are honoured. Without this check the `next` parameter
 * is an open redirect: a link to /login?next=https://evil.example would send an
 * admin straight there, having just proved they hold the credentials.
 */
function safeRedirect(target: string | null): string {
  if (!target) return '/';
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

export async function login(
  _previous: LoginState,
  formData: FormData
): Promise<LoginState> {
  const headerList = await headers();
  const key = clientKey(
    headerList.get('x-forwarded-for'),
    headerList.get('x-real-ip')
  );

  if (tooManyAttempts(key)) {
    return { error: 'Too many attempts. Wait a few minutes and try again.' };
  }

  const username = formData.get('username');
  const password = formData.get('password');
  const next = formData.get('next');

  if (typeof username !== 'string' || typeof password !== 'string') {
    return { error: 'Enter a username and password.' };
  }
  if (!username.trim() || !password) {
    return { error: 'Enter a username and password.' };
  }

  if (!checkCredentials(username, password)) {
    recordAttempt(key);
    // One message for both wrong-username and wrong-password: naming which was
    // wrong tells an attacker which half to keep.
    return { error: 'Those credentials are not valid.' };
  }

  attempts.delete(key);
  await startSession(username.trim());

  redirect(safeRedirect(typeof next === 'string' ? next : null));
}

export async function logout(): Promise<void> {
  await endSession();
  redirect('/login');
}
