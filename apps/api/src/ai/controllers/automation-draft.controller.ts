import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCreditsService } from '../credits/ai-credits.service';
import { assertCanSpendCredits } from '../credits/credits.constants';
import {
  buildAutomationDraftPrompt,
  normalizeDraftPrompt,
  parseAutomationDraft,
} from '../lib/automation-draft';
import { loadAiConfig } from '../lib/config';
import { generateReply } from '../lib/generate';
import { AiError } from '../lib/types';

function toHttp(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof AiError) {
    return new HttpException(
      { error: err.message, code: err.code },
      err.status >= 400 && err.status < 600
        ? err.status
        : HttpStatus.BAD_GATEWAY,
    );
  }
  return new HttpException(
    { error: 'The AI request failed.', code: 'ai_failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * "Describe it and I'll build it" for the automation editor.
 *
 * WHY IT IS ITS OWN CONTROLLER
 *   It shares the credential and metering path with `AiController` but
 *   nothing else: no conversation, no knowledge retrieval, no tools, no
 *   agent persona. Folding it in would have meant a fourth generate-now
 *   endpoint in a file that is already the credential surface plus two.
 *
 * ⚠️ IT WRITES NOTHING.
 *   The response is a draft the browser hands to the builder. Creating
 *   the automation is a separate, human-pressed `POST /automations`
 *   which runs the same validation every other author's save does. An
 *   endpoint that both generates and activates is one prompt away from
 *   messaging a customer list.
 *
 * ⚠️ `requireActive: false`.
 *   `ai_configs.is_active` is the AGENT switch — whether the bot answers
 *   customers. Building an automation is not the agent talking to
 *   anyone, so gating it on that switch would deny the feature to every
 *   workspace that has deliberately kept auto-reply off. The credit
 *   wallet is the gate that matters, and `assertCanSpendCredits` is it.
 */
@Controller('ai')
export class AutomationDraftController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
  ) {}

  /**
   * POST /api/ai/automation-draft
   * Body: `{ prompt: string }`. Agent+.
   */
  @Post('automation-draft')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('agent')
  async draft(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { prompt?: string },
  ) {
    let prompt: string;
    try {
      prompt = normalizeDraftPrompt(body?.prompt);
    } catch (err) {
      throw toHttp(err);
    }

    const config = await loadAiConfig(this.prisma, account.accountId, {
      requireActive: false,
    }).catch((err) => {
      throw toHttp(err);
    });

    if (!config) {
      throw new HttpException(
        {
          error:
            'AI is not available on this workspace. Add a provider key in AI Agents → Provider, or top up your credits.',
          code: 'ai_not_configured',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Before any work — an empty wallet with no key of their own to fall
    // back on. Same order as the inbox draft endpoint: do not build a
    // prompt for a call that cannot run.
    try {
      assertCanSpendCredits(config);
    } catch (err) {
      throw toHttp(err);
    }

    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    try {
      // No tools. The model has one job and every tool it could reach
      // reads customer data it does not need to design a workflow.
      ({ text, usage } = await generateReply({
        config,
        systemPrompt: buildAutomationDraftPrompt(),
        messages: [{ role: 'user', content: prompt }],
      }));
    } catch (err) {
      // Nothing is charged for a generation that never arrived.
      throw toHttp(err);
    }

    // Charged BEFORE parsing: the tokens were spent whatever the model
    // returned, and a parse failure is our problem to eat only in the
    // sense that we report it — it is not free for us either. Parsing
    // after also means an unparseable response still moves the wallet
    // the user sees, which is the honest number.
    const charged = await this.charge(config, {
      accountId: account.accountId,
      usage,
      userId: account.userId,
    });

    let draft: ReturnType<typeof parseAutomationDraft>;
    try {
      draft = parseAutomationDraft(text);
    } catch (err) {
      throw toHttp(err);
    }

    return { draft, ...charged };
  }

  /**
   * Meter the run and report the wallet back, so the header badge
   * updates without a second round trip. Returns nothing on a
   * bring-your-own-key run — the absence of the field is what tells the
   * UI not to render a credit cost for a call that did not have one.
   */
  private async charge(
    config: { source: string; provider: string; model: string },
    args: {
      accountId: string;
      usage: { inputTokens: number; outputTokens: number };
      userId?: string;
    },
  ): Promise<{ credits_used?: number; credits_remaining?: number }> {
    if (config.source !== 'platform') return {};

    const used = await this.credits.chargeGeneration({
      accountId: args.accountId,
      // Its own ledger feature, not 'draft' — that one means "suggest a
      // reply in this conversation" and carries a conversation_id.
      // Migration 083 widened the CHECK for this value.
      feature: 'automation_draft',
      provider: config.provider,
      model: config.model,
      usage: args.usage,
      conversationId: null,
      userId: args.userId ?? null,
    });
    const wallet = await this.credits.getWallet(args.accountId);
    return { credits_used: used, credits_remaining: wallet.balance };
  }
}
