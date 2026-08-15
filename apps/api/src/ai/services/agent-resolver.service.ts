import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ============================================================
 * Which agent owns this conversation?
 *
 * ⚠️ STICKINESS FIRST, ALWAYS.
 *
 * `conversations.ai_agent_id` is set on the first AI reply and consulted
 * before anything else afterwards. Without it, routing is re-evaluated
 * per MESSAGE, so reordering the list — or scoping an agent to a channel
 * halfway through a Tuesday — changes who the customer is talking to
 * mid-sentence. They get a different name, a different tone and no
 * memory of the promise the previous agent made two messages ago.
 *
 * A sticky agent that has since been switched off or deleted releases
 * the thread rather than silencing it: the latch is a preference, not a
 * lock. Deleting an agent nulls the column by foreign key, so that case
 * arrives here as "no sticky agent" without any cleanup job.
 * ============================================================
 */
@Injectable()
export class AgentResolverService {
  private readonly logger = new Logger(AgentResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The agent id to answer this conversation with, or null when no
   * active agent covers its channel.
   *
   * Returning null is a legitimate outcome, not an error: a workspace
   * whose only agent is scoped to Instagram genuinely has nobody to
   * answer a WhatsApp thread, and the thread stays for a human.
   */
  async resolveForConversation(args: {
    accountId: string;
    conversationId: string;
  }): Promise<{ agentId: string; sticky: boolean } | null> {
    const { accountId, conversationId } = args;

    const conversation = await this.prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
      select: { channel: true, ai_agent_id: true },
    });
    if (!conversation) return null;

    if (conversation.ai_agent_id) {
      const sticky = await this.prisma.ai_agents.findFirst({
        where: {
          id: conversation.ai_agent_id,
          account_id: accountId,
          is_active: true,
        },
        select: { id: true },
      });
      if (sticky) return { agentId: sticky.id, sticky: true };
      // Switched off since it last answered. Fall through and re-route,
      // rather than leaving the thread permanently mute.
    }

    const candidate = await this.prisma.ai_agents.findFirst({
      where: {
        account_id: accountId,
        is_active: true,
        // Empty `channels` means "any channel" — every agent migrated
        // from ai_configs carries an empty array and must keep
        // answering everybody (migration 084).
        OR: [
          { channels: { isEmpty: true } },
          { channels: { has: conversation.channel } },
        ],
      },
      orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
      select: { id: true },
    });

    if (!candidate) return null;
    return { agentId: candidate.id, sticky: false };
  }

  /**
   * Latch the thread to the agent that is about to answer it.
   *
   * Best-effort: the reply matters more than the attribution, and a
   * failed write here costs a statistic, not a customer's answer.
   */
  async attach(args: {
    conversationId: string;
    agentId: string;
  }): Promise<void> {
    try {
      await this.prisma.conversations.update({
        where: { id: args.conversationId },
        data: { ai_agent_id: args.agentId },
      });
    } catch (err) {
      this.logger.warn(
        `[agent routing] could not attach agent ${args.agentId} to conversation ${args.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
