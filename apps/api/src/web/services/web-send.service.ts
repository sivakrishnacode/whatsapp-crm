import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { WebStreamService } from './web-stream.service';

export interface WebSendOutcome {
  /** The `messages.id` — on this channel it IS the platform id. */
  messageId: string;
  internalId: string;
}

/**
 * Outbound messages on the web channel.
 *
 * WHY THIS IS THE SIMPLEST OF THE THREE SENDERS
 *   The WhatsApp and Instagram senders spend most of their code on
 *   someone else's API: window checks, tags, retries, mapping our shapes
 *   onto Meta's, and reconciling the id Meta hands back. None of that
 *   exists here. Sending is: write the row, publish it to the visitor's
 *   stream. That is the whole operation.
 *
 * THERE IS NO SEPARATE PLATFORM MESSAGE ID
 *   `messages.message_id` on the other channels holds a wamid or a mid —
 *   an id minted by Meta that later webhooks refer to. Nothing external
 *   ever refers to a web message, so the row's own uuid is the id, and it
 *   is written into `message_id` too. That keeps
 *   `ChannelSendResult.messageId` meaningful for callers (the flow engine
 *   stores it to correlate replies) without inventing a second id space.
 *
 * THERE IS NO WINDOW, SO THERE IS NO GATE
 *   Every other sender begins by asking whether it is allowed to send.
 *   `CHANNEL_CAPABILITIES.web.replyWindowHours` is null: we own the
 *   transport, so the only reason a send fails is that the conversation
 *   does not exist. If the visitor's tab is closed the message is stored
 *   and shown to them next time they open the widget — which is a
 *   delivery delay, not a failure.
 */
@Injectable()
export class WebSendService {
  private readonly logger = new Logger(WebSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: WebStreamService,
  ) {}

  /**
   * Account-scoped, and channel-pinned.
   *
   * The channel filter is not decoration: `common/messaging/channel.ts`
   * warns that a contact can now own one thread per channel, so a lookup
   * that omits it can return the WhatsApp thread and this service would
   * then write a web message into it.
   */
  private async requireConversation(
    accountId: string,
    conversationId: string,
  ): Promise<string> {
    const conversation = await this.prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId, channel: 'web' },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException(
        `No web conversation ${conversationId} for this account.`,
      );
    }
    return conversation.id;
  }

  private async persistAndPush(args: {
    conversationId: string;
    senderType: 'agent' | 'ai' | 'system';
    senderId?: string | null;
    contentType: string;
    contentText: string | null;
    mediaUrl?: string | null;
    metadata?: Record<string, unknown>;
    /** Which AI agent wrote this, when one did (migration 084). */
    aiAgentId?: string | null;
  }): Promise<WebSendOutcome> {
    const row = await this.prisma.messages.create({
      data: {
        conversation_id: args.conversationId,
        sender_type: args.senderType,
        sender_id: args.senderId ?? null,
        content_type: args.contentType,
        content_text: args.contentText,
        media_url: args.mediaUrl ?? null,
        // 'sent' now; the stream promotes it to 'delivered' below. This is
        // the one channel where that promotion is a fact rather than a
        // report of someone else's opinion.
        status: 'sent',
        metadata: args.metadata as Prisma.InputJsonValue | undefined,
        ai_agent_id: args.aiAgentId ?? null,
      },
      select: {
        id: true,
        sender_type: true,
        content_type: true,
        content_text: true,
        media_url: true,
        interactive_reply_id: true,
        metadata: true,
        created_at: true,
      },
    });

    // The row's own id doubles as the platform id — see the class docs.
    await this.prisma.messages.update({
      where: { id: row.id },
      data: { message_id: row.id },
    });

    await this.prisma.conversations.update({
      where: { id: args.conversationId },
      data: {
        last_message_text: args.contentText || `[${args.contentType}]`,
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.stream.publish(args.conversationId, {
      type: 'message',
      message: {
        id: row.id,
        sender_type: row.sender_type as 'agent' | 'ai' | 'system',
        content_type: row.content_type,
        content_text: row.content_text,
        media_url: row.media_url,
        interactive_reply_id: row.interactive_reply_id,
        metadata: row.metadata as Record<string, unknown> | null,
        created_at: (row.created_at ?? new Date()).toISOString(),
      },
    });

    return { messageId: row.id, internalId: row.id };
  }

  async sendText(args: {
    accountId: string;
    conversationId: string;
    text: string;
    senderType?: 'agent' | 'ai' | 'system';
    senderId?: string | null;
    aiAgentId?: string | null;
  }): Promise<WebSendOutcome> {
    const conversationId = await this.requireConversation(
      args.accountId,
      args.conversationId,
    );
    return this.persistAndPush({
      conversationId,
      senderType: args.senderType ?? 'agent',
      senderId: args.senderId,
      contentType: 'text',
      contentText: args.text,
      aiAgentId: args.aiAgentId,
    });
  }

  async sendMedia(args: {
    accountId: string;
    conversationId: string;
    kind: 'image' | 'video' | 'audio' | 'document';
    link: string;
    caption?: string;
    filename?: string;
    senderType?: 'agent' | 'ai' | 'system';
    senderId?: string | null;
  }): Promise<WebSendOutcome> {
    const conversationId = await this.requireConversation(
      args.accountId,
      args.conversationId,
    );
    return this.persistAndPush({
      conversationId,
      senderType: args.senderType ?? 'agent',
      senderId: args.senderId,
      contentType: args.kind,
      // Unlike Instagram, a caption needs no second message: the widget
      // renders it under the attachment because we control the bubble.
      contentText: args.caption ?? null,
      mediaUrl: args.link,
      metadata: args.filename ? { filename: args.filename } : undefined,
    });
  }

  /**
   * Reply buttons. Native here — the widget renders real buttons that
   * echo `reply_id` back, so this is not an approximation of WhatsApp's
   * interactive buttons the way Instagram's quick replies are.
   *
   * The buttons live in `metadata` rather than a column: `messages` is a
   * shared table across three channels and this shape is specific to one,
   * which is exactly what migration 050 added `metadata` for.
   */
  async sendButtons(args: {
    accountId: string;
    conversationId: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    headerText?: string;
    footerText?: string;
    senderType?: 'agent' | 'ai' | 'system';
    senderId?: string | null;
  }): Promise<WebSendOutcome> {
    const conversationId = await this.requireConversation(
      args.accountId,
      args.conversationId,
    );
    return this.persistAndPush({
      conversationId,
      senderType: args.senderType ?? 'agent',
      senderId: args.senderId,
      contentType: 'buttons',
      contentText: args.bodyText,
      metadata: {
        buttons: args.buttons,
        ...(args.headerText ? { header_text: args.headerText } : {}),
        ...(args.footerText ? { footer_text: args.footerText } : {}),
      },
    });
  }

  /**
   * Single-select list. Also native — no row cap, because the constraint
   * on the other channels is Meta's UI, not the concept.
   */
  async sendList(args: {
    accountId: string;
    conversationId: string;
    bodyText: string;
    buttonLabel: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    headerText?: string;
    footerText?: string;
    senderType?: 'agent' | 'ai' | 'system';
    senderId?: string | null;
  }): Promise<WebSendOutcome> {
    const conversationId = await this.requireConversation(
      args.accountId,
      args.conversationId,
    );
    return this.persistAndPush({
      conversationId,
      senderType: args.senderType ?? 'agent',
      senderId: args.senderId,
      contentType: 'list',
      contentText: args.bodyText,
      metadata: {
        button_label: args.buttonLabel,
        sections: args.sections,
        ...(args.headerText ? { header_text: args.headerText } : {}),
        ...(args.footerText ? { footer_text: args.footerText } : {}),
      },
    });
  }

  /**
   * A form or booking card rendered inline in the chat.
   *
   * Exists so the `send_form` automation step can do something better on
   * this channel than paste a link — the visitor is already in a browser,
   * so making them open a new tab to answer two questions is a pointless
   * drop-off. On WhatsApp and Instagram the same step sends a link,
   * because there is no other option.
   */
  async sendCard(args: {
    accountId: string;
    conversationId: string;
    kind: 'form' | 'booking';
    targetId: string;
    text: string;
    url: string;
    senderType?: 'agent' | 'ai' | 'system';
    senderId?: string | null;
  }): Promise<WebSendOutcome> {
    const conversationId = await this.requireConversation(
      args.accountId,
      args.conversationId,
    );
    return this.persistAndPush({
      conversationId,
      senderType: args.senderType ?? 'agent',
      senderId: args.senderId,
      contentType: args.kind,
      contentText: args.text,
      metadata: { [`${args.kind}_id`]: args.targetId, url: args.url },
    });
  }

  /**
   * Promote a message to `delivered`.
   *
   * Called when the visitor's stream acknowledges receipt. Meaningful
   * here in a way it is not elsewhere: WhatsApp reports Meta's view of
   * delivery and Instagram never reports it at all, whereas this is our
   * own socket confirming it handed the frame over.
   */
  async markDelivered(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.prisma.messages.updateMany({
      where: { id: { in: messageIds }, status: 'sent' },
      data: { status: 'delivered' },
    });
  }
}
