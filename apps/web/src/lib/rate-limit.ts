/**
 * Rate limiter — Redis-backed in production, in-process fallback for local dev.
 *
 * Production path (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set):
 *   Uses @upstash/ratelimit with a sliding-window algorithm. Each limit key
 *   is shared across ALL instances / lambda invocations — correct under
 *   Vercel serverless fan-out and horizontal VPS scale-out alike.
 *
 * Development / preview fallback (env vars absent):
 *   Falls back to the original in-process fixed-window Map. Works fine for
 *   a single Node process; the comment in the old implementation about
 *   horizontal scale still applies — don't use this path in production.
 *
 * Call-site API is identical to the old implementation:
 *   const result = checkRateLimit(key, options)
 *   if (!result.success) return rateLimitResponse(result)
 *
 * Migration guide:
 *   1. Install:  npm install @upstash/ratelimit @upstash/redis
 *   2. Add env:  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *      (copy from console.upstash.com → your database → REST API)
 *   3. Deploy — no call-site changes needed.
 */

import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

// ============================================================
// Redis-backed implementation (production)
// ============================================================

// Lazy-initialised so the module can load without the env vars
// present (e.g. in jest with the in-process fallback).
let redisRateLimiter:
  | ((key: string, opts: RateLimitOptions) => Promise<RateLimitResult>)
  | null = null;

function getRedisLimiter(): typeof redisRateLimiter {
  if (redisRateLimiter !== null) return redisRateLimiter;

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // Dynamic import — avoids bundling Redis in edge/test environments
  // where the env vars aren't set. The import resolves at runtime only
  // when the credentials are present.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Ratelimit } = require('@upstash/ratelimit') as typeof import('@upstash/ratelimit');

    const redis = new Redis({ url, token });

    // Cache of Ratelimit instances keyed by "limit:windowMs" — one
    // instance per distinct (limit, windowMs) pair. Ratelimit holds no
    // per-request mutable state so sharing the instance is safe.
    const limiterCache = new Map<string, InstanceType<typeof Ratelimit>>();

    redisRateLimiter = async (key: string, opts: RateLimitOptions): Promise<RateLimitResult> => {
      const cacheKey = `${opts.limit}:${opts.windowMs}`;
      let limiter = limiterCache.get(cacheKey);
      if (!limiter) {
        limiter = new Ratelimit({
          redis,
          // Sliding window is fairer than fixed-window under burst traffic:
          // a user who just used all N tokens can't immediately refill by
          // waiting for the window boundary.
          limiter: Ratelimit.slidingWindow(opts.limit, `${opts.windowMs} ms`),
          analytics: false,
          prefix: 'wacrm_rl',
        });
        limiterCache.set(cacheKey, limiter);
      }

      const result = await limiter.limit(key);
      return {
        success: result.success,
        remaining: result.remaining,
        reset: result.reset,          // Unix ms
        limit: opts.limit,
      };
    };
  } catch {
    // @upstash/ratelimit not installed — fall through to in-process.
    redisRateLimiter = null;
  }

  return redisRateLimiter;
}

// ============================================================
// In-process fixed-window fallback (development / single instance)
// ============================================================

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function checkInProcess(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

// ============================================================
// Public API — unchanged from the original implementation
// ============================================================

/**
 * Check the rate limit for `key`. Returns immediately using the
 * in-process fallback; switches to the Redis path when Upstash
 * credentials are present.
 *
 * Note: the Redis path is async; this function returns a Promise
 * that resolves to RateLimitResult in both cases. Call sites that
 * previously called this synchronously must `await` it.
 *
 * Existing call sites in this repo already do:
 *   const result = checkRateLimit(...)
 *   if (!result.success) return rateLimitResponse(result)
 *
 * If they are not currently `await`-ing this function, TypeScript
 * will flag the issue — which is the correct signal to add `await`.
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const redisLimiter = getRedisLimiter();
  if (redisLimiter) {
    try {
      return await redisLimiter(key, opts);
    } catch (err) {
      // Redis transient error — log and fall back to in-process so
      // the request isn't dropped entirely. A sustained Redis outage
      // reverts to the old single-instance behaviour, which is still
      // better than a 500.
      console.error('[rate-limit] Redis error, falling back to in-process:', err);
    }
  }
  return checkInProcess(key, opts);
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. 5/min per user — even a 1 000-recipient
   *  broadcast is one call; this caps the rate at which a single user
   *  can launch campaigns, not the messages inside one. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Under Upstash Redis this limit is correctly enforced
   *  across all serverless instances. */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. Under Redis this cap is global across all
   *  instances, making it actually effective. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
