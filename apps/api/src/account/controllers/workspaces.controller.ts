import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CurrentUserId,
  SupabaseUserGuard,
} from '../../auth/guards/supabase-user.guard';
import {
  WORKSPACE_COOKIE,
  resolveActiveWorkspace,
} from '../../auth/active-workspace';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One year. The cookie is a preference, and `profiles.last_account_id` is the
 *  durable copy, so a long life costs nothing and re-picking your workspace on
 *  every session is the alternative. */
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

type WorkspaceRow = {
  account_id: string;
  name: string;
  logo_url: string | null;
  default_currency: string;
  default_country: string;
  role: string;
  is_owner: boolean;
  member_count: number;
  plan_display_name: string | null;
  status: string | null;
  standing: string | null;
  trial_end_at: Date | null;
  current_period_end: Date | null;
  onboarding_done: boolean;
  joined_at: Date;
};

/**
 * The workspace switcher's API.
 *
 * ⚠️ SupabaseUserGuard throughout, not SupabaseAuthGuard. Both routes have to
 * work for a user who is a member of NO workspace — somebody removed from the
 * only one they were in. `GET` returning an empty list is exactly how the web
 * app learns to say "you're not in any workspace" instead of rendering a broken
 * dashboard, and a guard that 403s that case would make the honest screen
 * unreachable.
 */
@Controller('account/workspaces')
@UseGuards(SupabaseUserGuard)
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/account/workspaces
   *
   * Every workspace you belong to, your role in each, and its billing
   * standing — one round trip for the whole switcher.
   *
   * The standing is not decoration. The onboarding gate sends a lapsed
   * workspace to `/billing`, and the switcher stays visible on that screen
   * precisely so an agency whose one client lapsed can leave; without a
   * per-row standing the dot would be on no row and you would have to switch
   * into each workspace to find the healthy one.
   *
   * `activeAccountId` is echoed so the client renders the row the server will
   * actually serve data for, rather than whatever its cookie says.
   */
  @Get()
  async list(@CurrentUserId() userId: string, @Res() res: Response) {
    const rows = await this.prisma.$queryRawUnsafe<WorkspaceRow[]>(
      `SELECT * FROM list_my_workspaces($1::uuid)`,
      userId,
    );

    const active = await resolveActiveWorkspace(
      this.prisma,
      userId,
      typeof res.req.cookies?.[WORKSPACE_COOKIE] === 'string'
        ? (res.req.cookies[WORKSPACE_COOKIE] as string)
        : undefined,
    );

    return res.status(HttpStatus.OK).json({
      activeAccountId: active?.accountId ?? null,
      workspaces: rows.map((r) => ({
        id: r.account_id,
        name: r.name,
        logo_url: r.logo_url,
        default_currency: r.default_currency,
        default_country: r.default_country,
        role: r.role,
        is_owner: r.is_owner,
        member_count: r.member_count,
        plan_name: r.plan_display_name,
        subscription_status: r.status,
        // good | grace | lapsed — grace is dunning and still ENTITLED, so the
        // UI must not paint it the same as lapsed.
        standing: r.standing,
        trial_end_at: r.trial_end_at,
        current_period_end: r.current_period_end,
        onboarding_done: r.onboarding_done,
        joined_at: r.joined_at,
      })),
    });
  }

  /**
   * POST /api/account/workspaces/active  { accountId }
   *
   * Switch workspace. Writes both halves of the memory: the cookie the Nest
   * guard reads on the next request, and `profiles.last_account_id` so a
   * different device lands in the same place.
   *
   * Membership is validated by `set_active_workspace` before either is
   * written — not because the cookie is trusted (nothing trusts it; RLS reads
   * memberships) but so a cookie can't be left naming a workspace the fallback
   * chain has to discard on every subsequent request.
   *
   * ⚠️ The caller must do a FULL PAGE LOAD after this, not a soft navigation.
   * Every realtime subscription, SWR cache and Supabase channel in the
   * dashboard is keyed by account id, and a soft switch leaves the old
   * workspace's channels open — which renders another client's messages
   * arriving in this client's inbox.
   */
  @Post('active')
  async setActive(
    @CurrentUserId() userId: string,
    @Body() body: { accountId?: unknown },
    @Res() res: Response,
  ) {
    const accountId = body?.accountId;

    if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: "'accountId' must be a valid UUID" });
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `SELECT set_active_workspace($1::uuid, $2::uuid)`,
        accountId,
        userId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      if (pg.code === '42501') {
        return res
          .status(HttpStatus.FORBIDDEN)
          .json({ error: 'You are not a member of that workspace' });
      }
      this.logger.error('set_active_workspace RPC error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to switch workspace' });
    }

    res.cookie(WORKSPACE_COOKIE, accountId, {
      httpOnly: false,
      // Readable by the browser on purpose: apps/web's client-side Supabase
      // queries scope themselves by account id, and they need the same answer
      // the API just gave without a round trip to ask for it. There is nothing
      // secret in a workspace id — it appears in every media URL — and it is
      // authority for nothing.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S * 1000,
    });

    return res.status(HttpStatus.OK).json({ ok: true, accountId });
  }
}
