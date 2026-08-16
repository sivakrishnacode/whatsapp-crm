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
  buildFlowDraftPrompt,
  normalizeFlowPrompt,
  parseFlowDraft,
} from '../lib/flow-draft';
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
 * "Describe it and I'll build it" for the flow editor.
 *
 * The sibling of `AutomationDraftController`, and deliberately a copy of
 * its shape rather than a shared base: the two share a credential path
 * and nothing else, and the parts that look identical (credit check,
 * charge, error mapping) are each four lines. A base class would couple
 * two features whose prompts and parsers have nothing in common.
 *
 * ⚠️ IT WRITES NOTHING.
 *   The response is a draft the browser hands to the builder. Creating
 *   the flow is a separate, human-pressed save which runs the same
 *   validation every other author's save does. An endpoint that both
 *   generated and activated would be one prompt away from a bot that
 *   answers every customer.
 *
 * ⚠️ `requireActive: false`.
 *   `ai_configs.is_active` is the AGENT switch — whether the bot answers
 *   customers. Designing a flow is not the agent talking to anyone, so
 *   gating on it would deny the feature to every workspace that has
 *   deliberately kept auto-reply off. The wallet is the gate that
 *   matters, and `assertCanSpendCredits` is it.
 */
@Controller('ai')
export class FlowDraftController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
  ) {}

  /**
   * POST /api/ai/flow-draft
   * Body: `{ prompt: string }`. Agent+.
   */
  @Post('flow-draft')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('agent')
  async draft(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { prompt?: string },
  ) {
    let prompt: string;
    try {
      prompt = normalizeFlowPrompt(body?.prompt);
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
    // back on. Do not build a prompt for a call that cannot run.
    try {
      assertCanSpendCredits(config);
    } catch (err) {
      throw toHttp(err);
    }

    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    try {
      // No tools. The model has one job, and every tool it could reach
      // reads customer data it does not need to design a chatbot.
      ({ text, usage } = await generateReply({
        config,
        systemPrompt: buildFlowDraftPrompt(),
        messages: [{ role: 'user', content: prompt }],
      }));
    } catch (err) {
      // Nothing is charged for a generation that never arrived.
      throw toHttp(err);
    }

    // Charged BEFORE parsing: the tokens were spent whatever came back,
    // and an unparseable response still moves the wallet the user sees,
    // which is the honest number.
    const charged = await this.charge(config, {
      accountId: account.accountId,
      usage,
      userId: account.userId,
    });

    let draft: ReturnType<typeof parseFlowDraft>;
    try {
      draft = parseFlowDraft(text);
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
      // Its own ledger feature — migration 088 widened the CHECK. Not
      // 'automation_draft': these are two spending surfaces and the
      // ledger is the only record that can ever separate them.
      feature: 'flow_draft',
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
