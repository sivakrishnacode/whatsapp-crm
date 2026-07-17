/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { ApiError } from '../../v1/utils/respond.util';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import type { RequestWithAccountContext } from '../decorators/current-account.decorator';

const VALID_KEY = 'conceps_live_abc123';
const KEY_HASH = createHash('sha256').update(VALID_KEY).digest('hex');

const KEY_ROW = {
  id: 'key-1',
  accountId: 'acc-1',
  keyHash: KEY_HASH,
  scopes: ['contacts:read'],
  createdBy: 'user-1',
  revokedAt: null,
  expiresAt: null,
};

function makeContext(authHeader?: string, requiredScope?: string) {
  const request = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as RequestWithAccountContext;
  const reflector = {
    get: vi.fn().mockReturnValue(requiredScope),
  } as unknown as Reflector;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
  return { request, reflector, context };
}

function makeMocks() {
  const prisma = {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue(KEY_ROW),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const rateLimit = {
    check: vi
      .fn()
      .mockResolvedValue({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
  };
  return { prisma, rateLimit };
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  try {
    await promise;
    expect.unreachable('guard must throw');
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect(err.getStatus()).toBe(status);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error('unreachable');
}

describe('ApiKeyGuard', () => {
  let prisma: ReturnType<typeof makeMocks>['prisma'];
  let rateLimit: ReturnType<typeof makeMocks>['rateLimit'];

  beforeEach(() => {
    ({ prisma, rateLimit } = makeMocks());
  });

  function guardFor(reflector: Reflector) {
    return new ApiKeyGuard(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
      reflector,
    );
  }

  it('401 unauthorized when no Authorization header is present', async () => {
    const { context, reflector } = makeContext(undefined);
    await expectApiError(guardFor(reflector).canActivate(context), 401, 'unauthorized');
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('401 when the bearer value does not look like an API key', async () => {
    const { context, reflector } = makeContext('Bearer not-a-conceps-key');
    await expectApiError(guardFor(reflector).canActivate(context), 401, 'unauthorized');
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('401 for unknown, revoked, and expired keys alike (anti-enumeration)', async () => {
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`);
    const guard = guardFor(reflector);

    prisma.apiKey.findUnique.mockResolvedValueOnce(null);
    await expectApiError(guard.canActivate(context), 401, 'unauthorized');

    prisma.apiKey.findUnique.mockResolvedValueOnce({ ...KEY_ROW, revokedAt: new Date() });
    await expectApiError(guard.canActivate(context), 401, 'unauthorized');

    prisma.apiKey.findUnique.mockResolvedValueOnce({
      ...KEY_ROW,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expectApiError(guard.canActivate(context), 401, 'unauthorized');
  });

  it('looks the key up by its SHA-256 hash, never the plaintext', async () => {
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`);
    await guardFor(reflector).canActivate(context);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: KEY_HASH },
    });
  });

  it('429 rate_limited with Retry-After/X-RateLimit-* headers when the budget is exhausted', async () => {
    const reset = Date.now() + 45_000;
    rateLimit.check.mockResolvedValueOnce({ success: false, limit: 120, remaining: 0, reset });
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`);

    const err = await expectApiError(
      guardFor(reflector).canActivate(context),
      429,
      'rate_limited',
    );
    expect(err!.headers!['X-RateLimit-Limit']).toBe('120');
    expect(err!.headers!['X-RateLimit-Remaining']).toBe('0');
    expect(Number(err!.headers!['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('rate-limits before the scope check (no free hammering with a bad scope)', async () => {
    rateLimit.check.mockResolvedValueOnce({ success: false, limit: 120, remaining: 0, reset: Date.now() + 1000 });
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`, 'messages:send');

    await expectApiError(guardFor(reflector).canActivate(context), 429, 'rate_limited');
    expect(rateLimit.check).toHaveBeenCalledWith('apikey:key-1', {
      limit: 120,
      windowMs: 60_000,
    });
  });

  it('403 forbidden naming the missing scope', async () => {
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`, 'messages:send');
    const err = await expectApiError(
      guardFor(reflector).canActivate(context),
      403,
      'forbidden',
    );
    expect((err!.getResponse() as any).error.message).toContain('messages:send');
  });

  it('passes with the right scope, attaches accountContext, and bumps last_used_at', async () => {
    const { context, reflector, request } = makeContext(`Bearer ${VALID_KEY}`, 'contacts:read');

    await expect(guardFor(reflector).canActivate(context)).resolves.toBe(true);
    expect(request.accountContext).toEqual({
      authType: 'api_key',
      accountId: 'acc-1',
      keyId: 'key-1',
      scopes: ['contacts:read'],
      createdBy: 'user-1',
    });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('passes without a scope requirement on unscoped routes (e.g. /v1/me)', async () => {
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`, undefined);
    await expect(guardFor(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('does not fail the request if the last_used_at bump rejects', async () => {
    prisma.apiKey.update.mockRejectedValueOnce(new Error('db hiccup'));
    const { context, reflector } = makeContext(`Bearer ${VALID_KEY}`);
    await expect(guardFor(reflector).canActivate(context)).resolves.toBe(true);
  });
});
