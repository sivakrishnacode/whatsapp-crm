import {
  Controller,
  Get,
  HttpStatus,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ApiError, okList } from '../utils/respond.util';
import {
  normalizeTemplateStatus,
  serializeTemplate,
  TEMPLATE_STATUSES,
} from '../utils/templates.util';

/**
 * Read-only view of the account's WhatsApp templates, so an integrator (a
 * store backend, say) can sync its own template library instead of retyping
 * names and bodies. Templates are still created and submitted to Meta in the
 * app; this only reads what is there.
 *
 * Gated by `messages:send`: a key that can send templates has to know which
 * exist, and a separate scope would mean re-issuing every integration's key.
 */
@Controller('v1/templates')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class TemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireScope('messages:send')
  async listTemplates(
    @CurrentAccount() ctx: AccountContext,
    @Query('status') statusParam?: string,
  ) {
    const status = normalizeTemplateStatus(statusParam);

    if (status === null) {
      throw new ApiError(
        'bad_request',
        `'status' must be one of ${TEMPLATE_STATUSES.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Prisma bypasses RLS — the account filter is the only tenant boundary.
    const rows = await this.prisma.message_templates.findMany({
      where: {
        account_id: ctx.accountId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
    });

    return okList(rows.map(serializeTemplate), null);
  }
}
