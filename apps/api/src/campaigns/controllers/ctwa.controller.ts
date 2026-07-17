import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
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

@Controller('ctwa')
@UseGuards(SupabaseAuthGuard)
export class CtwaController {
  private readonly logger = new Logger(CtwaController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/ctwa/campaigns */
  @Get('campaigns')
  async listCampaigns(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('status') status: string | undefined,
    @Res() res: Response,
  ) {
    const campaigns = await this.prisma.ctwa_campaigns.findMany({
      where: {
        account_id: account.accountId,
        ...(status ? { status } : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    return res.status(HttpStatus.OK).json({ campaigns });
  }

  /** POST /api/ctwa/campaigns */
  @Post('campaigns')
  async createCampaign(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      name?: unknown;
      meta_ad_id?: unknown;
      meta_campaign_id?: unknown;
      pre_filled_message?: unknown;
      deep_link_url?: unknown;
    },
    @Res() res: Response,
  ) {
    if (!body?.name) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Campaign name is required' });
    }

    const campaign = await this.prisma.ctwa_campaigns.create({
      data: {
        account_id: account.accountId,
        name: body.name as string,
        meta_ad_id: (body.meta_ad_id as string | null) ?? null,
        meta_campaign_id: (body.meta_campaign_id as string | null) ?? null,
        pre_filled_message: (body.pre_filled_message as string | null) ?? null,
        deep_link_url: (body.deep_link_url as string | null) ?? null,
        status: 'active',
      },
    });

    return res.status(HttpStatus.CREATED).json({ campaign });
  }

  /** POST /api/ctwa/track — record an ad click. */
  @Post('track')
  async trackClick(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      campaign_id?: unknown;
      contact_id?: unknown;
      conversation_id?: unknown;
      user_agent?: unknown;
      referrer?: unknown;
      ip_address?: unknown;
    },
    @Res() res: Response,
  ) {
    if (!body?.campaign_id) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Campaign ID is required' });
    }

    const click = await this.prisma.ctwa_clicks.create({
      data: {
        campaign_id: body.campaign_id as string,
        contact_id: (body.contact_id as string | null) ?? null,
        conversation_id: (body.conversation_id as string | null) ?? null,
        user_agent: (body.user_agent as string | null) ?? null,
        referrer: (body.referrer as string | null) ?? null,
        ip_address: (body.ip_address as string | null) ?? null,
        converted: false,
      },
    });

    return res.status(HttpStatus.CREATED).json({ click });
  }
}
