/**
 * Environment access for the admin panel.
 *
 * Every value is read through a function rather than a module-level constant
 * on purpose: `next build` imports these modules while collecting routes, and
 * a top-level throw there would fail the build on a machine that legitimately
 * has no secrets (CI, a Docker layer built before the env file is copied). Read
 * lazily and the error lands where it is actionable — on the first request.
 *
 * Deliberately no `server-only` import: proxy.ts needs the session secret and
 * runs outside the React server boundary. Nothing here is ever imported from a
 * client component, and none of it is NEXT_PUBLIC_, so none of it can leak into
 * the browser bundle.
 */

const SETUP_HINT =
  'Copy apps/admin-panel/.env.local.example to .env.local and fill it in.';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. ${SETUP_HINT}`);
  }
  return value;
}

export function adminUsername(): string {
  return required('ADMIN_USERNAME');
}

export function adminPassword(): string {
  return required('ADMIN_PASSWORD');
}

/**
 * HS256 signing key for the session cookie. 32 bytes is the floor for HS256 —
 * jose rejects shorter keys anyway, but failing here says why.
 */
export function sessionSecret(): Uint8Array {
  const secret = required('ADMIN_SESSION_SECRET');
  if (secret.length < 32) {
    throw new Error(
      `ADMIN_SESSION_SECRET is too short (${secret.length} chars, need 32+). ` +
        'Generate one with: openssl rand -base64 48'
    );
  }
  return new TextEncoder().encode(secret);
}

export function databaseUrl(): string {
  return required('DATABASE_URL');
}

/** Short by default — this panel can change what customers are billed. */
export function sessionTtlHours(): number {
  const raw = process.env.ADMIN_SESSION_TTL_HOURS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

/**
 * `subscription_plans` stores bare decimals with no currency column, so the
 * currency is a deployment-wide setting rather than per-row data.
 */
export function currency(): string {
  return process.env.ADMIN_CURRENCY?.trim() || 'INR';
}
