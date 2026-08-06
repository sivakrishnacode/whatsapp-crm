import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AgentActionsService } from '../services/agent-actions.service';

/**
 * Custom API actions — the HTTP endpoints an account lets the agent call.
 *
 * Writes are admin+: an action is an outbound request made with the
 * business's own credentials, so it belongs with the other settings-class
 * surfaces rather than being editable by any agent seat.
 */
@Controller('ai/actions')
@UseGuards(SupabaseAuthGuard)
export class AgentActionsController {
  constructor(private readonly actions: AgentActionsService) {}

  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    return this.actions.list(account.accountId);
  }

  @Post()
  @RequireRole('admin')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.create({
      accountId: account.accountId,
      userId: account.userId,
      body: body ?? {},
    });
  }

  @Patch(':id')
  @RequireRole('admin')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.update({
      accountId: account.accountId,
      actionId: id,
      body: body ?? {},
    });
  }

  @Delete(':id')
  @RequireRole('admin')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.actions.remove(account.accountId, id);
  }

  /**
   * Call the action once with admin-supplied values and show the raw
   * result — the same string the model would receive.
   */
  @Post(':id/test')
  @RequireRole('admin')
  async test(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { arguments?: Record<string, unknown> },
  ) {
    return this.actions.test({
      accountId: account.accountId,
      actionId: id,
      arguments: body?.arguments,
    });
  }
}
