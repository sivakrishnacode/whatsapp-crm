import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateFunnelDto,
  ListRunsQueryDto,
  ToggleFunnelsDto,
  UpdateFunnelDto,
} from '../dto/funnel.dto';

/**
 * Comment → DM funnel management.
 *
 * TWO SWITCHES, AND WHY
 *   `PATCH /instagram/funnels/enabled` is the account master switch;
 *   each funnel additionally has its own `is_active`. A feature that
 *   DMs strangers on the business's behalf needs a single lever that
 *   stops everything — during a Meta review, an incident, or a change
 *   of heart — without the merchant having to remember which of nine
 *   funnels were on, so they can be restored afterwards.
 *
 *   Both default to off. Creating a funnel does not arm it.
 */
@Controller('instagram/funnels')
@UseGuards(SupabaseAuthGuard)
export class InstagramFunnelsController {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------
  // Master switch
  // ------------------------------------------------------------

  @Get('enabled')
  async getEnabled(@CurrentAccount() account: SupabaseAccountContext) {
    const config = await this.prisma.instagram_config.findUnique({
      where: { account_id: account.accountId },
      select: { comment_funnels_enabled: true, ig_username: true },
    });
    return {
      // No Instagram connection means the feature cannot run, which
      // reads the same as "off" to the UI — and avoids a null the
      // toggle would have to special-case.
      enabled: config?.comment_funnels_enabled ?? false,
      connected: config != null,
      // Returned here rather than from a second request: the automation
      // editor previews the reply under the business's own handle, and
      // "your_account" in a proof-reading view defeats the point of it.
      username: config?.ig_username ?? null,
    };
  }

  @Patch('enabled')
  async setEnabled(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: ToggleFunnelsDto,
  ) {
    const { count } = await this.prisma.instagram_config.updateMany({
      where: { account_id: account.accountId },
      data: { comment_funnels_enabled: body.enabled, updated_at: new Date() },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Connect Instagram before turning comment funnels on.',
      );
    }
    return { enabled: body.enabled };
  }

  // ------------------------------------------------------------
  // Funnels
  // ------------------------------------------------------------

  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    const funnels = await this.prisma.instagram_comment_funnels.findMany({
      where: { account_id: account.accountId },
      orderBy: { updated_at: 'desc' },
    });
    return { funnels };
  }

  @Get(':id')
  async getOne(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    const funnel = await this.requireFunnel(account.accountId, id);
    return { funnel };
  }

  @Post()
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: CreateFunnelDto,
  ) {
    this.assertGateAnswerable(body.follow_gate_enabled, body.follow_ask_text);

    const funnel = await this.prisma.instagram_comment_funnels.create({
      data: {
        account_id: account.accountId,
        user_id: account.userId,
        name: body.name,
        ig_media_id: body.ig_media_id || null,
        keywords: normaliseKeywords(body.keywords),
        optin_text: body.optin_text,
        ...(body.optin_button_label
          ? { optin_button_label: body.optin_button_label }
          : {}),
        ...(body.follow_gate_enabled !== undefined
          ? { follow_gate_enabled: body.follow_gate_enabled }
          : {}),
        follow_ask_text: body.follow_ask_text || null,
        ...(body.follow_button_label
          ? { follow_button_label: body.follow_button_label }
          : {}),
        reward_text: body.reward_text,
        reward_buttons: (body.reward_buttons ??
          []) as unknown as Prisma.InputJsonValue,
        public_reply_texts: normaliseReplyVariants(body.public_reply_texts),
        ...(body.reply_delay_seconds !== undefined
          ? { reply_delay_seconds: body.reply_delay_seconds }
          : {}),
        is_active: body.is_active ?? false,
      },
    });

    return { funnel };
  }

  @Patch(':id')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: UpdateFunnelDto,
  ) {
    const existing = await this.requireFunnel(account.accountId, id);

    // A PATCH may flip the gate on without resending the question, or
    // blank the question without touching the gate. Either way the
    // resulting row is what has to be answerable, not the request.
    this.assertGateAnswerable(
      body.follow_gate_enabled ?? existing.follow_gate_enabled,
      body.follow_ask_text !== undefined
        ? body.follow_ask_text
        : existing.follow_ask_text,
    );

    const funnel = await this.prisma.instagram_comment_funnels.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.ig_media_id !== undefined
          ? { ig_media_id: body.ig_media_id || null }
          : {}),
        ...(body.keywords !== undefined
          ? { keywords: normaliseKeywords(body.keywords) }
          : {}),
        ...(body.optin_text !== undefined
          ? { optin_text: body.optin_text }
          : {}),
        ...(body.optin_button_label !== undefined
          ? { optin_button_label: body.optin_button_label }
          : {}),
        ...(body.follow_gate_enabled !== undefined
          ? { follow_gate_enabled: body.follow_gate_enabled }
          : {}),
        ...(body.follow_ask_text !== undefined
          ? { follow_ask_text: body.follow_ask_text || null }
          : {}),
        ...(body.follow_button_label !== undefined
          ? { follow_button_label: body.follow_button_label }
          : {}),
        ...(body.reward_text !== undefined
          ? { reward_text: body.reward_text }
          : {}),
        ...(body.reward_buttons !== undefined
          ? {
              reward_buttons:
                body.reward_buttons as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(body.public_reply_texts !== undefined
          ? {
              public_reply_texts: normaliseReplyVariants(
                body.public_reply_texts,
              ),
            }
          : {}),
        ...(body.reply_delay_seconds !== undefined
          ? { reply_delay_seconds: body.reply_delay_seconds }
          : {}),
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
        updated_at: new Date(),
      },
    });

    return { funnel };
  }

  @Delete(':id')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    const existing = await this.requireFunnel(account.accountId, id);
    await this.prisma.instagram_comment_funnels.delete({
      where: { id: existing.id },
    });
    return { success: true };
  }

  // ------------------------------------------------------------
  // Runs — what actually happened
  // ------------------------------------------------------------

  /**
   * Per-funnel counts plus the most recent runs.
   *
   * `failed` is surfaced deliberately rather than hidden: the funnel
   * runs unattended against someone else's API, and a merchant whose
   * private replies started failing has no other way to find out.
   */
  @Get(':id/runs')
  async runs(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Query() query: ListRunsQueryDto,
  ) {
    const funnel = await this.requireFunnel(account.accountId, id);

    const grouped = await this.prisma.instagram_comment_funnel_runs.groupBy({
      by: ['state'],
      where: { funnel_id: funnel.id, account_id: account.accountId },
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      awaiting_optin: 0,
      awaiting_follow: 0,
      delivered: 0,
      failed: 0,
    };
    for (const row of grouped) counts[row.state] = row._count._all;

    const runs = await this.prisma.instagram_comment_funnel_runs.findMany({
      where: {
        funnel_id: funnel.id,
        account_id: account.accountId,
        ...(query.state ? { state: query.state } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: {
        contacts: { select: { id: true, name: true, ig_username: true } },
      },
    });

    return { counts, runs };
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  /**
   * Load by id, re-scoped to the caller's account.
   *
   * `findFirst` with an explicit account_id rather than `findUnique` on
   * the id alone: the id comes from the URL, and a bare lookup would
   * hand one tenant another tenant's funnel.
   */
  private async requireFunnel(accountId: string, id: string) {
    const funnel = await this.prisma.instagram_comment_funnels.findFirst({
      where: { id, account_id: accountId },
    });
    if (!funnel) throw new NotFoundException('Funnel not found.');
    return funnel;
  }

  private assertGateAnswerable(
    gateEnabled: boolean | undefined,
    askText: string | null | undefined,
  ): void {
    // Mirrors instagram_comment_funnels_gate_chk. Checked here too so
    // the merchant gets a sentence instead of a Postgres constraint name.
    if (gateEnabled !== false && !askText?.trim()) {
      throw new BadRequestException(
        'Add the message that asks people to follow, or turn the follow gate off.',
      );
    }
  }
}

/**
 * Trim, drop blanks, de-duplicate exactly.
 *
 * Blanks are dropped rather than rejected because the editor lets a
 * merchant add an empty variant row and then change their mind — losing
 * the whole save to a row they had already abandoned is a bad trade.
 * De-duplication is case-SENSITIVE, unlike keywords: "Check your DMs"
 * and "check your dms" are two legitimately different-looking replies,
 * and variety is the entire point of the list.
 */
function normaliseReplyVariants(variants: string[] | undefined): string[] {
  if (!variants) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of variants) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Trim, drop blanks, de-duplicate case-insensitively. */
function normaliseKeywords(keywords: string[] | undefined): string[] {
  if (!keywords) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
