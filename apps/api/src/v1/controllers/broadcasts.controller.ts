import {
  Controller,
  Get,
  Post,
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
import type { AccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, ApiError } from '../utils/respond.util';
import { resolveAuditUserId } from '../utils/contacts.util';
import { BroadcastSendService } from '../services/broadcast-send.service';

@Controller('v1/broadcasts')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class BroadcastsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcastSendService: BroadcastSendService,
  ) {}

  @Post()
  @RequireScope('broadcasts:send')
  async createBroadcast(
    @CurrentAccount() ctx: AccountContext,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    const templateName = typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(this.prisma, ctx.accountId);

    const plan = await this.broadcastSendService.createBroadcast(ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((r: any) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    // Asynchronous background delivery (returns 202 immediately)
    void this.broadcastSendService.deliverBroadcast(plan);

    res.status(HttpStatus.ACCEPTED);
    return ok({
      broadcast_id: plan.broadcastId,
      status: 'sending',
      total_recipients: plan.planned.length,
      accepted: plan.planned.length,
      rejected: plan.rejected,
    });
  }

  @Get(':id')
  @RequireScope('broadcasts:send')
  async getBroadcast(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
  ) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: {
        id,
        account_id: ctx.accountId,
      },
      select: {
        id: true,
        name: true,
        template_name: true,
        template_language: true,
        status: true,
        total_recipients: true,
        sent_count: true,
        delivered_count: true,
        read_count: true,
        replied_count: true,
        failed_count: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!broadcast) {
      throw new ApiError('not_found', 'Broadcast not found', HttpStatus.NOT_FOUND);
    }

    return ok({
      id: broadcast.id,
      name: broadcast.name,
      template_name: broadcast.template_name,
      template_language: broadcast.template_language,
      status: broadcast.status,
      total_recipients: broadcast.total_recipients,
      sent_count: broadcast.sent_count,
      delivered_count: broadcast.delivered_count,
      read_count: broadcast.read_count,
      replied_count: broadcast.replied_count,
      failed_count: broadcast.failed_count,
      created_at: broadcast.created_at?.toISOString() || null,
      updated_at: broadcast.updated_at?.toISOString() || null,
    });
  }
}
