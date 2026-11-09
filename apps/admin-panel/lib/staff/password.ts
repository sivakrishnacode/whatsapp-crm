import 'server-only';

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Staff password hashing — Node's built-in scrypt, so no native dependency.
 *
 * Stored as `scrypt$N$r$p$<salt b64>$<hash b64>` so the cost can be raised
 * later without a migration: verification reads the parameters off the
 * stored value, and a hash made under older parameters still verifies.
 */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
// scrypt needs ~128·N·r bytes; Node's default 32 MiB ceiling is exactly
// N=2^15·r=8, so leave headroom rather than fail at the boundary.
const MAX_MEM = 64 * 1024 * 1024;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  length: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      { N: n, r, p, maxmem: MAX_MEM },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = await derive(
    password,
    Buffer.from(saltB64!, 'base64'),
    Number(n),
    Number(r),
    Number(p),
    expected.length
  );

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A hash nobody's password matches, verified when the email is unknown so a
 * wrong email costs the same scrypt as a wrong password — otherwise response
 * time alone says which staff emails exist.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(24).toString('base64'));
  return decoy;
}

/**
 * A temporary password for a new or reset staff account: 20 characters from
 * an alphabet without look-alikes, shown ONCE to the super admin who hands it
 * over. Generated rather than typed, because a typed one is how `Welcome123`
 * reaches production.
 */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** The floor for a password a person chooses for themselves. */
export const MIN_PASSWORD_LENGTH = 12;
