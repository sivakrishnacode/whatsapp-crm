import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AgentConfigService } from '../services/agent-config.service';
import { AgentsService } from '../services/agents.service';

/**
 * ============================================================
 * The agents surface: the list, and one agent's studio.
 *
 * Separate from `/ai/config` (provider + key) on purpose, and more so
 * since migration 084: `/ai/config` is now a WORKSPACE setting shared by
 * every agent, so saving a tone change must not re-validate a key
 * against the provider — a paid call, and a rate-limit away from
 * blocking a typo fix.
 *
 * ⚠️ Route order matters. `registry/skills` and `templates` are declared
 * BEFORE `:id`, or Nest matches them as an agent id and every request
 * for the catalogue 404s as a missing agent.
 * ============================================================
 */
@Controller('ai/agents')
@UseGuards(SupabaseAuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly agentConfig: AgentConfigService,
  ) {}

  /** Every agent, in routing order, with 30 days of numbers each. */
  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    return this.agents.list(account.accountId);
  }

  /** The skill registry alone — for a client that only needs the catalogue. */
  @Get('registry/skills')
  skills() {
    return { skills: this.agentConfig.skillRegistry() };
  }

  @Get('registry/templates')
  templates() {
    return { templates: this.agents.templates() };
  }

  @Post()
  @RequireRole('admin')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { name?: unknown; template_id?: unknown; channels?: unknown },
  ) {
    return this.agents.create({
      accountId: account.accountId,
      userId: account.userId,
      name: body?.name,
      templateId: body?.template_id,
      channels: body?.channels,
    });
  }

  /**
   * The routing order, whole-list. Declared before `:id` so a PUT to
   * `/ai/agents/order` is never read as an agent called "order".
   */
  @Put('order')
  @RequireRole('admin')
  async reorder(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { agent_ids?: unknown },
  ) {
    return this.agents.reorder(account.accountId, body?.agent_ids);
  }

  /** Everything one agent's studio screen renders, in one request. */
  @Get(':id')
  async get(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    return this.agentConfig.getStudio(account.accountId, id);
  }

  @Patch(':id')
  @RequireRole('admin')
  async save(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.agentConfig.saveStudio({
      accountId: account.accountId,
      agentId: id,
      body: body ?? {},
    });
  }

  @Delete(':id')
  @RequireRole('admin')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    return this.agents.remove(account.accountId, id);
  }

  @Post(':id/duplicate')
  @RequireRole('admin')
  async duplicate(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    return this.agents.duplicate({
      accountId: account.accountId,
      agentId: id,
      userId: account.userId,
    });
  }

  /** Which library documents and actions this agent may use. */
  @Put(':id/library')
  @RequireRole('admin')
  async saveLibrary(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: { document_ids?: unknown; action_ids?: unknown },
  ) {
    return this.agentConfig.saveLibrarySelection({
      accountId: account.accountId,
      agentId: id,
      documentIds: body?.document_ids,
      actionIds: body?.action_ids,
    });
  }

  /**
   * Read the business's website and draft the "what the business does"
   * description from it. Returns a draft; the user decides whether it is
   * true of their business, so nothing is saved here.
   */
  @Post(':id/draft-from-site')
  @RequireRole('admin')
  async draftFromSite(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: { url?: string },
  ) {
    return this.agentConfig.draftFromWebsite({
      accountId: account.accountId,
      agentId: id,
      url: body?.url,
    });
  }
}
