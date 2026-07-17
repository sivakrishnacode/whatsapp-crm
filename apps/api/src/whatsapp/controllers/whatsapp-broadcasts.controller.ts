import {
  Controller,
  Get,
  Post,
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
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DashboardBroadcastService,
  type AudienceConfig,
  type VariableMapping,
} from '../services/dashboard-broadcast.service';

/**
 * Dashboard broadcast endpoints (the New Broadcast wizard):
 * - POST /whatsapp/broadcasts     → resolve audience, create broadcast +
 *   recipients, queue background delivery; returns 202 immediately
 * - GET  /whatsapp/broadcasts/:id → status + counts, polled by the
 *   wizard's progress bar (refresh-safe: counts live in the DB)
 *
 * Distinct from POST /whatsapp/broadcast (singular), the legacy
 * synchronous phone-list fan-out kept for API compatibility.
 */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappBroadcastsController {
  private readonly logger = new Logger(WhatsappBroadcastsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcasts: DashboardBroadcastService,
  ) {}

  @Post('broadcasts')
  @RequireRole('agent')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      name?: string;
      template_name?: string;
      template_language?: string;
      audience?: AudienceConfig;
      variables?: Record<string, VariableMapping>;
      header_media_url?: string;
    },
    @Res() res: Response,
  ) {
    const { id, totalRecipients } = await this.broadcasts.createAndQueue(
      account.accountId,
      account.userId,
      {
        name: body?.name ?? '',
        templateName: body?.template_name ?? '',
        templateLanguage: body?.template_language ?? null,
        audience: body?.audience as AudienceConfig,
        variables: body?.variables ?? {},
        headerMediaUrl: body?.header_media_url ?? null,
      },
    );

    return res.status(HttpStatus.ACCEPTED).json({
      id,
      status: 'sending',
      total_recipients: totalRecipients,
    });
  }

  @Get('broadcasts/:id')
  async getStatus(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id, account_id: account.accountId },
      select: {
        id: true,
        status: true,
        total_recipients: true,
        sent_count: true,
        delivered_count: true,
        read_count: true,
        replied_count: true,
        failed_count: true,
      },
    });
    if (!broadcast) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Broadcast not found' });
    }
    return res.status(HttpStatus.OK).json({ broadcast });
  }
}
