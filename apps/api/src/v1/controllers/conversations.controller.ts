import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  UseFilters,
  HttpStatus,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, okList, ApiError } from '../utils/respond.util';
import { parseListParams, getKeysetWhereClause, buildPage } from '../utils/pagination.util';
import { serializeConversation, serializeMessage } from '../utils/conversations.util';
import { Prisma } from '@prisma/client';

@Controller('v1/conversations')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class ConversationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireScope('conversations:read')
  async listConversations(
    @CurrentAccount() ctx: AccountContext,
    @Query('limit') limitQuery?: string,
    @Query('cursor') cursorQuery?: string,
    @Query('status') status?: string,
    @Query('contact_id') contactId?: string,
  ) {
    const { limit, cursor } = parseListParams({ limit: limitQuery, cursor: cursorQuery });

    const whereClause: Prisma.conversationsWhereInput = {
      account_id: ctx.accountId,
    };

    if (status) {
      whereClause.status = status;
    }
    if (contactId) {
      whereClause.contact_id = contactId;
    }

    if (cursor) {
      const keyset = getKeysetWhereClause(cursor);
      whereClause.AND = [keyset];
    }

    const rows = await this.prisma.conversations.findMany({
      where: whereClause,
      include: {
        contacts: {
          include: {
            contact_tags: {
              include: {
                tags: true,
              },
            },
          },
        },
      },
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });

    const { items, nextCursor } = buildPage(rows, limit);
    return okList(
      items.map((r) => serializeConversation(r)),
      nextCursor,
    );
  }

  @Get(':id')
  @RequireScope('conversations:read')
  async getConversation(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
  ) {
    const conv = await this.prisma.conversations.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      include: {
        contacts: {
          include: {
            contact_tags: {
              include: {
                tags: true,
              },
            },
          },
        },
      },
    });

    if (!conv) {
      throw new ApiError('not_found', 'Conversation not found', HttpStatus.NOT_FOUND);
    }

    return ok(serializeConversation(conv));
  }

  @Get(':id/messages')
  @RequireScope('messages:read')
  async getConversationMessages(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Query('limit') limitQuery?: string,
    @Query('cursor') cursorQuery?: string,
  ) {
    const { limit, cursor } = parseListParams({ limit: limitQuery, cursor: cursorQuery });

    // Gate on account ownership of the conversation first
    const conv = await this.prisma.conversations.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      select: { id: true },
    });

    if (!conv) {
      throw new ApiError('not_found', 'Conversation not found', HttpStatus.NOT_FOUND);
    }

    const whereClause: Prisma.messagesWhereInput = {
      conversation_id: id,
    };

    if (cursor) {
      const keyset = getKeysetWhereClause(cursor);
      whereClause.AND = [keyset];
    }

    const rows = await this.prisma.messages.findMany({
      where: whereClause,
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });

    const { items, nextCursor } = buildPage(rows, limit);
    return okList(
      items.map((m) => serializeMessage(m)),
      nextCursor,
    );
  }
}
