import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  UseFilters,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext, ApiKeyAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, okList, ApiError } from '../utils/respond.util';
import { encrypt } from '../../common/security/encryption.util';
import {
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
  normalizeEvents,
} from '../utils/webhooks.util';

@Controller('v1/webhooks')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class WebhooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireScope('webhooks:manage')
  async listWebhooks(@CurrentAccount() ctx: AccountContext) {
    const rows = await this.prisma.webhook_endpoints.findMany({
      where: {
        account_id: ctx.accountId,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    return okList(
      rows.map((r) => serializeWebhookEndpoint(r)),
      null,
    );
  }

  @Post()
  @RequireScope('webhooks:manage')
  async createWebhook(
    @CurrentAccount() ctx: AccountContext,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      throw new ApiError('bad_request', "'url' must be a valid https:// URL", HttpStatus.BAD_REQUEST);
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      throw new ApiError(
        'bad_request',
        "'events' must be a non-empty array of known event names",
        HttpStatus.BAD_REQUEST,
      );
    }

    const secret = generateWebhookSecret();
    const apiCtx = ctx as ApiKeyAccountContext;

    const created = await this.prisma.webhook_endpoints.create({
      data: {
        account_id: apiCtx.accountId,
        created_by: apiCtx.createdBy,
        url,
        secret: encrypt(secret),
        events,
      },
    });

    res.status(HttpStatus.CREATED);
    return ok({
      ...serializeWebhookEndpoint(created),
      secret,
    });
  }

  @Get(':id')
  @RequireScope('webhooks:manage')
  async getWebhook(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
  ) {
    const row = await this.prisma.webhook_endpoints.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
    });

    if (!row) {
      throw new ApiError('not_found', 'Webhook not found', HttpStatus.NOT_FOUND);
    }

    return ok(serializeWebhookEndpoint(row));
  }

  @Patch(':id')
  @RequireScope('webhooks:manage')
  async updateWebhook(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    // Verify exists
    const existing = await this.prisma.webhook_endpoints.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
    });
    if (!existing) {
      throw new ApiError('not_found', 'Webhook not found', HttpStatus.NOT_FOUND);
    }

    const updates: Record<string, any> = {};

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) {
        throw new ApiError('bad_request', "'url' must be a valid https:// URL", HttpStatus.BAD_REQUEST);
      }
      updates.url = url;
    }

    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) {
        throw new ApiError(
          'bad_request',
          "'events' must be a non-empty array of known event names",
          HttpStatus.BAD_REQUEST,
        );
      }
      updates.events = events;
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        throw new ApiError('bad_request', "'is_active' must be a boolean", HttpStatus.BAD_REQUEST);
      }
      updates.is_active = body.is_active;
      if (body.is_active === true) {
        updates.failure_count = 0;
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError('bad_request', 'No updatable fields provided', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.prisma.webhook_endpoints.update({
      where: { id },
      data: updates,
    });

    return ok(serializeWebhookEndpoint(updated));
  }

  @Delete(':id')
  @RequireScope('webhooks:manage')
  async deleteWebhook(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
  ) {
    // Verify exists
    const existing = await this.prisma.webhook_endpoints.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
    });
    if (!existing) {
      throw new ApiError('not_found', 'Webhook not found', HttpStatus.NOT_FOUND);
    }

    await this.prisma.webhook_endpoints.delete({
      where: { id },
    });

    return ok({ id, deleted: true });
  }
}
