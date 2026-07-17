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
  return typeof v === 'string' && (VALID_ROLES as readonly string[]).includes(v);
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
      await this.prisma.$executeRawUnsafe(
        `SELECT set_member_role($1::uuid, $2)`,
        userId,
        role,
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
   * Remove a member. Admin+.
   * Delegates to the `remove_account_member` SECURITY DEFINER RPC.
   */
  @Delete('members/:userId')
  async removeMember(
    @Param('userId') userId: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    let newPersonalAccountId: string | null = null;

    try {
      const result = await this.prisma.$queryRawUnsafe<
        { remove_account_member: string }[]
      >(`SELECT remove_account_member($1::uuid)`, userId);
      newPersonalAccountId = result[0]?.remove_account_member ?? null;
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

    return res.status(HttpStatus.OK).json({ ok: true, newPersonalAccountId });
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

    // Belt-and-braces: verify caller is owner before hitting the RPC
    const profile = await this.prisma.profile.findUnique({
      where: { userId: account.userId },
      select: { accountRole: true },
    });

    if (profile?.accountRole !== 'owner') {
      return res
        .status(HttpStatus.FORBIDDEN)
        .json({ error: 'Only the account owner can transfer ownership' });
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `SELECT transfer_account_ownership($1::uuid)`,
        newOwnerUserId,
      );
    } catch (err: unknown) {
      const pg = err as { code?: string; message?: string };
      const code = pg.code ?? '';
      const message = pg.message ?? 'Failed to transfer ownership';
      if (code === '42501' || code === '22023') {
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
