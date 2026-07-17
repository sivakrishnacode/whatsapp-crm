import {
  Controller,
  Get,
  Post,
  Patch,
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

@Controller('campaigns')
@UseGuards(SupabaseAuthGuard)
export class CampaignSchedulesController {
  private readonly logger = new Logger(CampaignSchedulesController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/campaigns/schedules */
  @Get('schedules')
  async listSchedules(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('status') status: string | undefined,
    @Query('type') type: string | undefined,
    @Res() res: Response,
  ) {
    const schedules = await this.prisma.campaign_schedules.findMany({
      where: {
        account_id: account.accountId,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    return res.status(HttpStatus.OK).json({ schedules });
  }

  /** POST /api/campaigns/schedules */
  @Post('schedules')
  async createSchedule(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      name?: unknown;
      type?: unknown;
      broadcast_id?: unknown;
      retargeting_config?: unknown;
      schedule_type?: unknown;
      scheduled_at?: unknown;
      recurring_pattern?: unknown;
      timezone?: unknown;
    },
    @Res() res: Response,
  ) {
    const { name, type, schedule_type, scheduled_at } = body;

    if (!name || !type || !schedule_type || !scheduled_at) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'name, type, schedule_type, and scheduled_at are required',
      });
    }

    if (type === 'broadcast' && !body.broadcast_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'broadcast_id is required for broadcast campaigns',
      });
    }

    if (type === 'retargeting' && !body.retargeting_config) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'retargeting_config is required for retargeting campaigns',
      });
    }

    if (schedule_type === 'recurring' && !body.recurring_pattern) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'recurring_pattern is required for recurring schedules',
      });
    }

    const schedule = await this.prisma.campaign_schedules.create({
      data: {
        account_id: account.accountId,
        name: name as string,
        type: type as string,
        broadcast_id: (body.broadcast_id as string | null) ?? null,
        retargeting_config: body.retargeting_config ?? undefined,
        schedule_type: schedule_type as string,
        scheduled_at: new Date(scheduled_at as string),
        recurring_pattern: (body.recurring_pattern as string | null) ?? null,
        timezone: (body.timezone as string | null) ?? 'UTC',
        status: 'pending',
      },
    });

    return res.status(HttpStatus.CREATED).json({ schedule });
  }
}
