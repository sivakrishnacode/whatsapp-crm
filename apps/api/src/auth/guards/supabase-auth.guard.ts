import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createServerClient } from '@supabase/ssr';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AccountRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../decorators/require-role.decorator';
import type { RequestWithAccountContext } from '../decorators/current-account.decorator';
import { hasMinRole } from '../role-rank.util';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    );
  }
  return jwks;
}

/**
 * Cookie-session auth for the dashboard — a 1:1 port of
 * apps/web/src/lib/auth/account.ts's `getCurrentAccount()`/`requireRole()`.
 *
 * The Next.js rewrite (apps/web/next.config.ts) forwards the original
 * `Cookie` header same-origin, so this guard only ever sees an
 * already-fresh access token — token refresh/rotation stays owned
 * entirely by apps/web/src/middleware.ts.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithAccountContext>();

    const supabase = createServerClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () =>
            Object.entries(request.cookies ?? {}).map(([name, value]) => ({
              name,
              value: String(value),
            })),
          setAll: () => {
            // No-op: Nest never writes cookies back. Refresh/rotation is
            // Next.js middleware's job (see file header comment).
          },
        },
      },
    );

    // Local read from the cookie envelope — no network call. Signature
    // verification is our own job, below (see supabase-auth.guard's
    // module comment / Phase 0 plan for why we don't call
    // supabase.auth.getUser(jwt) here instead).
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new UnauthorizedException();
    }

    const userId = await this.verifyAccessToken(session.access_token);

    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile || !profile.accountId || !profile.accountRole) {
      throw new ForbiddenException('Profile is not linked to an account');
    }

    const account = await this.prisma.account.findUnique({
      where: { id: profile.accountId },
      select: { id: true, name: true },
    });
    if (!account) {
      throw new ForbiddenException('Profile is not linked to an account');
    }

    const minRole = this.reflector.get<AccountRole | undefined>(
      REQUIRE_ROLE_KEY,
      context.getHandler(),
    );
    if (minRole && !hasMinRole(profile.accountRole, minRole)) {
      throw new ForbiddenException(
        `This action requires the '${minRole}' role or higher`,
      );
    }

    request.accountContext = {
      authType: 'supabase',
      userId,
      accountId: profile.accountId,
      role: profile.accountRole,
      account,
    };

    return true;
  }

  /** Returns the verified `sub` claim, or throws UnauthorizedException. */
  private async verifyAccessToken(token: string): Promise<string> {
    try {
      const alg = process.env.SUPABASE_JWT_ALG ?? 'HS256';
      const { payload } =
        alg === 'ES256'
          ? await jwtVerify(token, getJwks())
          : await jwtVerify(
              token,
              new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET),
            );

      if (typeof payload.sub !== 'string') {
        throw new Error('token has no sub claim');
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
