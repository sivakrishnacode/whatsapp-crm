import {
  Controller,
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
import { Prisma } from '@prisma/client';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  submitMessageTemplate,
  editMessageTemplate,
  deleteMessageTemplate,
} from '../meta-api.util';
import { decrypt } from '../../common/security/encryption.util';
import {
  resolveParameterFormat,
  validateTemplatePayload,
  type TemplatePayload,
} from '../../v1/utils/template-validators.util';
import { buildMetaTemplatePayload } from '../../v1/utils/template-components.util';
import { resolveTemplateMediaHandles } from '../template-media-handle.util';
import {
  normalizeCategory,
  normalizeQualityScore,
  parseTemplateButtons,
  extractTemplateSampleValues,
  normalizeTemplateStatus,
  normalizeParameterFormat,
  parseCarouselCards,
  parseHeaderType,
  type MetaTemplateComponent,
} from '../../v1/utils/template-sync.util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
  quality_score?: { score?: string } | string;
  parameter_format?: string;
}

interface MetaPageBody {
  data?: MetaTemplate[];
  paging?: { next?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const PAGE_CAP = 20;

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

/** Convert null → Prisma.DbNull, undefined → unchanged, values → passthrough. */
function toJsonValue(
  v: Prisma.InputJsonValue | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  return v === null || v === undefined ? Prisma.DbNull : v;
}

/**
 * The editable half of a template row — everything the submit payload
 * can set. Shared by both branches of the submit upsert and by the edit
 * route so the local row always reflects what was last sent to Meta;
 * writing it on `create` only would leave a resubmitted template
 * showing its previous revision.
 *
 * `name` and `language` are deliberately absent: they form the unique
 * key and Meta treats them as immutable once a template exists.
 */
function templateContentFields(body: TemplatePayload) {
  return {
    category: body.category,
    header_type: body.header_type ?? null,
    header_content: body.header_content ?? null,
    header_media_url: body.header_media_url ?? null,
    header_handle: body.header_handle ?? null,
    body_text: body.body_text,
    footer_text: body.footer_text ?? null,
    buttons: toJsonValue(body.buttons as Prisma.InputJsonValue | null),
    sample_values: toJsonValue(
      body.sample_values as Prisma.InputJsonValue | null,
    ),
    parameter_format: resolveParameterFormat(body.parameter_format),
    cards: toJsonValue(
      (body.cards?.length ? body.cards : null) as Prisma.InputJsonValue | null,
    ),
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappTemplatesController {
  private readonly logger = new Logger(WhatsappTemplatesController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/whatsapp/templates/sync
   *
   * Paginated pull of all templates from Meta, then mirrors that set locally:
   * upserts every template Meta returned, and deletes local rows that came
   * from Meta (meta_template_id set) but are no longer there. Purely-local
   * drafts that were never pushed to Meta (meta_template_id = null) are kept.
   */
  @Post('templates/sync')
  async sync(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
    });

    if (!config) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
      });
    }

    if (!config.waba_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
      });
    }

    // access_token is guaranteed non-null here: config exists and has a
    // waba_id, so the row was written by saveWhatsAppConnection which always
    // sets access_token.
    const accessToken = decrypt(config.access_token ?? '');

    const metaTemplates: MetaTemplate[] = [];
    let nextUrl: string | null =
      `${META_API_BASE}/${config.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score,parameter_format`;
    let pageCount = 0;

    while (nextUrl && pageCount < PAGE_CAP) {
      pageCount++;
      const metaRes = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!metaRes.ok) {
        let metaErr = `Meta API error: ${metaRes.status}`;
        try {
          const errBody = (await metaRes.json()) as {
            error?: { message?: string };
          };
          if (errBody?.error?.message) metaErr = errBody.error.message;
        } catch {
          // keep fallback message
        }
        return res.status(502).json({ error: metaErr });
      }

      const metaBody = (await metaRes.json()) as MetaPageBody;
      if (metaBody.data) metaTemplates.push(...metaBody.data);
      nextUrl = metaBody.paging?.next ?? null;
    }

    let inserted = 0;
    let updated = 0;
    const errors: { name: string; language: string; message: string }[] = [];

    for (const t of metaTemplates) {
      const bodyComp = (t.components ?? []).find((c) => c.type === 'BODY');
      const headerComp = (t.components ?? []).find((c) => c.type === 'HEADER');
      const footerComp = (t.components ?? []).find((c) => c.type === 'FOOTER');
      const buttonsComp = (t.components ?? []).find(
        (c) => c.type === 'BUTTONS',
      );

      const carouselComp = (t.components ?? []).find(
        (c) => c.type === 'CAROUSEL',
      );

      const parsedButtons = parseTemplateButtons(buttonsComp?.buttons);
      const sampleValues = extractTemplateSampleValues(bodyComp, headerComp);
      const headerType = parseHeaderType(headerComp);
      const cards = parseCarouselCards(carouselComp);

      const rowData = {
        account_id: account.accountId,
        user_id: account.userId,
        name: t.name,
        category: normalizeCategory(t.category),
        language: t.language,
        header_type: headerType,
        header_content: headerComp?.text ?? null,
        header_handle: headerComp?.example?.header_handle?.[0] ?? null,
        body_text: bodyComp?.text ?? '',
        footer_text: footerComp?.text ?? null,
        buttons: toJsonValue(
          parsedButtons.length
            ? (parsedButtons as Prisma.InputJsonValue)
            : null,
        ),
        sample_values: toJsonValue(
          sampleValues as Prisma.InputJsonValue | null,
        ),
        parameter_format: normalizeParameterFormat(t.parameter_format),
        cards: toJsonValue(
          cards.length ? (cards as Prisma.InputJsonValue) : null,
        ),
        status: normalizeTemplateStatus(t.status),
        meta_template_id: t.id,
        quality_score: normalizeQualityScore(t.quality_score),
        updated_at: new Date(),
      };

      try {
        const existing = await this.prisma.message_templates.findFirst({
          where: {
            account_id: account.accountId,
            name: t.name,
            language: t.language,
          },
          select: { id: true },
        });

        if (existing) {
          await this.prisma.message_templates.update({
            where: { id: existing.id },
            data: rowData,
          });
          updated++;
        } else {
          await this.prisma.message_templates.create({ data: rowData });
          inserted++;
        }
      } catch (err) {
        errors.push({
          name: t.name,
          language: t.language,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Reconcile: mirror Meta by removing local templates that originated from
    // Meta (they carry a meta_template_id) but are no longer in the pull —
    // deleted in Meta, or left behind after switching to a different WABA.
    // These are already gone from Meta, so no Meta delete call is needed; we
    // only drop the stale local row. Purely-local drafts (meta_template_id =
    // null, never pushed to Meta) are preserved. Skipped on a truncated pull:
    // without the full Meta list we'd wrongly delete templates that do exist
    // but weren't fetched this run.
    const truncated = pageCount >= PAGE_CAP && nextUrl !== null;
    let deleted = 0;
    if (!truncated) {
      const liveMetaIds = metaTemplates
        .map((t) => t.id)
        .filter((id): id is string => Boolean(id));
      const removal = await this.prisma.message_templates.deleteMany({
        where: {
          account_id: account.accountId,
          meta_template_id: { not: null, notIn: liveMetaIds },
        },
      });
      deleted = removal.count;
    }

    return res.status(HttpStatus.OK).json({
      success: errors.length === 0,
      total: metaTemplates.length,
      inserted,
      updated,
      deleted,
      errors,
      truncated,
    });
  }

  /**
   * POST /api/whatsapp/templates/submit
   *
   * Submit a new template draft to Meta for review and persist locally.
   */
  @Post('templates/submit')
  async submit(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: TemplatePayload,
    @Res() res: Response,
  ) {
    if (body.category === 'Authentication') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
      });
    }

    try {
      validateTemplatePayload(body);
    } catch (e) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: e instanceof Error ? e.message : 'Validation failed.' });
    }

    let metaTemplateId: string;
    let metaStatus: string;
    // The payload actually sent to Meta — same as `body` plus any media
    // handles minted during submit. Persisted so a later edit or send
    // reuses the handle instead of re-uploading the same file.
    let resolved: TemplatePayload = body;

    if (isDryRun()) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`;
      metaStatus = 'PENDING';
    } else {
      const config = await this.prisma.whatsapp_config.findUnique({
        where: { account_id: account.accountId },
      });

      if (!config) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        });
      }
      if (!config.waba_id) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        });
      }

      const accessToken = decrypt(config.access_token ?? '');

      try {
        // Media samples have to reach Meta as Resumable-Upload handles;
        // a public URL is rejected. This uploads the bytes and fills in
        // header_handle (template header + every carousel card).
        resolved = await resolveTemplateMediaHandles(body, accessToken);
        const metaPayload = buildMetaTemplatePayload(resolved);
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        });
        metaTemplateId = meta.id;
        metaStatus = meta.status;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.';
        this.logger.warn(`Template submit failed for ${body.name}: ${message}`);
        // Persist the failure as DRAFT so the user can see and retry
        await this.prisma.message_templates.upsert({
          where: {
            user_id_name_language: {
              user_id: account.userId,
              name: body.name,
              language: body.language,
            },
          },
          create: {
            account_id: account.accountId,
            user_id: account.userId,
            name: body.name,
            language: body.language,
            ...templateContentFields(body),
            status: 'DRAFT',
            meta_template_id: null,
            submission_error: message,
            last_submitted_at: new Date(),
          },
          update: {
            ...templateContentFields(body),
            status: 'DRAFT',
            submission_error: message,
            last_submitted_at: new Date(),
          },
        });

        const isRateLimit = /\b429\b/.test(message);
        return res.status(isRateLimit ? 429 : 502).json({
          error: isRateLimit
            ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
            : message,
        });
      }
    }

    const row = await this.prisma.message_templates.upsert({
      where: {
        user_id_name_language: {
          user_id: account.userId,
          name: body.name,
          language: body.language,
        },
      },
      create: {
        account_id: account.accountId,
        user_id: account.userId,
        name: body.name,
        language: body.language,
        ...templateContentFields(resolved),
        status: normalizeTemplateStatus(metaStatus),
        meta_template_id: metaTemplateId,
        submission_error: null,
        last_submitted_at: new Date(),
      },
      update: {
        ...templateContentFields(resolved),
        status: normalizeTemplateStatus(metaStatus),
        meta_template_id: metaTemplateId,
        submission_error: null,
        last_submitted_at: new Date(),
      },
    });

    return res
      .status(HttpStatus.OK)
      .json({ success: true, template: row, dry_run: isDryRun() });
  }

  /**
   * PATCH /api/whatsapp/templates/:id
   *
   * Edit an existing template. Only APPROVED, REJECTED, PAUSED statuses allowed.
   */
  @Patch('templates/:id')
  async editTemplate(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: TemplatePayload,
    @Res() res: Response,
  ) {
    if (!UUID_RE.test(id)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid template id.' });
    }

    const existing = await this.prisma.message_templates.findFirst({
      where: { id, account_id: account.accountId },
      select: { id: true, name: true, status: true, meta_template_id: true },
    });

    if (!existing) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Template not found.' });
    }

    if (!existing.meta_template_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'This template was never submitted to Meta — use New Template to submit it instead.',
      });
    }

    if (!EDITABLE_STATUSES.has(existing.status ?? '')) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: `Templates in status ${existing.status ?? 'unknown'} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
      });
    }

    if (body.category === 'Authentication') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
      });
    }

    try {
      validateTemplatePayload(body);
    } catch (e) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: e instanceof Error ? e.message : 'Validation failed.' });
    }

    let resolved: TemplatePayload = body;

    if (!isDryRun()) {
      const config = await this.prisma.whatsapp_config.findUnique({
        where: { account_id: account.accountId },
      });

      if (!config) {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'WhatsApp not configured.' });
      }

      const accessToken = decrypt(config.access_token ?? '');

      try {
        // Same handle requirement as submit. A caller that re-sends the
        // stored header_handle unchanged skips the re-upload.
        resolved = await resolveTemplateMediaHandles(body, accessToken);
        const metaPayload = buildMetaTemplatePayload(resolved);
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed.';
        this.logger.warn(
          `Template edit failed for ${existing.name}: ${message}`,
        );
        await this.prisma.message_templates.update({
          where: { id },
          data: { submission_error: message, last_submitted_at: new Date() },
        });
        return res.status(502).json({ error: message });
      }
    }

    const row = await this.prisma.message_templates.update({
      where: { id },
      data: {
        ...templateContentFields(resolved),
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date(),
      },
    });

    return res
      .status(HttpStatus.OK)
      .json({ success: true, template: row, dry_run: isDryRun() });
  }

  /**
   * DELETE /api/whatsapp/templates/:id
   *
   * Deletes a template on Meta (if it has a meta_template_id) then locally.
   */
  @Delete('templates/:id')
  async deleteTemplate(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    if (!UUID_RE.test(id)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid template id.' });
    }

    const existing = await this.prisma.message_templates.findFirst({
      where: { id, account_id: account.accountId },
      select: { id: true, name: true, meta_template_id: true },
    });

    if (!existing) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Template not found.' });
    }

    if (existing.meta_template_id && !isDryRun()) {
      const config = await this.prisma.whatsapp_config.findUnique({
        where: { account_id: account.accountId },
      });

      if (!config?.waba_id) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error: 'WhatsApp not configured — cannot delete on Meta.',
        });
      }

      const accessToken = decrypt(config.access_token ?? '');
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta delete failed.';
        return res.status(502).json({ error: message });
      }
    }

    await this.prisma.message_templates.delete({ where: { id } });

    return res
      .status(HttpStatus.OK)
      .json({ success: true, dry_run: isDryRun() });
  }
}
