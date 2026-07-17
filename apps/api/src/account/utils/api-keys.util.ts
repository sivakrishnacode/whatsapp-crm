/**
 * API key generation, hashing, and scope helpers.
 * Ported from apps/web/src/lib/api-keys/{keys,scopes}.ts.
 * Pure: no I/O.
 */
import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'conceps_live_';
const DISPLAY_BODY_CHARS = 8;

export interface GeneratedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${body}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: `${API_KEY_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const API_SCOPES = [
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'broadcasts:send',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === 'string' &&
    (API_SCOPES as readonly string[]).includes(value)
  );
}

export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: ApiScope[] = [];
  for (const entry of input) {
    if (!isApiScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
