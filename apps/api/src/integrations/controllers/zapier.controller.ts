import {
  Controller,
  Get,
  Post,
  Patch,
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
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { encrypt } from '../../common/security/encryption.util';
import {
  normalizeWebhookUrl,
  generateWebhookSecret,
  serializeWebhookEndpoint,
  WEBHOOK_PUBLIC_SELECT,
  normalizeEvents,
} from '../../v1/utils/webhooks.util';

@Controller('integrations/zapier')
@UseGuards(SupabaseAuthGuard)
export class ZapierController {
  private readonly logger = new Logger(ZapierController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  /** GET /api/integrations/zapier — list this account's connections. */
  @Get()
  async list(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const rows = await this.prisma.webhook_endpoints.findMany({
      where: { account_id: account.accountId },
      select: WEBHOOK_PUBLIC_SELECT,
      orderBy: { created_at: 'desc' },
    });

    return res.status(HttpStatus.OK).json({
      endpoints: rows.map((r) => serializeWebhookEndpoint(r)),
    });
  }

  /** POST /api/integrations/zapier — connect a new Zapier Catch Hook URL. */
  @Post()
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { url?: unknown; events?: unknown },
    @Res() res: Response,
  ) {
    const url = normalizeWebhookUrl(body?.url);
    if (!url) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Enter a valid https:// Zapier webhook URL',
      });
    }

    const events = normalizeEvents(body?.events);
    if (!events) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Pick at least one event to trigger this Zap on',
      });
    }

    const secret = generateWebhookSecret();

    const created = await this.prisma.webhook_endpoints.create({
      data: {
        account_id: account.accountId,
        created_by: account.userId,
        url,
        secret: encrypt(secret),
        events,
      },
      select: WEBHOOK_PUBLIC_SELECT,
    });

    // Secret shown exactly once — same convention as the public /v1/webhooks API.
    return res.status(HttpStatus.CREATED).json({
      endpoint: { ...serializeWebhookEndpoint(created), secret },
    });
  }

  /** PATCH /api/integrations/zapier/:id — toggle active / update events. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { is_active?: unknown; events?: unknown },
    @Res() res: Response,
  ) {
    const updateData: Record<string, unknown> = {};

    if (typeof body?.is_active === 'boolean') {
      updateData.is_active = body.is_active;
      // Reset failure streak when re-enabling.
      if (body.is_active) updateData.failure_count = 0;
    }

    if (body?.events !== undefined) {
      const events = normalizeEvents(body.events);
      if (!events) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error: 'Pick at least one event to trigger this Zap on',
        });
      }
      updateData.events = events;
    }

    if (Object.keys(updateData).length === 0) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Nothing to update' });
    }

    const updated = await this.prisma.webhook_endpoints.updateMany({
      where: { id, account_id: account.accountId },
      data: updateData,
    });

    if (updated.count === 0) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Connection not found' });
    }

    const row = await this.prisma.webhook_endpoints.findFirst({
      where: { id, account_id: account.accountId },
      select: WEBHOOK_PUBLIC_SELECT,
    });

    return res
      .status(HttpStatus.OK)
      .json({ endpoint: serializeWebhookEndpoint(row!) });
  }

  /** DELETE /api/integrations/zapier/:id — disconnect. */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const deleted = await this.prisma.webhook_endpoints.deleteMany({
      where: { id, account_id: account.accountId },
    });

    if (deleted.count === 0) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Connection not found' });
    }

    return res.status(HttpStatus.OK).json({ success: true });
  }

  /** POST /api/integrations/zapier/:id/test — fire a test ping. */
  @Post(':id/test')
  async test(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const result = await this.webhookDeliver.sendTestWebhookPing(
      account.accountId,
      id,
    );

    if (!result.ok) {
      return res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: result.error ?? 'Test delivery failed' });
    }

    return res
      .status(HttpStatus.OK)
      .json({ success: true, status: result.status });
  }
}
