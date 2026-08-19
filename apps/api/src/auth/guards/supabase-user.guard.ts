import {
  CanActivate,
  ExecutionContext,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifySupabaseSession } from '../verify-supabase-session';

export interface RequestWithAuthUser extends Request {
  authUser: { userId: string };
}

/**
 * "Who are you", without "and which workspace are you in".
 *
 * SupabaseAuthGuard answers both and refuses the request when the second has
 * no answer — correct for every dashboard endpoint, because they all operate
 * on a workspace. But two things must work for a user who is a member of NONE:
 *
 *   - `POST /invitations/:token/redeem`. Since migration 095, a signup that
 *     arrived through an invite link gets no personal workspace, precisely so
 *     it does not litter their switcher with an empty unpaid one. So at the
 *     moment they redeem, zero memberships is the EXPECTED state, and a guard
 *     that demands one would reject the request that creates their first.
 *
 *   - `GET /account/workspaces`. Someone removed from their only workspace
 *     needs to be told that, and an empty list is how the web app knows to
 *     say so rather than showing a broken dashboard.
 */
@Injectable()
export class SupabaseUserGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAuthUser>();
    request.authUser = { userId: await verifySupabaseSession(request) };
    return true;
  }
}

/** Reads the verified user id SupabaseUserGuard attached to the request. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<RequestWithAuthUser>().authUser.userId,
);
