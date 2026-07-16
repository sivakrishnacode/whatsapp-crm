import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../auth/types/account-context.type';
import { InternalDispatchGuard } from './guards/internal-dispatch.guard';
import { AutomationDispatchService } from './services/automation-dispatch.service';
import { TriggerAutomationDto } from './dto/trigger-automation.dto';
import { InternalDispatchDto } from './dto/internal-dispatch.dto';

@Controller()
export class AutomationsEngineController {
  constructor(private readonly dispatch: AutomationDispatchService) {}

  /**
   * Manual/testing trigger entrypoint — user-facing, cookie-authenticated.
   * Ported from apps/web's POST /api/automations/engine.
   */
  @Post('automations/engine')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('agent')
  async trigger(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: TriggerAutomationDto,
  ) {
    await this.dispatch.dispatch({
      accountId: account.accountId,
      triggerType: body.trigger_type,
      contactId: body.contact_id ?? null,
      context: body.context ?? {},
    });
    return { ok: true };
  }

  /**
   * Internal, machine-to-machine bridge — called by apps/web's WhatsApp
   * webhook route (fire-and-forget) instead of the in-process
   * `runAutomationsForTrigger` call it used before the engine moved here.
   */
  @Post('internal/automations/dispatch')
  @UseGuards(InternalDispatchGuard)
  @HttpCode(202)
  async internalDispatch(@Body() body: InternalDispatchDto) {
    await this.dispatch.dispatch({
      accountId: body.account_id,
      triggerType: body.trigger_type,
      contactId: body.contact_id ?? null,
      context: body.context ?? {},
    });
    return { accepted: true };
  }
}
