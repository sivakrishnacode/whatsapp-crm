import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { AiReplyService } from '../../ai/services/ai-reply.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { WebStreamService } from './web-stream.service';

export interface InboundWebMessage {
  accountId: string;
  ownerUserId: string;
  conversationId: string;
  contactId: string;
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document';
  text: string;
  mediaUrl?: string | null;
  /** Set when the visitor tapped a button or list row rather than typing. */
  interactiveReplyId?: string | null;
  pageUrl?: string | null;
}

export interface InboundWebResult {
  messageId: string;
  createdAt: string;
}

/**
 * Everything that happens when a visitor sends a message.
 *
 * WHY THIS MIRRORS instagram-webhook.service's fanOut SO CLOSELY
 *   The order of operations there is load-bearing and was arrived at by
 *   fixing real bugs: flows get first refusal because a flow is an
 *   explicit script the author wants honoured, automations run on what
 *   the flow did not consume, and AI only speaks when neither did —
 *   otherwise a customer gets two or three replies to one message.
 *   Re-deriving that order here would eventually get it wrong, so it is
 *   deliberately the same sequence with the channel swapped.
 *
 * THE INBOUND WRITE IS NOT IDEMPOTENT, AND DOES NOT NEED TO BE
 *   The Instagram and WhatsApp paths dedupe on Meta's message id, because
 *   Meta redelivers webhooks. Nothing redelivers here — the visitor's
 *   browser makes one HTTP request and gets one response. A retry after a
 *   network failure is a genuine second send, which is what a user
 *   pressing enter twice means.
 */
@Injectable()
export class WebInboundService {
  private readonly logger = new Logger(WebInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowDispatch: FlowDispatchService,
    private readonly automationDispatch: AutomationDispatchService,
    private readonly aiReply: AiReplyService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly stream: WebStreamService,
  ) {}

  async handle(input: InboundWebMessage): Promise<InboundWebResult> {
    // Channel-pinned and account-scoped. The visitor's token names a
    // conversation, and a token outlives the row it points at, so this is
    // also what turns a stale session into a clean 404 instead of a
    // foreign-key error.
    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: input.conversationId,
        account_id: input.accountId,
        channel: 'web',
      },
      select: { id: true, contact_id: true, last_inbound_at: true },
    });
    if (!conversation) {
      throw new NotFoundException('This chat session is no longer available.');
    }

    const isFirstInbound = conversation.last_inbound_at === null;

    const message = await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: input.contentType,
        content_text: input.text || null,
        media_url: input.mediaUrl ?? null,
        interactive_reply_id: input.interactiveReplyId ?? null,
        status: 'received',
        metadata: input.pageUrl
          ? ({ page_url: input.pageUrl } as Prisma.InputJsonValue)
          : undefined,
      },
      select: { id: true, created_at: true },
    });
    // The row's own id is the platform id on this channel — see
    // web-send.service for why there is no second id space.
    await this.prisma.messages.update({
      where: { id: message.id },
      data: { message_id: message.id },
    });

    await this.prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        last_message_text: input.text || `[${input.contentType}]`,
        last_message_at: new Date(),
        // Maintained even though web has no messaging window: the inbox
        // sorts and reports on it, and leaving it null would make every
        // web thread look like it had never had a customer message.
        last_inbound_at: new Date(),
        unread_count: { increment: 1 },
        updated_at: new Date(),
      },
    });

    // Echoed to the visitor's own stream so a second open tab, or the
    // same visitor on another device, sees what they just sent.
    await this.stream.publish(conversation.id, {
      type: 'message',
      message: {
        id: message.id,
        sender_type: 'customer',
        content_type: input.contentType,
        content_text: input.text || null,
        media_url: input.mediaUrl ?? null,
        interactive_reply_id: input.interactiveReplyId ?? null,
        metadata: null,
        created_at: (message.created_at ?? new Date()).toISOString(),
      },
    });

    // Deliberately not awaited: the visitor's HTTP response should not
    // wait on an LLM call or a webhook round trip. Their message is
    // already persisted, and every reply arrives over the stream.
    void this.fanOut(
      { ...input, conversationId: conversation.id },
      {
        messageId: message.id,
        isFirstInbound,
      },
    );

    return {
      messageId: message.id,
      createdAt: (message.created_at ?? new Date()).toISOString(),
    };
  }

  /**
   * ⚠️ FLOWS ARE WHATSAPP-ONLY — see the same note in the Instagram
   * webhook. The website widget runs on automations, which are
   * channel-aware and degrade per step rather than failing the whole
   * run. Nothing here is awaited (every dispatch is fire-and-forget),
   * which is why this is no longer `async`.
   */
  private fanOut(
    input: InboundWebMessage,
    meta: { messageId: string; isFirstInbound: boolean },
  ): void {
    const triggers: Array<
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
      | 'web_chat_started'
    > = [];
    triggers.push('new_message_received', 'keyword_match');
    if (meta.isFirstInbound) {
      // `web_chat_started` is not a duplicate of `first_inbound_message`:
      // the latter fires on all three channels, so a rule that should only
      // greet website visitors would otherwise also greet every new
      // WhatsApp contact.
      triggers.unshift('first_inbound_message', 'web_chat_started');
    }

    for (const triggerType of triggers) {
      this.automationDispatch
        .enqueue({
          accountId: input.accountId,
          triggerType,
          contactId: input.contactId,
          context: {
            message_text: input.text,
            conversation_id: input.conversationId,
            channel: 'web',
            ...(input.pageUrl ? { page_url: input.pageUrl } : {}),
          },
        })
        .catch((err) =>
          this.logger.error(
            `[automations] web dispatch failed for ${triggerType}: ${String(err)}`,
          ),
        );
    }

    // Same guard as Instagram minus the flow half: AI never answers a
    // button tap (an automation owns those) or an empty body.
    if (!input.interactiveReplyId && input.text.trim()) {
      void this.aiReply.dispatchInboundToAiReply({
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        configOwnerUserId: input.ownerUserId,
      });
    }

    void this.webhookDeliver.dispatchWebhookEvent(
      input.accountId,
      'message.received',
      {
        channel: 'web',
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        message_id: meta.messageId,
        content_type: input.contentType,
        text: input.text || null,
      },
    );
  }

  /**
   * The visitor read the thread. Clears the inbox's unread badge.
   *
   * Whole-conversation rather than per-message: the widget shows one
   * thread and reading it means reading all of it, so tracking individual
   * message reads would be state nothing consumes.
   */
  async markRead(accountId: string, conversationId: string): Promise<void> {
    await this.prisma.conversations.updateMany({
      where: { id: conversationId, account_id: accountId, channel: 'web' },
      data: { unread_count: 0 },
    });
  }
}
