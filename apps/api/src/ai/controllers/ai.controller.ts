import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  HttpStatus,
  HttpException,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AiReplyService } from '../services/ai-reply.service';
import { AgentRuntimeService } from '../services/agent-runtime.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';
import { AiCreditsService } from '../credits/ai-credits.service';
import {
  assertCanSpendCredits,
  isPlatformAiAvailable,
} from '../credits/credits.constants';
import { encrypt, decrypt } from '../../common/security/encryption.util';
import { validateAiCredentials } from '../lib/validate';
import { EMBEDDING_MODEL, embedTexts } from '../lib/embeddings';
import { loadAiConfig } from '../lib/config';
import { buildConversationContext, withDraftNudge } from '../lib/context';
import { generateReply } from '../lib/generate';
import {
  AiError,
  type AiProvider,
  type ChatMessage,
  type EmbeddingsProvider,
} from '../lib/types';

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini'];
const EMBEDDINGS_PROVIDERS: EmbeddingsProvider[] = ['openai', 'gemini'];

function isProvider(value: unknown): value is AiProvider {
  return PROVIDERS.includes(value as AiProvider);
}

function isEmbeddingsProvider(value: unknown): value is EmbeddingsProvider {
  return EMBEDDINGS_PROVIDERS.includes(value as EmbeddingsProvider);
}

/**
 * Turn an AiError into the response the client can act on, preserving
 * both its status and its `code`.
 *
 * The code matters more than the message here: `ai_credits_exhausted`
 * is what makes the web app open the top-up sheet instead of showing
 * another red toast the user cannot do anything about.
 */
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
 * Provider credentials, the inbox draft button, and the test playground.
 *
 * The agent's *behaviour* (profile, tone, skills, escalation) lives on
 * `/ai/agent`, and its knowledge on `/ai/knowledge` — see those
 * controllers. What stays here is the credential surface plus the two
 * generate-now endpoints.
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiReplyService: AiReplyService,
    private readonly runtime: AgentRuntimeService,
    private readonly knowledge: KnowledgeSourceService,
    private readonly credits: AiCreditsService,
  ) {}

  /**
   * GET /api/ai/config
   * Provider config with the keys stripped.
   */
  @Get('config')
  @UseGuards(SupabaseAuthGuard)
  async getConfig(@CurrentAccount() account: SupabaseAccountContext) {
    try {
      const data = await this.prisma.ai_configs.findUnique({
        where: { account_id: account.accountId },
        select: {
          provider: true,
          model: true,
          system_prompt: true,
          is_active: true,
          auto_reply_enabled: true,
          auto_reply_max_per_conversation: true,
          api_key: true,
          embeddings_api_key: true,
          embeddings_provider: true,
          embeddings_model: true,
        },
      });

      if (!data) return { configured: false, providers: PROVIDERS };

      const { api_key, embeddings_api_key, ...safe } = data;
      return {
        configured: true,
        has_key: !!api_key,
        has_embeddings_key: !!embeddings_api_key,
        providers: PROVIDERS,
        ...safe,
      };
    } catch {
      throw new HttpException(
        'Failed to load AI configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/ai/config
   * Save the provider, model and key(s). Admin+.
   */
  @Post('config')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async saveConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: Record<string, unknown>,
  ) {
    if (!body || typeof body !== 'object') {
      throw new HttpException('Invalid request body', HttpStatus.BAD_REQUEST);
    }

    const provider = body.provider;
    if (!isProvider(provider)) {
      throw new HttpException(
        `provider must be one of: ${PROVIDERS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw new HttpException('model is required', HttpStatus.BAD_REQUEST);
    }

    // Behaviour fields are PATCH semantics: absent means "leave alone".
    // This endpoint is the Provider tab, which does not render them — if
    // absent meant `false`, saving a new key would silently switch the
    // agent off and blank the legacy prompt.
    const behaviour: Record<string, unknown> = {};
    if (typeof body.is_active === 'boolean')
      behaviour.is_active = body.is_active;
    if (typeof body.auto_reply_enabled === 'boolean') {
      behaviour.auto_reply_enabled = body.auto_reply_enabled;
    }
    if ('system_prompt' in body) {
      behaviour.system_prompt =
        typeof body.system_prompt === 'string' && body.system_prompt.trim()
          ? body.system_prompt.trim()
          : null;
    }
    if (body.auto_reply_max_per_conversation !== undefined) {
      const maxPer = Number(body.auto_reply_max_per_conversation);
      behaviour.auto_reply_max_per_conversation = Number.isFinite(maxPer)
        ? Math.min(20, Math.max(1, Math.floor(maxPer)))
        : 3;
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';

    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : '';
    const clearEmbeddingsKey = body.embeddings_api_key === null;

    const existing = await this.prisma.ai_configs.findUnique({
      where: { account_id: account.accountId },
      select: {
        id: true,
        provider: true,
        model: true,
        api_key: true,
        embeddings_provider: true,
        embeddings_model: true,
        embeddings_api_key: true,
      },
    });

    let apiKeyPlain: string;
    if (rawKey) {
      apiKeyPlain = rawKey;
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key);
      } catch {
        throw new HttpException(
          'Stored API key could not be decrypted — re-enter your key.',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      throw new HttpException('api_key is required', HttpStatus.BAD_REQUEST);
    }

    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model;

    if (credentialsChanged) {
      try {
        await validateAiCredentials({ provider, model, apiKey: apiKeyPlain });
      } catch (err) {
        if (err instanceof AiError) {
          throw new HttpException(
            { error: err.message, code: err.code },
            HttpStatus.BAD_REQUEST,
          );
        }
        throw new HttpException(
          'Could not validate the API key with the provider.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // The embeddings provider defaults to whatever the chat provider is,
    // when that provider can embed — an account on Gemini should not have
    // to go and find an OpenAI key to get semantic search.
    const requestedEmbeddingsProvider = isEmbeddingsProvider(
      body.embeddings_provider,
    )
      ? body.embeddings_provider
      : isEmbeddingsProvider(provider)
        ? provider
        : ((existing?.embeddings_provider as EmbeddingsProvider | null) ??
          'openai');

    const embeddingsModel = EMBEDDING_MODEL[requestedEmbeddingsProvider];

    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'], {
          provider: requestedEmbeddingsProvider,
          model: embeddingsModel,
        });
      } catch (err) {
        if (err instanceof AiError) {
          throw new HttpException(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            HttpStatus.BAD_REQUEST,
          );
        }
        throw new HttpException(
          'Could not validate the embeddings key.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null;
    const shared: Record<string, unknown> = {
      provider,
      model,
      ...behaviour,
    };

    const hasEmbeddingsKeyAfterSave =
      Boolean(rawEmbeddingsKey) ||
      (!clearEmbeddingsKey && Boolean(existing?.embeddings_api_key));

    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey);
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null;
    }

    if (hasEmbeddingsKeyAfterSave) {
      shared.embeddings_provider = requestedEmbeddingsProvider;
      shared.embeddings_model = embeddingsModel;
    } else if (clearEmbeddingsKey) {
      shared.embeddings_provider = null;
      shared.embeddings_model = null;
    }

    // Switching embedding model invalidates every stored vector: they are
    // not comparable across models, so retrieval filters them out. Mark
    // the corpus stale so the user is told to reindex instead of watching
    // a healthy-looking knowledge base answer nothing.
    const embeddingModelChanged =
      hasEmbeddingsKeyAfterSave &&
      Boolean(existing?.embeddings_model) &&
      existing?.embeddings_model !== embeddingsModel;

    if (existing) {
      await this.prisma.ai_configs.update({
        where: { account_id: account.accountId },
        data: encryptedKey ? { ...shared, api_key: encryptedKey } : shared,
      });
    } else {
      await this.prisma.ai_configs.create({
        data: {
          // A first save means someone just connected a provider, so the
          // master switch goes on (the inbox's "Draft with AI" becomes
          // usable) while automatic replying stays off until they ask for
          // it on the Behaviour tab. Explicit values in the body win.
          is_active: true,
          auto_reply_enabled: false,
          ...shared,
          account_id: account.accountId,
          created_by: account.userId,
          api_key: encryptedKey!,
          provider,
          model,
        },
      });
    }

    let staleDocuments = 0;
    if (embeddingModelChanged) {
      staleDocuments = await this.knowledge.markCorpusStale(account.accountId);
    }

    return {
      success: true,
      ...(staleDocuments > 0
        ? {
            warning: `The embeddings model changed, so ${staleDocuments} knowledge document(s) need reindexing before semantic search works again.`,
            stale_documents: staleDocuments,
          }
        : {}),
    };
  }

  /**
   * DELETE /api/ai/config
   */
  @Delete('config')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async deleteConfig(@CurrentAccount() account: SupabaseAccountContext) {
    try {
      await this.prisma.ai_configs.delete({
        where: { account_id: account.accountId },
      });
      return { success: true };
    } catch {
      throw new HttpException(
        'Failed to delete AI configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/ai/test
   * Prove a key works without saving it.
   */
  @Post('test')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async testConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: Record<string, unknown>,
  ) {
    if (!body || typeof body !== 'object') {
      throw new HttpException('Invalid request body', HttpStatus.BAD_REQUEST);
    }

    const provider = body.provider;
    if (!isProvider(provider)) {
      throw new HttpException(
        `provider must be one of: ${PROVIDERS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw new HttpException('model is required', HttpStatus.BAD_REQUEST);
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    let apiKeyPlain = rawKey;
    if (!apiKeyPlain) {
      const existing = await this.prisma.ai_configs.findUnique({
        where: { account_id: account.accountId },
        select: { api_key: true },
      });
      if (!existing?.api_key) {
        throw new HttpException(
          'Enter an API key to test.',
          HttpStatus.BAD_REQUEST,
        );
      }
      try {
        apiKeyPlain = decrypt(existing.api_key);
      } catch {
        throw new HttpException(
          'Stored API key could not be decrypted — re-enter your key.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      await validateAiCredentials({ provider, model, apiKey: apiKeyPlain });
    } catch (err) {
      if (err instanceof AiError) {
        throw new HttpException(
          { error: err.message, code: err.code },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        'Could not validate the API key.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return { ok: true };
  }

  /**
   * POST /api/ai/draft
   * Suggest a reply for a conversation in the inbox. Agent+.
   */
  @Post('draft')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('agent')
  async suggestDraft(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { conversation_id?: string },
  ) {
    const conversationId = body?.conversation_id;
    if (!conversationId) {
      throw new HttpException(
        'conversation_id is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const conversation = await this.prisma.conversations.findFirst({
      where: { id: conversationId, account_id: account.accountId },
      select: { id: true, contact_id: true },
    });
    if (!conversation) {
      throw new HttpException('Conversation not found', HttpStatus.NOT_FOUND);
    }

    // `loadAiConfig` now raises a typed AiError for an undecryptable key
    // rather than returning null, so the blanket catch that used to
    // report every failure as "key could not be decrypted" is gone —
    // it was hiding real errors behind a wrong diagnosis.
    const config = await loadAiConfig(this.prisma, account.accountId).catch(
      (err) => {
        throw toHttp(err);
      },
    );

    if (!config) {
      throw new HttpException(
        {
          error:
            'AI assistant is not set up. Enable it in AI Agents → Provider & key.',
          code: 'ai_not_configured',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Before any work: an empty wallet with no key of their own to fall
    // back on. Checked here rather than after generation so we do not
    // retrieve knowledge and build a prompt for a call that cannot run.
    try {
      assertCanSpendCredits(config);
    } catch (err) {
      throw toHttp(err);
    }

    const messages = await buildConversationContext(
      this.prisma,
      conversationId,
    );
    if (messages.length === 0) {
      throw new HttpException(
        { error: 'No messages to draft from yet.', code: 'no_messages' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const run = await this.runtime.assemble({
      config,
      messages,
      ctx: {
        accountId: account.accountId,
        contactId: conversation.contact_id,
        actorUserId: account.userId,
        mode: 'draft',
      },
    });

    // `assemble` above got the real transcript, so knowledge was retrieved
    // for what the customer actually asked. Only generation gets the
    // nudged copy — see `withDraftNudge`.
    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    try {
      ({ text, usage } = await generateReply({
        config,
        systemPrompt: run.systemPrompt,
        messages: withDraftNudge(messages),
        tools: run.tools,
        executeTool: run.executeTool,
      }));
    } catch (err) {
      // A provider failure here is the user's own key talking to their own
      // provider: their message is the useful one, and letting it escape as
      // an unhandled 500 costs them the only diagnosis available.
      //
      // Nothing is charged: a draft that never arrived is not a draft
      // they should pay for, and the rounds we did spend are ours.
      throw toHttp(err);
    }

    const charged = await this.charge(config, {
      accountId: account.accountId,
      feature: 'draft',
      usage,
      conversationId,
      userId: account.userId,
    });

    return {
      draft: text,
      grounded_on: run.knowledge.map((hit) => hit.title).filter(Boolean),
      ...charged,
    };
  }

  /**
   * Meter a completed run and report the wallet back to the client, so
   * the header badge updates without a second round trip.
   *
   * Returns nothing at all on a bring-your-own-key run — the absence of
   * the field is what tells the UI not to render a credit cost for a
   * call that did not have one.
   */
  private async charge(
    config: { source: string; provider: string; model: string },
    args: {
      accountId: string;
      feature: 'draft' | 'playground';
      usage: { inputTokens: number; outputTokens: number };
      conversationId?: string;
      userId?: string;
    },
  ): Promise<{ credits_used?: number; credits_remaining?: number }> {
    if (config.source !== 'platform') return {};

    const used = await this.credits.chargeGeneration({
      accountId: args.accountId,
      feature: args.feature,
      provider: config.provider,
      model: config.model,
      usage: args.usage,
      conversationId: args.conversationId ?? null,
      userId: args.userId ?? null,
    });
    const wallet = await this.credits.getWallet(args.accountId);
    return { credits_used: used, credits_remaining: wallet.balance };
  }

  /**
   * POST /api/ai/playground
   * Talk to the agent as a customer would. Agent+.
   *
   * Runs the SAME assembly as the auto-reply bot (`AgentRuntimeService`),
   * and additionally returns what grounded the answer and which tools ran
   * — a test surface that cannot show its working is not a test surface.
   *
   * `contactId` is null here, so contact-scoped tools report honestly that
   * there is no customer attached rather than reading someone else's data.
   */
  @Post('playground')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('agent')
  async playgroundChat(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { messages?: ChatMessage[]; mode?: string },
  ) {
    const rawMessages = body?.messages;
    if (!Array.isArray(rawMessages)) {
      throw new HttpException('messages is required', HttpStatus.BAD_REQUEST);
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0,
      )
      // Only role + content survive: a client must not be able to inject a
      // fabricated tool result into the transcript.
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-20);

    if (messages.length === 0) {
      throw new HttpException(
        'Send a message to test the agent.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const config = await loadAiConfig(this.prisma, account.accountId, {
      requireActive: false,
    }).catch((err) => {
      throw toHttp(err);
    });

    if (!config) {
      throw new HttpException(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // The playground spends credits exactly like production does. It is
    // the same assembly and the same provider call, so an unmetered one
    // would be an open inference endpoint with a login page in front of
    // it — and it would teach users a cost model the real agent does not
    // honour, which is the same argument that keeps the assembly shared.
    try {
      assertCanSpendCredits(config);
    } catch (err) {
      throw toHttp(err);
    }

    const run = await this.runtime.assemble({
      config,
      messages,
      ctx: {
        accountId: account.accountId,
        contactId: null,
        actorUserId: account.userId,
        mode: body?.mode === 'draft' ? 'draft' : 'auto_reply',
      },
    });

    let text: string;
    let handoff: boolean;
    let toolTrace: Awaited<ReturnType<typeof generateReply>>['toolTrace'];
    let usage: { inputTokens: number; outputTokens: number };
    try {
      ({ text, handoff, toolTrace, usage } = await generateReply({
        config,
        systemPrompt: run.systemPrompt,
        messages,
        tools: run.tools,
        executeTool: run.executeTool,
      }));
    } catch (err) {
      throw toHttp(err);
    }

    const charged = await this.charge(config, {
      accountId: account.accountId,
      feature: 'playground',
      usage,
      userId: account.userId,
    });

    return {
      reply: text,
      handoff,
      grounded_on: run.knowledge.map((hit) => ({
        document_id: hit.documentId,
        title: hit.title ?? null,
        excerpt: hit.content.slice(0, 240),
      })),
      tools_available: run.tools.map((t) => t.name),
      tool_calls: toolTrace,
      // The test panel is where someone learns what the agent costs, so
      // it says so per message rather than only in a billing screen.
      ...charged,
    };
  }

  /**
   * POST /api/ai/internal/ai-reply
   * Asynchronous reply bridge (secret auth, no user context needed).
   */
  @Post('internal/ai-reply')
  async internalAiReply(
    @Headers('x-internal-secret') secret: string,
    @Body()
    body: {
      accountId?: string;
      conversationId?: string;
      contactId?: string;
      configOwnerUserId?: string;
    },
  ) {
    if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { accountId, conversationId, contactId, configOwnerUserId } = body;
    if (!accountId || !conversationId || !contactId || !configOwnerUserId) {
      throw new HttpException(
        'Missing required fields',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Process completely asynchronously, letting the webhook return 200
    // immediately.
    void this.aiReplyService.dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
    });

    return { ok: true };
  }
}
