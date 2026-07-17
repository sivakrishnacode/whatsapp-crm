import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../auth/types/account-context.type';
import { FlowsService } from './flows.service';
import { CreateFlowDto } from './dto/create-flow.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';
import { ActivateFlowDto } from './dto/activate-flow.dto';
import { ImportFlowDto } from './dto/import-flow.dto';

/**
 * Ported from the 8 Next.js route files under apps/web/src/app/api/flows/**.
 *
 * Auth mirrors the originals: every route requires a signed-in caller;
 * mutating routes additionally require the `agent` role (the originals
 * enforced this in-route because their writes used the RLS-bypassing
 * service-role client — same reasoning applies to Prisma).
 *
 * Route order matters: `templates` and `import` are declared before
 * the `:id` routes so Nest doesn't swallow them as flow ids.
 */
@Controller('flows')
@UseGuards(SupabaseAuthGuard)
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    const flows = await this.flows.list(account.accountId);
    return { flows };
  }

  @Post()
  @RequireRole('agent')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: CreateFlowDto,
  ) {
    const flow = await this.flows.create(
      account.userId,
      account.accountId,
      body,
    );
    return { flow };
  }

  @Get('templates')
  listTemplates() {
    return { templates: this.flows.listTemplates() };
  }

  @Post('import')
  @RequireRole('agent')
  async import(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: ImportFlowDto,
  ) {
    const flow = await this.flows.import(
      account.userId,
      account.accountId,
      body,
    );
    return { flow };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    return this.flows.getOne(id, account.accountId);
  }

  @Put(':id')
  @RequireRole('agent')
  async update(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: UpdateFlowDto,
  ) {
    return this.flows.update(id, account.accountId, body);
  }

  @Delete(':id')
  @RequireRole('agent')
  async remove(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    await this.flows.remove(id, account.accountId);
    return { ok: true };
  }

  @Post(':id/activate')
  @RequireRole('agent')
  async activate(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: ActivateFlowDto,
  ) {
    const flow = await this.flows.setStatus(id, account.accountId, body.status);
    return { flow };
  }

  /**
   * Pretty-printed JSON with a Content-Disposition attachment header so
   * the browser triggers a file download when hit directly — matches
   * the original byte-for-byte (2-space indent included).
   */
  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const { payload, filename } = await this.flows.export(
      id,
      account.accountId,
    );
    res
      .status(200)
      .set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
      .send(JSON.stringify(payload, null, 2));
  }

  @Get(':id/runs')
  async runs(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
  ) {
    return this.flows.listRuns(id, account.accountId);
  }
}
