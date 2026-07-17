import { Controller, Get, UseGuards, UseFilters } from '@nestjs/common';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext, ApiKeyAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok } from '../utils/respond.util';

@Controller('v1/me')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getMe(@CurrentAccount() ctx: AccountContext) {
    const apiCtx = ctx as ApiKeyAccountContext;
    const account = await this.prisma.account.findUnique({
      where: { id: apiCtx.accountId },
      select: { name: true },
    });
    return ok({
      account: { id: apiCtx.accountId, name: account?.name || '' },
      key: { id: apiCtx.keyId, scopes: apiCtx.scopes },
    });
  }
}
