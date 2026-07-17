import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  UseFilters,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, okList, ApiError } from '../utils/respond.util';
import { parseListParams, getKeysetWhereClause, buildPage } from '../utils/pagination.util';
import {
  serializeContact,
  findOrCreateContact,
  setContactTags,
  resolveAuditUserId,
} from '../utils/contacts.util';
import { Prisma } from '@prisma/client';
import { WebhookDeliverService } from '../services/webhook-deliver.service';

function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

@Controller('v1/contacts')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class ContactsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  @Get()
  @RequireScope('contacts:read')
  async listContacts(
    @CurrentAccount() ctx: AccountContext,
    @Query('limit') limitQuery?: string,
    @Query('cursor') cursorQuery?: string,
    @Query('search') searchQuery?: string,
    @Query('tag') tagQuery?: string,
  ) {
    const { limit, cursor } = parseListParams({ limit: limitQuery, cursor: cursorQuery });
    const search = searchQuery ? sanitizeSearch(searchQuery) : '';

    const whereClause: Prisma.contactsWhereInput = {
      account_id: ctx.accountId,
    };

    if (search) {
      whereClause.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (tagQuery) {
      whereClause.contact_tags = {
        some: {
          tag_id: tagQuery,
        },
      };
    }

    if (cursor) {
      const keyset = getKeysetWhereClause(cursor);
      whereClause.AND = [keyset];
    }

    const rows = await this.prisma.contacts.findMany({
      where: whereClause,
      include: {
        contact_tags: {
          include: {
            tags: true,
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
      items.map((r) => serializeContact(r)),
      nextCursor,
    );
  }

  @Post()
  @RequireScope('contacts:write')
  async createContact(
    @CurrentAccount() ctx: AccountContext,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      throw new ApiError('bad_request', "'phone' is required", HttpStatus.BAD_REQUEST);
    }

    const auditUserId = await resolveAuditUserId(this.prisma, ctx.accountId);

    const { id, created } = await findOrCreateContact(
      this.prisma,
      this.webhookDeliver,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        company: typeof body.company === 'string' ? body.company : undefined,
      },
    );

    if (Array.isArray(body.tags)) {
      await setContactTags(
        this.prisma,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t: any) => typeof t === 'string'),
      );
    }

    const contact = await this.prisma.contacts.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      include: {
        contact_tags: {
          include: {
            tags: true,
          },
        },
      },
    });

    if (!contact) {
      throw new ApiError('internal', 'Failed to retrieve created contact', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return ok(serializeContact(contact));
  }

  @Get(':id')
  @RequireScope('contacts:read')
  async getContact(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      include: {
        contact_tags: {
          include: {
            tags: true,
          },
        },
      },
    });

    if (!contact) {
      throw new ApiError('not_found', 'Contact not found', HttpStatus.NOT_FOUND);
    }

    return ok(serializeContact(contact));
  }

  @Patch(':id')
  @RequireScope('contacts:write')
  async updateContact(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    // Verify contact exists in this account
    const existing = await this.prisma.contacts.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
    });
    if (!existing) {
      throw new ApiError('not_found', 'Contact not found', HttpStatus.NOT_FOUND);
    }

    const updates: Record<string, any> = {};
    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || typeof value === 'string') {
        updates[field] = value;
      } else {
        throw new ApiError('bad_request', `'${field}' must be a string or null`, HttpStatus.BAD_REQUEST);
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.prisma.contacts.update({
        where: { id },
        data: {
          ...updates,
          updated_at: new Date(),
        },
      });
    }

    const auditUserId = await resolveAuditUserId(this.prisma, ctx.accountId);

    if (Array.isArray(body.tags)) {
      await setContactTags(
        this.prisma,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t: any) => typeof t === 'string'),
      );
    }

    const contact = await this.prisma.contacts.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      include: {
        contact_tags: {
          include: {
            tags: true,
          },
        },
      },
    });

    return ok(serializeContact(contact));
  }
}
