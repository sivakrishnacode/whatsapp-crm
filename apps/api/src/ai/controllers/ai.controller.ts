import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AiReplyService } from '../services/ai-reply.service';
import { encrypt, decrypt } from '../../common/security/encryption.util';
import { validateAiCredentials } from '../lib/validate';
import { embedTexts } from '../lib/embeddings';
import { loadAiConfig, loadEmbeddingsKey } from '../lib/config';
import { buildConversationContext } from '../lib/context';
import { retrieveKnowledge, ingestDocument } from '../lib/knowledge';
import { buildSystemPrompt } from '../lib/defaults';
import { generateReply } from '../lib/generate';
import { latestUserMessage } from '../lib/query';
import { AiError, ChatMessage } from '../lib/types';

@Controller('ai')
export class AiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiReplyService: AiReplyService,
  ) {}

  private async verifyAdmin(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { accountRole: true },
    });

    if (
      !profile ||
      (profile.accountRole !== 'admin' && profile.accountRole !== 'owner')
    ) {
      throw new HttpException('Insufficient permissions', HttpStatus.FORBIDDEN);
    }
  }

  private async verifyAgent(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { accountRole: true },
    });

    if (
      !profile ||
      (profile.accountRole !== 'admin' &&
        profile.accountRole !== 'owner' &&
        profile.accountRole !== 'agent')
    ) {
      throw new HttpException('Insufficient permissions', HttpStatus.FORBIDDEN);
    }
  }

  /**
   * GET /api/ai/config
   * Fetch AI provider config (keys stripped for security).
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
        },
      });

      if (!data) return { configured: false };

      const { api_key, embeddings_api_key, ...safe } = data;
      return {
        configured: true,
        has_key: !!api_key,
        has_embeddings_key: !!embeddings_api_key,
        ...safe,
      };
    } catch (err) {
      throw new HttpException(
        'Failed to load AI configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/ai/config
   * Save AI provider config (admin+ only).
   */
  @Post('config')
  @UseGuards(SupabaseAuthGuard)
  async saveConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
  ) {
    await this.verifyAdmin(account.userId);

    if (!body || typeof body !== 'object') {
      throw new HttpException('Invalid request body', HttpStatus.BAD_REQUEST);
    }

    const provider = body.provider;
    if (provider !== 'openai' && provider !== 'anthropic') {
      throw new HttpException('provider must be "openai" or "anthropic"', HttpStatus.BAD_REQUEST);
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw new HttpException('model is required', HttpStatus.BAD_REQUEST);
    }

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null;
    const isActive = body.is_active === true;
    const autoReplyEnabled = body.auto_reply_enabled === true;

    let maxPer = Number(body.auto_reply_max_per_conversation);
    if (!Number.isFinite(maxPer)) maxPer = 3;
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)));

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';

    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : '';
    const clearEmbeddingsKey = body.embeddings_api_key === null;

    const existing = await this.prisma.ai_configs.findUnique({
      where: { account_id: account.accountId },
      select: { id: true, provider: true, model: true, api_key: true },
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
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          embeddingsApiKey: null,
        });
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

    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping']);
      } catch (err) {
        if (err instanceof AiError) {
          throw new HttpException(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            HttpStatus.BAD_REQUEST,
          );
        }
        throw new HttpException('Could not validate the embeddings key.', HttpStatus.BAD_REQUEST);
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null;
    const shared: any = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    };
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey);
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null;
    }

    if (existing) {
      await this.prisma.ai_configs.update({
        where: { account_id: account.accountId },
        data: encryptedKey ? { ...shared, api_key: encryptedKey } : shared,
      });
    } else {
      await this.prisma.ai_configs.create({
        data: {
          account_id: account.accountId,
          created_by: account.userId,
          api_key: encryptedKey!,
          ...shared,
        },
      });
    }

    return { success: true };
  }

  /**
   * DELETE /api/ai/config
   * Delete AI provider config (admin+ only).
   */
  @Delete('config')
  @UseGuards(SupabaseAuthGuard)
  async deleteConfig(@CurrentAccount() account: SupabaseAccountContext) {
    await this.verifyAdmin(account.userId);
    try {
      await this.prisma.ai_configs.delete({
        where: { account_id: account.accountId },
      });
      return { success: true };
    } catch (err) {
      throw new HttpException(
        'Failed to delete AI configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/ai/test
   * Test API key connectivity without saving (admin+ only).
   */
  @Post('test')
  @UseGuards(SupabaseAuthGuard)
  async testConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
  ) {
    await this.verifyAdmin(account.userId);

    if (!body || typeof body !== 'object') {
      throw new HttpException('Invalid request body', HttpStatus.BAD_REQUEST);
    }

    const provider = body.provider;
    if (provider !== 'openai' && provider !== 'anthropic') {
      throw new HttpException('provider must be "openai" or "anthropic"', HttpStatus.BAD_REQUEST);
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
        throw new HttpException('Enter an API key to test.', HttpStatus.BAD_REQUEST);
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
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        embeddingsApiKey: null,
      });
    } catch (err) {
      if (err instanceof AiError) {
        throw new HttpException(
          { error: err.message, code: err.code },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException('Could not validate the API key.', HttpStatus.BAD_REQUEST);
    }

    return { ok: true };
  }

  /**
   * POST /api/ai/draft
   * Suggest reply draft (agent+).
   */
  @Post('draft')
  @UseGuards(SupabaseAuthGuard)
  async suggestDraft(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { conversation_id?: string },
  ) {
    await this.verifyAgent(account.userId);

    const conversationId = body?.conversation_id;
    if (!conversationId) {
      throw new HttpException('conversation_id is required', HttpStatus.BAD_REQUEST);
    }

    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        account_id: account.accountId,
      },
      select: { id: true },
    });
    if (!conversation) {
      throw new HttpException('Conversation not found', HttpStatus.NOT_FOUND);
    }

    const config = await loadAiConfig(this.prisma, account.accountId).catch((err) => {
      throw new HttpException(
        { error: 'Stored API key could not be decrypted.', code: 'key_decrypt_failed' },
        HttpStatus.BAD_REQUEST,
      );
    });

    if (!config) {
      throw new HttpException(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const messages = await buildConversationContext(this.prisma, conversationId);
    if (messages.length === 0) {
      throw new HttpException(
        { error: 'No messages to draft from yet.', code: 'no_messages' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const knowledge = await retrieveKnowledge(
      this.prisma,
      account.accountId,
      config,
      latestUserMessage(messages),
    );

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
    });

    const { text } = await generateReply({ config, systemPrompt, messages });
    return { draft: text };
  }

  /**
   * POST /api/ai/playground
   * Chat interface for playground testing (agent+).
   */
  @Post('playground')
  @UseGuards(SupabaseAuthGuard)
  async playgroundChat(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { messages?: ChatMessage[] },
  ) {
    await this.verifyAgent(account.userId);

    const rawMessages = body?.messages;
    if (!Array.isArray(rawMessages)) {
      throw new HttpException('messages is required', HttpStatus.BAD_REQUEST);
    }

    const messages = rawMessages
      .filter(
        (m: any): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0,
      )
      .slice(-20);

    if (messages.length === 0) {
      throw new HttpException('Send a message to test the agent.', HttpStatus.BAD_REQUEST);
    }

    const config = await loadAiConfig(this.prisma, account.accountId, {
      requireActive: false,
    }).catch((err) => {
      throw new HttpException(
        { error: 'Stored API key could not be decrypted.', code: 'key_decrypt_failed' },
        HttpStatus.BAD_REQUEST,
      );
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

    const knowledge = await retrieveKnowledge(
      this.prisma,
      account.accountId,
      config,
      latestUserMessage(messages),
    );

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    });

    const { text, handoff } = await generateReply({ config, systemPrompt, messages });
    return { reply: text, handoff };
  }

  /**
   * GET /api/ai/knowledge
   * List all knowledge base documents (member).
   */
  @Get('knowledge')
  @UseGuards(SupabaseAuthGuard)
  async getKnowledgeBase(@CurrentAccount() account: SupabaseAccountContext) {
    try {
      const documents = await this.prisma.ai_knowledge_documents.findMany({
        where: { account_id: account.accountId },
        select: { id: true, title: true, updated_at: true },
        orderBy: { updated_at: 'desc' },
      });
      return { documents };
    } catch (err) {
      throw new HttpException('Failed to load knowledge base', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * POST /api/ai/knowledge
   * Add new knowledge base document (admin+ only).
   */
  @Post('knowledge')
  @UseGuards(SupabaseAuthGuard)
  async createDocument(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { title?: string; content?: string },
  ) {
    await this.verifyAdmin(account.userId);

    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!title || !content) {
      throw new HttpException('title and content are required', HttpStatus.BAD_REQUEST);
    }

    const doc = await this.prisma.ai_knowledge_documents.create({
      data: {
        account_id: account.accountId,
        created_by: account.userId,
        title,
        content,
      },
      select: { id: true },
    });

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      this.prisma,
      account.accountId,
    );

    try {
      await ingestDocument(
        this.prisma,
        account.accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      );
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed';
      return {
        success: true,
        id: doc.id,
        warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
      };
    }

    if (corrupt) {
      return {
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      };
    }

    return { success: true, id: doc.id };
  }

  /**
   * GET /api/ai/knowledge/:id
   * Get single knowledge base document (member).
   */
  @Get('knowledge/:id')
  @UseGuards(SupabaseAuthGuard)
  async getDocument(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    const document = await this.prisma.ai_knowledge_documents.findFirst({
      where: {
        id,
        account_id: account.accountId,
      },
      select: { id: true, title: true, content: true, updated_at: true },
    });

    if (!document) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    return document;
  }

  /**
   * PATCH /api/ai/knowledge/:id
   * Update knowledge base document (admin+ only).
   */
  @Patch('knowledge/:id')
  @UseGuards(SupabaseAuthGuard)
  async updateDocument(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: { title?: string; content?: string },
  ) {
    await this.verifyAdmin(account.userId);

    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined;

    if (title === undefined && content === undefined) {
      throw new HttpException('Nothing to update', HttpStatus.BAD_REQUEST);
    }
    if (title !== undefined && !title) {
      throw new HttpException('title cannot be empty', HttpStatus.BAD_REQUEST);
    }
    if (content !== undefined && !content) {
      throw new HttpException('content cannot be empty', HttpStatus.BAD_REQUEST);
    }

    const update: any = {};
    if (title !== undefined) update.title = title;
    if (content !== undefined) update.content = content;

    const existing = await this.prisma.ai_knowledge_documents.findFirst({
      where: {
        id,
        account_id: account.accountId,
      },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    await this.prisma.ai_knowledge_documents.update({
      where: { id },
      data: update,
    });

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        this.prisma,
        account.accountId,
      );
      try {
        await ingestDocument(this.prisma, account.accountId, { embeddingsApiKey }, id, content);
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed';
        return {
          success: true,
          warning: `Updated, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        };
      }
      if (corrupt) {
        return {
          success: true,
          warning:
            'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        };
      }
    }

    return { success: true };
  }

  /**
   * DELETE /api/ai/knowledge/:id
   * Delete knowledge base document (admin+ only).
   */
  @Delete('knowledge/:id')
  @UseGuards(SupabaseAuthGuard)
  async deleteDocument(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    await this.verifyAdmin(account.userId);

    const existing = await this.prisma.ai_knowledge_documents.findFirst({
      where: {
        id,
        account_id: account.accountId,
      },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    try {
      await this.prisma.ai_knowledge_documents.delete({
        where: { id },
      });
      return { success: true };
    } catch (err) {
      throw new HttpException('Failed to delete document', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * POST /api/ai/knowledge/reindex
   * Reindex all knowledge base documents (admin+ only).
   */
  @Post('knowledge/reindex')
  @UseGuards(SupabaseAuthGuard)
  async reindexKnowledgeBase(@CurrentAccount() account: SupabaseAccountContext) {
    await this.verifyAdmin(account.userId);

    const docs = await this.prisma.ai_knowledge_documents.findMany({
      where: { account_id: account.accountId },
      select: { id: true, content: true },
    });

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      this.prisma,
      account.accountId,
    );

    if (corrupt) {
      return {
        success: false,
        reindexed: 0,
        error:
          'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings → AI Assistant). Nothing was reindexed.',
      };
    }

    let reindexed = 0;
    for (const doc of docs) {
      try {
        await ingestDocument(
          this.prisma,
          account.accountId,
          { embeddingsApiKey },
          doc.id,
          doc.content,
        );
        reindexed += 1;
      } catch (err) {
        const message = err instanceof AiError ? err.message : String(err);
        return {
          success: false,
          reindexed,
          total: docs.length,
          error: `Reindexed ${reindexed}, then hit an error: ${message}`,
        };
      }
    }

    return { success: true, reindexed };
  }

  /**
   * POST /api/internal/ai-reply
   * Asynchronous reply bridge (secret auth, no user context needed).
   */
  @Post('internal/ai-reply')
  async internalAiReply(
    @Headers('x-internal-secret') secret: string,
    @Body() body: any,
  ) {
    if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { accountId, conversationId, contactId, configOwnerUserId } = body;
    if (!accountId || !conversationId || !contactId || !configOwnerUserId) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }

    // Process completely asynchronously, letting webhook return 200 immediately
    void this.aiReplyService.dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
    });

    return { ok: true };
  }
}
