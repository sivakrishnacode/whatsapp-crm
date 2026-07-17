/**
 * Invitation token utilities — ported from apps/web/src/lib/auth/invitations.ts
 * Pure helpers: no I/O, no Supabase, unit-testable.
 */
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const MAX_INVITE_EXPIRY_DAYS = 30;

/** Generate a cryptographically random token + its SHA-256 hash. */
export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

/** SHA-256 hex digest of a plaintext invite token. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Build the public invite URL. `baseUrl` must NOT have a trailing slash. */
export function inviteUrl(token: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/join/${token}`;
}

/** Clamp caller-supplied expiresInDays to [1, MAX_INVITE_EXPIRY_DAYS]. */
export function clampExpiryDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days) || days <= 0) {
    return DEFAULT_INVITE_EXPIRY_DAYS;
  }
  return Math.min(Math.floor(days), MAX_INVITE_EXPIRY_DAYS);
}

/** Compute expires_at Date from a clamped day count. */
export function inviteExpiresAt(
  expiresInDays: number | undefined,
  now: Date = new Date(),
): Date {
  const days = clampExpiryDays(expiresInDays);
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
