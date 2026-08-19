import {
  Controller,
  Get,
  Patch,
  Body,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InvalidWorkspaceLogoError,
  normalizeWorkspaceLogoUrl,
} from '../../common/storage/workspace-logo.util';

const MAX_NAME_LEN = 80;

const ROLES_ORDER = ['owner', 'admin', 'agent', 'viewer'] as const;

function canManageMembers(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

@Controller('account')
@UseGuards(SupabaseAuthGuard)
export class AccountController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/account
   * Returns current caller's account details + their role.
   */
  @Get()
  async getAccount(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const acc = await this.prisma.account.findUnique({
      where: { id: account.accountId },
      select: {
        id: true,
        name: true,
        logoUrl: true,
        ownerUserId: true,
        createdAt: true,
      },
    });

    if (!acc) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Account not found' });
    }

    return res.status(HttpStatus.OK).json({
      account: {
        id: acc.id,
        name: acc.name,
        logo_url: acc.logoUrl,
        owner_user_id: acc.ownerUserId,
        created_at: acc.createdAt,
      },
      // The guard already resolved the caller's role IN THIS WORKSPACE. It
      // used to be re-read from `profiles.accountRole`, which after migration
      // 095 would be asking "what is this person's role" — a question with no
      // answer once they hold one role here and another somewhere else.
      role: account.role,
    });
  }

  /**
   * PATCH /api/account
   * Rename the account and/or set its logo. Admin+ only.
   *
   * Both fields are optional and independent — the settings form saves
   * the name and the logo with separate controls, and sending the whole
   * object back for either one would let a stale name overwrite a
   * rename made in another tab. Presence of the *key* is the signal, so
   * `{ logo_url: null }` clears the logo while an absent key leaves it
   * alone.
   */
  @Patch()
  async updateAccount(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { name?: unknown; logo_url?: unknown },
    @Res() res: Response,
  ) {
    if (!canManageMembers(account.role)) {
      return res
        .status(HttpStatus.FORBIDDEN)
        .json({ error: 'Admin+ required' });
    }

    const patch: { name?: string; logoUrl?: string | null } = {};

    if (body && 'name' in body) {
      const rawName = body.name;
      if (typeof rawName !== 'string') {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: "'name' must be a string" });
      }

      const name = rawName.trim();
      if (name.length === 0) {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'Account name cannot be empty' });
      }
      if (name.length > MAX_NAME_LEN) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error: `Account name must be ${MAX_NAME_LEN} characters or fewer`,
        });
      }

      patch.name = name;
    }

    if (body && 'logo_url' in body) {
      try {
        // Scoped to the caller's own account folder — see the util for
        // why an arbitrary URL is not acceptable here.
        patch.logoUrl = normalizeWorkspaceLogoUrl(
          body.logo_url,
          account.accountId,
          process.env.SUPABASE_URL,
        );
      } catch (error) {
        if (error instanceof InvalidWorkspaceLogoError) {
          return res
            .status(HttpStatus.BAD_REQUEST)
            .json({ error: error.message });
        }
        throw error;
      }
    }

    if (Object.keys(patch).length === 0) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: "Provide 'name' and/or 'logo_url'" });
    }

    const updated = await this.prisma.account.update({
      where: { id: account.accountId },
      data: patch,
      select: { id: true, name: true, logoUrl: true },
    });

    return res.status(HttpStatus.OK).json({
      account: {
        id: updated.id,
        name: updated.name,
        logo_url: updated.logoUrl,
      },
    });
  }

  /**
   * GET /api/account/members
   * List team members. Any member can view; only admin+ sees emails.
   */
  @Get('members')
  async getMembers(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    // Membership drives the list now, and the profile only supplies the
    // person. `joined_at` is the MEMBERSHIP's created_at, not the profile's —
    // it used to be the latter, which after 095 would report when somebody
    // signed up rather than when they joined this workspace, and for an
    // agency's client workspaces those are months apart.
    const rows = await this.prisma.account_members.findMany({
      where: { account_id: account.accountId },
      select: { user_id: true, role: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    const profiles = await this.prisma.profile.findMany({
      where: { userId: { in: rows.map((r) => r.user_id) } },
      select: {
        userId: true,
        fullName: true,
        email: true,
        avatarUrl: true,
      },
    });
    const byUser = new Map(profiles.map((p) => [p.userId, p]));

    const canSeeEmails = canManageMembers(account.role);

    const members = rows
      .filter((r) => (ROLES_ORDER as readonly string[]).includes(r.role))
      .map((r) => {
        const p = byUser.get(r.user_id);
        return {
          user_id: r.user_id,
          full_name: p?.fullName ?? '',
          email: canSeeEmails ? (p?.email ?? null) : null,
          avatar_url: p?.avatarUrl ?? null,
          role: r.role,
          joined_at: r.created_at,
        };
      });

    return res.status(HttpStatus.OK).json({ members });
  }
}
