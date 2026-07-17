import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { generateApiKey, normalizeScopes } from '../utils/api-keys.util';

const MAX_NAME_LEN = 80;
const MAX_EXPIRY_DAYS = 365;

const SAFE_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

@Controller('account')
@UseGuards(SupabaseAuthGuard)
export class AccountApiKeysController {
  private readonly logger = new Logger(AccountApiKeysController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/account/api-keys
   * List API keys (safe columns only — key_hash never returned). Any member.
   */
  @Get('api-keys')
  async listApiKeys(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const keys = await this.prisma.apiKey.findMany({
      where: { accountId: account.accountId },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return res.status(HttpStatus.OK).json({ keys });
  }

  /**
   * POST /api/account/api-keys
   * Mint a new key. Admin+. Plaintext is returned ONCE.
   */
  @Post('api-keys')
  async createApiKey(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: { name?: unknown; scopes?: unknown; expiresInDays?: unknown },
    @Res() res: Response,
  ) {
    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: "'name' is required" });
    }
    if (rawName.length > MAX_NAME_LEN) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: `Name must be ${MAX_NAME_LEN} characters or fewer`,
      });
    }

    const scopes = normalizeScopes(body?.scopes ?? []);
    if (scopes === null) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: "'scopes' must be an array of known scope strings",
      });
    }

    let expiresAt: Date | null = null;
    const rawExpiry = body?.expiresInDays;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS);
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    const { plaintext, hash, prefix } = generateApiKey();

    const key = await this.prisma.apiKey.create({
      data: {
        accountId: account.accountId,
        createdBy: account.userId,
        name: rawName,
        keyPrefix: prefix,
        keyHash: hash,
        scopes,
        expiresAt: expiresAt,
      },
      select: SAFE_SELECT,
    });

    return res.status(HttpStatus.CREATED).json({ key, plaintext });
  }

  /**
   * DELETE /api/account/api-keys/:id
   * Soft-revoke a key (sets revoked_at). Admin+.
   */
  @Delete('api-keys/:id')
  async revokeApiKey(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const updated = await this.prisma.apiKey.updateMany({
      where: {
        id,
        accountId: account.accountId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    if (updated.count === 0) {
      return res.status(HttpStatus.NOT_FOUND).json({
        error: 'API key not found or already revoked',
      });
    }

    return res.status(HttpStatus.OK).json({ success: true });
  }
}
