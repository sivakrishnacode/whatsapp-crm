import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowMetaSendService } from '../../whatsapp/flow-meta-send.service';
import { loadAiConfig } from '../lib/config';
import { buildConversationContext } from '../lib/context';
import { retrieveKnowledge } from '../lib/knowledge';
import { buildSystemPrompt } from '../lib/defaults';
import { generateReply } from '../lib/generate';
import { latestUserMessage } from '../lib/query';

interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
}

@Injectable()
export class AiReplyService {
  private readonly logger = new Logger(AiReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => FlowMetaSendService))
    private readonly flowMetaSendService: FlowMetaSendService,
  ) {}

  /**
   * AI auto-reply logic for an inbound message.
   * Invoked asynchronously (non-blocking) from the webhook handler.
   */
  async dispatchInboundToAiReply(args: DispatchArgs): Promise<void> {
    const { accountId, conversationId, contactId, configOwnerUserId } = args;

    try {
      // 1. Load active AI configuration
      const config = await loadAiConfig(this.prisma, accountId);
      if (!config || !config.autoReplyEnabled) return;

      // 2. Gate: If there are active keyword_match or new_message_received automations, skip.
      const activeAutomations = await this.prisma.automation.findFirst({
        where: {
          accountId,
          isActive: true,
          triggerType: {
            in: ['new_message_received', 'keyword_match'],
          },
        },
        select: { id: true },
      });
      if (activeAutomations) return;

      // 3. Gate: Load conversation state
      const conv = await this.prisma.conversations.findUnique({
        where: { id: conversationId },
        select: {
          assigned_agent_id: true,
          ai_autoreply_disabled: true,
          ai_reply_count: true,
        },
      });
      if (!conv) return;
      if (conv.assigned_agent_id) return; // human owns the thread
      if (conv.ai_autoreply_disabled) return; // bot turned off
      if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

      // 4. Build message transcript context
      const messages = await buildConversationContext(this.prisma, conversationId);
      if (messages.length === 0) return;

      // 5. Retrieve grounding knowledge from the KB (hybrid search)
      const knowledge = await retrieveKnowledge(
        this.prisma,
        accountId,
        config,
        latestUserMessage(messages),
      );

      // 6. Build prompts & generate LLM completion
      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      });

      const { text, handoff } = await generateReply({
        config,
        systemPrompt,
        messages,
      });

      // 7. Handle handoff sentinel protocol
      if (handoff || !text) {
        await this.prisma.conversations.update({
          where: { id: conversationId },
          data: { ai_autoreply_disabled: true },
        });
        return;
      }

      // 8. Atomically claim reply slot to prevent concurrency race
      const claimResult = await this.prisma.$queryRawUnsafe<{ claim_ai_reply_slot: boolean }[]>(
        'SELECT claim_ai_reply_slot($1::uuid, $2::integer) as claim_ai_reply_slot',
        conversationId,
        config.autoReplyMaxPerConversation,
      );
      const claimed = claimResult?.[0]?.claim_ai_reply_slot === true;
      if (!claimed) return; // Lost the slot claim race

      // 9. Send the message via Flows engine
      await this.flowMetaSendService.sendText({
        accountId,
        conversationId,
        contactId,
        text,
      });
    } catch (err) {
      this.logger.error(`[ai auto-reply] dispatch failed: ${err}`);
    }
  }
}
