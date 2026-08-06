import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AgentConfigService } from '../services/agent-config.service';

/**
 * The Agent Studio surface: business profile, tone, skills, escalation
 * and test mode.
 *
 * Separate from `/ai/config` (provider + key) on purpose — saving a tone
 * change must not re-validate a key against the provider, which is a paid
 * call and a rate-limit away from blocking a typo fix.
 */
@Controller('ai/agent')
@UseGuards(SupabaseAuthGuard)
export class AgentController {
  constructor(private readonly agentConfig: AgentConfigService) {}

  /** Everything the studio screen renders, in one request. */
  @Get()
  async get(@CurrentAccount() account: SupabaseAccountContext) {
    return this.agentConfig.getStudio(account.accountId);
  }

  /** The skill registry alone — for a client that only needs the catalogue. */
  @Get('skills')
  skills() {
    return { skills: this.agentConfig.skillRegistry() };
  }

  @Patch()
  @RequireRole('admin')
  async save(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: Record<string, unknown>,
  ) {
    return this.agentConfig.saveStudio({
      accountId: account.accountId,
      body: body ?? {},
    });
  }

  /**
   * Read the business's website and draft the "what the business does"
   * description from it. Returns a draft; the user decides whether it is
   * true of their business, so nothing is saved here.
   */
  @Post('draft-from-site')
  @RequireRole('admin')
  async draftFromSite(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { url?: string },
  ) {
    return this.agentConfig.draftFromWebsite({
      accountId: account.accountId,
      url: body?.url,
    });
  }
}
