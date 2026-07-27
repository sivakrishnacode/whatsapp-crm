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
import { decrypt } from '../../common/security/encryption.util';
import {
  listFlows,
  getFlowDetails,
  getFlowPreview,
  downloadFlowJson,
  createFlow,
  updateFlowMetadata,
  updateFlowJson,
  publishFlow,
  deprecateFlow,
  deleteFlow,
} from '../meta-flows-api.util';
import {
  META_FLOW_TEMPLATES,
  getMetaFlowTemplate,
} from '../meta-flows-templates';
import {
  CreateMetaFlowDto,
  UpdateMetaFlowDto,
  UpdateMetaFlowJsonDto,
} from '../dto/meta-flows.dto';

/**
 * Native Meta WhatsApp **Flows** management (create / edit / preview /
 * publish). Distinct from the internal `flows` engine at `/flows` — this
 * surface wraps Meta's Flows API and manages flows that live in Meta under
 * the account's WABA. Dashboard-only (Supabase cookie auth).
 *
 * Route base `whatsapp/meta-flows` — reached from the web via the
 * `/api/whatsapp/:path*` rewrite. Every handler is account-scoped: it
 * resolves the caller's `whatsapp_config`, requires a `waba_id`, and uses
 * the decrypted access token.
 *
 * NOTE: Publishing normally requires business verification; gating the
 * Publish action on `whatsapp_config.messaging_limit_tier` is a deliberate
 * follow-up — for now the endpoint is exposed as-is.
 */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappFlowsController {
  private readonly logger = new Logger(WhatsappFlowsController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Resolve `{ wabaId, accessToken }` for the account, or write a 400 and
   *  return null. Callers must bail when null. */
  private async resolveMeta(
    accountId: string,
    res: Response,
  ): Promise<{ wabaId: string; accessToken: string } | null> {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: accountId },
    });
    if (!config) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
      });
      return null;
    }
    if (!config.waba_id) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'WhatsApp Business Account (WABA) not connected. Re-connect your account in Settings to manage Flows.',
      });
      return null;
    }
    return {
      wabaId: config.waba_id,
      accessToken: decrypt(config.access_token),
    };
  }

  /** Map a thrown Meta error to a 502 with its message. */
  private metaFail(err: unknown, res: Response): void {
    const message =
      err instanceof Error ? err.message : 'Meta Flows API request failed';
    this.logger.error(`Meta Flows API error: ${message}`);
    res.status(HttpStatus.BAD_GATEWAY).json({ error: message });
  }

  // -------------------------------------------------------------------------
  // Starter templates (no Meta call) — declared before `:id` so the literal
  // path wins over the param route.
  // -------------------------------------------------------------------------
  @Get('meta-flows/templates')
  templates(@Res() res: Response) {
    res.json({
      templates: META_FLOW_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        flowJson: JSON.stringify(t.flowJson, null, 2),
      })),
    });
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  @Get('meta-flows')
  async list(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const flows = await listFlows(meta);
      res.json({ flows });
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Details (+ current flow.json)
  // -------------------------------------------------------------------------
  @Get('meta-flows/:id')
  async details(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const flow = await getFlowDetails({
        flowId: id,
        accessToken: meta.accessToken,
      });
      // Best-effort: a brand-new flow may have no JSON yet.
      let flowJson: string | null = null;
      try {
        flowJson = await downloadFlowJson({
          flowId: id,
          accessToken: meta.accessToken,
        });
      } catch (err) {
        this.logger.warn(
          `Could not download flow.json for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      res.json({ flow, flowJson });
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Preview link
  // -------------------------------------------------------------------------
  @Get('meta-flows/:id/preview')
  async preview(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const preview = await getFlowPreview({
        flowId: id,
        accessToken: meta.accessToken,
      });
      res.json({ preview });
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Create (from raw JSON, a starter template, a clone, or empty)
  // -------------------------------------------------------------------------
  @Post('meta-flows')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: CreateMetaFlowDto,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;

    let flowJson = dto.flowJson;
    let categories = dto.categories;

    if (dto.templateId) {
      const template = getMetaFlowTemplate(dto.templateId);
      if (!template) {
        res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: `Unknown template "${dto.templateId}".` });
        return;
      }
      flowJson = JSON.stringify(template.flowJson);
      categories = categories?.length ? categories : [template.category];
    }

    if (!categories?.length) categories = ['OTHER'];

    try {
      const result = await createFlow({
        wabaId: meta.wabaId,
        accessToken: meta.accessToken,
        name: dto.name,
        categories,
        flowJson,
        cloneFlowId: dto.cloneFlowId,
        publish: dto.publish,
      });
      res.status(HttpStatus.CREATED).json({ flow: result });
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Update metadata (name / categories)
  // -------------------------------------------------------------------------
  @Patch('meta-flows/:id')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() dto: UpdateMetaFlowDto,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const result = await updateFlowMetadata({
        flowId: id,
        accessToken: meta.accessToken,
        name: dto.name,
        categories: dto.categories,
      });
      res.json(result);
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Update the Flow JSON (returns validation errors)
  // -------------------------------------------------------------------------
  @Post('meta-flows/:id/json')
  async updateJson(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() dto: UpdateMetaFlowJsonDto,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const result = await updateFlowJson({
        flowId: id,
        accessToken: meta.accessToken,
        flowJson: dto.flowJson,
      });
      res.json(result);
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------
  @Post('meta-flows/:id/publish')
  async publish(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const result = await publishFlow({
        flowId: id,
        accessToken: meta.accessToken,
      });
      res.json(result);
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Deprecate
  // -------------------------------------------------------------------------
  @Post('meta-flows/:id/deprecate')
  async deprecate(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const result = await deprecateFlow({
        flowId: id,
        accessToken: meta.accessToken,
      });
      res.json(result);
    } catch (err) {
      this.metaFail(err, res);
    }
  }

  // -------------------------------------------------------------------------
  // Delete (draft only, enforced by Meta)
  // -------------------------------------------------------------------------
  @Delete('meta-flows/:id')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const meta = await this.resolveMeta(account.accountId, res);
    if (!meta) return;
    try {
      const result = await deleteFlow({
        flowId: id,
        accessToken: meta.accessToken,
      });
      res.json(result);
    } catch (err) {
      this.metaFail(err, res);
    }
  }
}
