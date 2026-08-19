import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AccountRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../decorators/require-role.decorator';
import type { RequestWithAccountContext } from '../decorators/current-account.decorator';
import { hasMinRole } from '../role-rank.util';
import {
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  resolveActiveWorkspace,
} from '../active-workspace';
import { verifySupabaseSession } from '../verify-supabase-session';

/**
 * Cookie-session auth for the dashboard: who you are, AND which workspace
 * this request is for.
 *
 * The Next.js rewrite (apps/web/next.config.ts) forwards the original
 * `Cookie` header same-origin, so this guard only ever sees an
 * already-fresh access token — token refresh/rotation stays owned
 * entirely by apps/web's proxy.
 *
 * Since migration 095 a user may be a member of several workspaces, so the
 * second half is no longer a lookup with one answer. It is resolved in
 * ../active-workspace.ts and, importantly, is NOT a credential — see that
 * file. Endpoints that must work for a user with no workspace at all use
 * SupabaseUserGuard instead.
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

    const userId = await verifySupabaseSession(request);

    // Migration 095: a user may be a member of several workspaces, so which
    // one this request is for comes from the switcher's cookie — matched
    // against `account_members`, never trusted. See active-workspace.ts.
    const requested = request.cookies?.[WORKSPACE_COOKIE];
    const workspace = await resolveActiveWorkspace(
      this.prisma,
      userId,
      typeof requested === 'string' && requested ? requested : undefined,
    );

    if (!workspace) {
      // A real state, not a broken one: somebody removed from the only
      // workspace they were in. Its own code so the web app can render "ask
      // for an invite" instead of a generic permission error.
      throw new ForbiddenException({
        error: 'no_workspace',
        message: 'You are not a member of any workspace',
      });
    }

    const minRole = this.reflector.get<AccountRole | undefined>(
      REQUIRE_ROLE_KEY,
      context.getHandler(),
    );
    if (minRole && !hasMinRole(workspace.role, minRole)) {
      throw new ForbiddenException(
        `This action requires the '${minRole}' role or higher`,
      );
    }

    // Tell the client which workspace it actually got. Only matters when the
    // cookie was missing or stale — otherwise the browser keeps sending a
    // value we keep discarding, and the switcher shows a workspace the data
    // did not come from.
    if (workspace.corrected) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader(WORKSPACE_HEADER, workspace.accountId);
    }

    request.accountContext = {
      authType: 'supabase',
      userId,
      accountId: workspace.accountId,
      role: workspace.role,
      account: workspace.account,
    };

    return true;
  }
}
