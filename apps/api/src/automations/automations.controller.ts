import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../auth/types/account-context.type';
import { AutomationsService } from './automations.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';

@Controller('automations')
@UseGuards(SupabaseAuthGuard)
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    const automations = await this.automations.list(account.accountId);
    return { automations };
  }

  @Post()
  @RequireRole('agent')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: CreateAutomationDto,
  ) {
    const automation = await this.automations.create(
      account.userId,
      account.accountId,
      body,
    );
    return { automation };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    return this.automations.getOne(id, account.userId);
  }

  @Patch(':id')
  @RequireRole('agent')
  async update(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: UpdateAutomationDto,
  ) {
    await this.automations.update(id, account.userId, body);
    return { ok: true };
  }

  @Delete(':id')
  @RequireRole('agent')
  async remove(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    await this.automations.remove(id, account.userId);
    return { ok: true };
  }

  @Post(':id/duplicate')
  @RequireRole('agent')
  async duplicate(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    const automation = await this.automations.duplicate(id, account.userId);
    return { automation };
  }

  @Get(':id/logs')
  async logs(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    const logs = await this.automations.listLogs(id, account.accountId);
    return { logs };
  }
}
