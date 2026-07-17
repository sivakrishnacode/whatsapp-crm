import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import {
  forbidden,
  rateLimited,
  unauthorized,
} from '../../v1/utils/respond.util';
import {
  REQUIRE_SCOPE_KEY,
  type ApiScope,
} from '../decorators/require-scope.decorator';
import type { RequestWithAccountContext } from '../decorators/current-account.decorator';

const API_KEY_PREFIX = 'conceps_live_';

/** Rate limit for the public REST API. */
const PUBLIC_API_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

function extractKey(request: Request): string | null {
  const header = request.headers['authorization'];
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

function looksLikeApiKey(value: string): boolean {
  return (
    value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length
  );
}

function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Bearer API-key auth for the public API — a 1:1 port of
 * apps/web/src/lib/auth/api-context.ts's `requireApiKey()`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithAccountContext>();

    const presented = extractKey(request);
    if (!presented || !looksLikeApiKey(presented)) {
      throw unauthorized();
    }

    const row = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(presented) },
    });
    // Unknown, revoked, and expired keys all collapse to the same 401 —
    // an attacker probing keys can't distinguish "never existed" from
    // "existed but is dead."
    if (
      !row ||
      row.revokedAt ||
      (row.expiresAt && row.expiresAt.getTime() <= Date.now())
    ) {
      throw unauthorized();
    }

    // Rate-limit before the scope check so an unauthorized-scope caller
    // still can't hammer the endpoint for free.
    const limit = await this.rateLimit.check(
      `apikey:${row.id}`,
      PUBLIC_API_RATE_LIMIT,
    );
    if (!limit.success) {
      // 429 + Retry-After / X-RateLimit-* headers — the documented public
      // contract (docs/public-api.md), matching the legacy requireApiKey().
      throw rateLimited(limit);
    }

    const requiredScope = this.reflector.get<ApiScope | undefined>(
      REQUIRE_SCOPE_KEY,
      context.getHandler(),
    );
    if (requiredScope && !row.scopes.includes(requiredScope)) {
      throw forbidden(`This API key is missing the '${requiredScope}' scope`);
    }

    // Fire-and-forget — must never fail the request it authenticates.
    void this.prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) => {
        console.warn('[ApiKeyGuard] last_used_at bump failed:', err);
      });

    request.accountContext = {
      authType: 'api_key',
      accountId: row.accountId,
      keyId: row.id,
      scopes: row.scopes,
      createdBy: row.createdBy,
    };

    return true;
  }
}
