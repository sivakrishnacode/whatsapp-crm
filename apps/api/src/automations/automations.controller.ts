import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../auth/types/account-context.type';
import { AutomationsService } from './automations.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { PreviewStepDto } from './dto/preview-step.dto';
import { AutomationStepPreviewService } from './services/automation-step-preview.service';
import type { AutomationStepType } from './automation.types';

@Controller('automations')
@UseGuards(SupabaseAuthGuard)
export class AutomationsController {
  constructor(
    private readonly automations: AutomationsService,
    private readonly preview: AutomationStepPreviewService,
  ) {}

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

  /**
   * The sample data the editor shows beside each token.
   *
   * A GET with no step in it, because the editor asks once per open and
   * uses the answer for every field — asking per keystroke, or per
   * field, would be one request per token in the picker.
   *
   * ⚠️ DECLARED BEFORE `@Get(':id')`. Nest matches routes in declaration
   * order, so a literal path listed after a parameterised one never runs
   * — `/automations/sample-data` would be read as an automation with the
   * id "sample-data".
   */
  @Get('sample-data')
  async sampleData(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('automation_id') automationId?: string,
  ) {
    const sample = await this.preview.buildSampleContext(
      account.accountId,
      automationId,
    );
    return {
      contact: sample.context.contact ?? {},
      message: sample.context.message_text ?? '',
      channel: sample.context.channel ?? null,
      steps: sample.context.steps ?? {},
      contact_id: sample.contactId,
      note: sample.note,
    };
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

  /**
   * "What would this step do?" — the editor's Test tab.
   *
   * Not scoped to a saved automation: an author testing the step they
   * are building has not saved it yet, and making them save a
   * half-finished automation to test one step is how people stop
   * testing. `automation_id` is optional and only used to find the
   * outputs of earlier steps from previous runs.
   */
  @Post('preview-step')
  @RequireRole('agent')
  async previewStep(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: PreviewStepDto,
  ) {
    const sample = await this.preview.buildSampleContext(
      account.accountId,
      body.automation_id,
      body.contact_id,
    );
    const result = this.preview.preview(
      body.step_type as AutomationStepType,
      body.step_config ?? {},
      sample.context,
    );
    return {
      ...result,
      sample_contact_id: sample.contactId,
      note: sample.note,
    };
  }

  /**
   * Actually perform the step, once.
   *
   * A real send to a real person, so it is a separate endpoint behind a
   * separate button rather than a flag on the preview — a mode switch is
   * too easy to leave in the wrong position.
   */
  @Post('test-step')
  @RequireRole('agent')
  async testStep(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: PreviewStepDto,
  ) {
    const sample = await this.preview.buildSampleContext(
      account.accountId,
      body.automation_id,
      body.contact_id,
    );
    const result = await this.preview.runOnce(
      account.accountId,
      account.userId,
      body.automation_id,
      body.step_type,
      body.step_config ?? {},
      sample.context,
      sample.contactId,
    );
    return { ...result, sample_contact_id: sample.contactId };
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
