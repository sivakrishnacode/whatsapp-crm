import {
  Controller,
  Patch,
  Delete,
  Param,
  Body,
  Post,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;
type AccountRole = (typeof VALID_ROLES)[number];

function isAccountRole(v: unknown): v is AccountRole {
  return (
    typeof v === 'string' && (VALID_ROLES as readonly string[]).includes(v)
  );
}

/** Map Postgres SQLSTATEs from the RPCs back to HTTP statuses. */
function rpcStatusCode(code: string): number {
  if (code === '42501') return HttpStatus.FORBIDDEN;
  if (code === '22023') return HttpStatus.BAD_REQUEST;
  if (code === '23505') return HttpStatus.CONFLICT;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Controller('account')
@UseGuards(SupabaseAuthGuard)
export class AccountMembersController {
  private readonly logger = new Logger(AccountMembersController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * PATCH /api/account/members/:userId
   * Change a member's role. Admin+.
   * Delegates to the `set_member_role` SECURITY DEFINER RPC.
   */
  @Patch('members/:userId')
  async setMemberRole(
    @Param('userId') userId: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { role?: unknown },
    @Res() res: Response,
  ) {
    const role = body?.role;

    if (!isAccountRole(role)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "'role' must be one of owner, admin, agent, viewer",
      });
    }

    if (role === 'owner') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'Use POST /api/account/transfer-ownership to promote a member to owner',
      });
    }

    try {
      // Migration 095: the workspace is explicit (the caller may be in
      // several), and so is the actor — apps/api connects as `postgres`, where
      // `auth.uid()` is NULL, so without the 4th argument this RPC raises
      // 'Unauthorized' every time. It did, for as long as this endpoint has
      // existed. See section 9b of the migration.
      await this.prisma.$executeRawUnsafe(
        `SELECT set_member_role($1::uuid, $2::uuid, $3, $4::uuid)`,
        account.accountId,
        userId,
        role,
        account.userId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      const code = pg.code ?? '';
      const message = pg.message ?? 'Failed to update member role';
      if (code === '42501' || code === '22023') {
        return res.status(rpcStatusCode(code)).json({ error: message });
      }
      this.logger.error('set_member_role RPC error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to update member role' });
    }

    return res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * DELETE /api/account/members/:userId
   * Remove a member from THIS workspace. Admin+.
   * Delegates to the `remove_account_member` SECURITY DEFINER RPC.
   *
   * ⚠️ No longer returns a `newPersonalAccountId`. Before migration 095,
   * removing somebody meant moving their single profile row, so the RPC had to
   * mint them a replacement personal workspace to land in. Now removal just
   * deletes one membership row and every other one they hold is untouched — so
   * there is nothing to hand back. A user removed from their only workspace
   * ends up in none, which the web app handles explicitly rather than papering
   * over with an empty workspace nobody asked for.
   */
  @Delete('members/:userId')
  async removeMember(
    @Param('userId') userId: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      await this.prisma.$executeRawUnsafe(
        `SELECT remove_account_member($1::uuid, $2::uuid, $3::uuid)`,
        account.accountId,
        userId,
        account.userId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      const code = pg.code ?? '';
      const message = pg.message ?? 'Failed to remove member';
      if (code === '42501' || code === '22023') {
        return res.status(rpcStatusCode(code)).json({ error: message });
      }
      this.logger.error('remove_account_member RPC error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to remove member' });
    }

    return res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * POST /api/account/leave
   * Leave THIS workspace. Any member except the owner.
   *
   * New in migration 095, and only expressible now: before it, your membership
   * WAS your account, so "leave" and "delete everything I have" were the same
   * operation. An owner must transfer first — a workspace with no owner has no
   * subscription to resolve a plan through.
   */
  @Post('leave')
  async leaveWorkspace(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      await this.prisma.$executeRawUnsafe(
        `SELECT leave_account($1::uuid, $2::uuid)`,
        account.accountId,
        account.userId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      const code = pg.code ?? '';
      const message = pg.message ?? 'Failed to leave workspace';
      if (code === '42501' || code === '22023') {
        return res.status(rpcStatusCode(code)).json({ error: message });
      }
      this.logger.error('leave_account RPC error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to leave workspace' });
    }

    return res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * POST /api/account/transfer-ownership
   * Owner only. Atomically transfers ownership via RPC.
   */
  @Post('transfer-ownership')
  async transferOwnership(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { newOwnerUserId?: unknown },
    @Res() res: Response,
  ) {
    const newOwnerUserId = body?.newOwnerUserId;

    if (typeof newOwnerUserId !== 'string' || !UUID_RE.test(newOwnerUserId)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: "'newOwnerUserId' must be a valid UUID" });
    }

    // Belt-and-braces: the guard already resolved the caller's role in THIS
    // workspace, which is the only role that matters here — they may well be a
    // plain agent in another. The RPC re-checks it anyway.
    if (account.role !== 'owner') {
      return res
        .status(HttpStatus.FORBIDDEN)
        .json({ error: 'Only the workspace owner can transfer ownership' });
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `SELECT transfer_account_ownership($1::uuid, $2::uuid, $3::uuid)`,
        account.accountId,
        newOwnerUserId,
        account.userId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      const code = pg.code ?? '';
      const message = pg.message ?? 'Failed to transfer ownership';
      // 23505 is the phase-1 refusal: the new owner already owns a workspace,
      // and `idx_accounts_one_per_owner` stands until billing is
      // account-scoped. It carries a sentence worth showing, so surface it as
      // a 409 rather than swallowing it into a 500.
      if (code === '42501' || code === '22023' || code === '23505') {
        return res.status(rpcStatusCode(code)).json({ error: message });
      }
      this.logger.error('transfer_account_ownership RPC error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to transfer ownership' });
    }

    return res.status(HttpStatus.OK).json({ ok: true });
  }
}
