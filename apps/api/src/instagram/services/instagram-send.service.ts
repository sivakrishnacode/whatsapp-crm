import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramConnectService } from './instagram-connect.service';
import { evaluateSendWindow, type IgSendDecision } from '../ig-window.util';
import {
  sendTextMessage,
  sendMediaMessage,
  sendQuickReplies,
  sendButtonTemplate,
  sendGenericTemplate,
  sendReaction,
  removeReaction,
  uploadAttachment,
  IG_REACTIONS,
  type IgMediaType,
  type IgQuickReply,
  type IgButton,
  type IgGenericElement,
  type IgReaction,
} from '../ig-api.util';

/**
 * Raised when the 24h/7d window forbids a send. Distinct from a Meta
 * API failure: nothing was attempted, the reason is known, and it is
 * safe (and useful) to show verbatim to an agent.
 */
export class InstagramWindowClosedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'InstagramWindowClosedError';
  }
}

export class InstagramNotConnectedError extends Error {
  constructor(message = 'Instagram is not connected for this account.') {
    super(message);
    this.name = 'InstagramNotConnectedError';
  }
}

interface ResolvedTarget {
  igUserId: string;
  accessToken: string;
  recipientIgsid: string;
  conversationId: string;
  decision: Extract<IgSendDecision, { allowed: true }>;
}

export interface IgSendOutcome {
  messageId: string;
  /** The persisted messages.id. */
  internalId: string;
}

/**
 * Outbound Instagram messaging.
 *
 * EVERY SEND GOES THROUGH `resolveTarget`
 *   which does three things in a fixed order, all of which matter:
 *     1. loads the conversation and proves it belongs to the account
 *        (tenant isolation — conversationId arrives from a request),
 *     2. loads a usable, non-expired token,
 *     3. evaluates the messaging window and refuses locally rather
 *        than letting Meta refuse it.
 *
 *   Step 3 is not just ergonomics. Repeatedly attempting out-of-window
 *   sends is exactly the pattern Meta restricts apps for.
 */
@Injectable()
export class InstagramSendService {
  private readonly logger = new Logger(InstagramSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connect: InstagramConnectService,
  ) {}

  // ------------------------------------------------------------

  private async resolveTarget(
    accountId: string,
    conversationId: string,
  ): Promise<ResolvedTarget> {
    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        account_id: accountId,
        channel: 'instagram',
      },
      include: { contacts: { select: { ig_scoped_id: true } } },
    });

    if (!conversation) {
      throw new InstagramNotConnectedError(
        'Instagram conversation not found for this account.',
      );
    }

    const recipientIgsid = conversation.contacts?.ig_scoped_id;
    if (!recipientIgsid) {
      throw new InstagramNotConnectedError(
        'This contact has no Instagram ID, so it cannot be messaged on Instagram.',
      );
    }

    const config = await this.connect.loadUsableConfig(accountId);
    if (!config) {
      throw new InstagramNotConnectedError(
        'Instagram is not connected, or its access token has expired. Reconnect the account.',
      );
    }

    const decision = evaluateSendWindow({
      lastInboundAt: conversation.last_inbound_at,
      humanAgentEnabled: InstagramConnectService.humanAgentEnabled(),
    });

    if (!decision.allowed) {
      throw new InstagramWindowClosedError(decision.reason, decision.code);
    }

    return {
      igUserId: config.igUserId,
      accessToken: config.accessToken,
      recipientIgsid,
      conversationId: conversation.id,
      decision,
    };
  }

  /**
   * Persist an outbound message and bump the thread.
   *
   * The Meta `mid` is stored on `message_id`, which is what makes echo
   * dedupe work: the echo webhook for this same send arrives moments
   * later carrying the same mid and finds the row already present.
   * Skipping this write would double every agent reply in the inbox.
   */
  private async persistOutbound(args: {
    conversationId: string;
    messageId: string;
    contentType: string;
    contentText: string | null;
    mediaUrl?: string | null;
    senderId?: string | null;
    metadata?: Record<string, unknown>;
    /** Which AI agent wrote this, when one did (migration 084). */
    aiAgentId?: string | null;
  }): Promise<string> {
    const row = await this.prisma.messages.create({
      data: {
        conversation_id: args.conversationId,
        sender_type: 'agent',
        sender_id: args.senderId ?? null,
        content_type: args.contentType,
        content_text: args.contentText,
        media_url: args.mediaUrl ?? null,
        message_id: args.messageId || null,
        // Instagram has no delivery receipt. 'sent' is the terminal
        // state until a messaging_seen webhook promotes it to 'read'.
        status: 'sent',
        metadata: args.metadata as Prisma.InputJsonValue | undefined,
        ai_agent_id: args.aiAgentId ?? null,
      },
      select: { id: true },
    });

    await this.prisma.conversations.update({
      where: { id: args.conversationId },
      data: {
        last_message_text: args.contentText || `[${args.contentType}]`,
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    });

    return row.id;
  }

  // ------------------------------------------------------------
  // Public send API
  // ------------------------------------------------------------

  async sendText(args: {
    accountId: string;
    conversationId: string;
    text: string;
    senderId?: string | null;
    aiAgentId?: string | null;
  }): Promise<IgSendOutcome> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    const result = await sendTextMessage({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      recipientId: target.recipientIgsid,
      text: args.text,
      tag: target.decision.requiresTag ?? undefined,
    });

    const internalId = await this.persistOutbound({
      conversationId: target.conversationId,
      messageId: result.messageId,
      contentType: 'text',
      contentText: args.text,
      senderId: args.senderId,
      aiAgentId: args.aiAgentId,
      metadata: target.decision.requiresTag
        ? { ig_tag: target.decision.requiresTag }
        : undefined,
    });

    return { messageId: result.messageId, internalId };
  }

  async sendMedia(args: {
    accountId: string;
    conversationId: string;
    mediaType: IgMediaType;
    mediaUrl: string;
    caption?: string;
    senderId?: string | null;
  }): Promise<IgSendOutcome> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    const result = await sendMediaMessage({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      recipientId: target.recipientIgsid,
      mediaType: args.mediaType,
      mediaUrl: args.mediaUrl,
      tag: target.decision.requiresTag ?? undefined,
    });

    // Instagram media messages carry no caption field. Sending the
    // caption as a separate text message is the only way to deliver it,
    // and doing it here keeps every caller from reinventing that.
    if (args.caption?.trim()) {
      try {
        await sendTextMessage({
          igUserId: target.igUserId,
          accessToken: target.accessToken,
          recipientId: target.recipientIgsid,
          text: args.caption,
          tag: target.decision.requiresTag ?? undefined,
        });
      } catch (err) {
        this.logger.warn(
          `Instagram media sent but its caption failed: ${String(err)}`,
        );
      }
    }

    const contentType = args.mediaType === 'file' ? 'document' : args.mediaType;

    const internalId = await this.persistOutbound({
      conversationId: target.conversationId,
      messageId: result.messageId,
      contentType,
      contentText: args.caption ?? null,
      mediaUrl: args.mediaUrl,
      senderId: args.senderId,
    });

    return { messageId: result.messageId, internalId };
  }

  /**
   * Instagram's nearest equivalent to WhatsApp's interactive buttons.
   *
   * Quick replies are chips above the composer that vanish once tapped;
   * a button template is a persistent card. Quick replies read better
   * for a menu, so they are the default and `asTemplate` opts into the
   * card.
   */
  async sendButtons(args: {
    accountId: string;
    conversationId: string;
    text: string;
    buttons: Array<{ id: string; title: string }>;
    asTemplate?: boolean;
    senderId?: string | null;
  }): Promise<IgSendOutcome> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    let messageId: string;

    if (args.asTemplate) {
      const buttons: IgButton[] = args.buttons.map((b) => ({
        type: 'postback',
        title: b.title,
        payload: b.id,
      }));
      const result = await sendButtonTemplate({
        igUserId: target.igUserId,
        accessToken: target.accessToken,
        recipientId: target.recipientIgsid,
        text: args.text,
        buttons,
        tag: target.decision.requiresTag ?? undefined,
      });
      messageId = result.messageId;
    } else {
      const quickReplies: IgQuickReply[] = args.buttons.map((b) => ({
        title: b.title,
        payload: b.id,
      }));
      const result = await sendQuickReplies({
        igUserId: target.igUserId,
        accessToken: target.accessToken,
        recipientId: target.recipientIgsid,
        text: args.text,
        quickReplies,
        tag: target.decision.requiresTag ?? undefined,
      });
      messageId = result.messageId;
    }

    const internalId = await this.persistOutbound({
      conversationId: target.conversationId,
      messageId,
      contentType: 'interactive',
      contentText: args.text,
      senderId: args.senderId,
      metadata: {
        ig_interactive: args.asTemplate ? 'button_template' : 'quick_replies',
        options: args.buttons,
      },
    });

    return { messageId, internalId };
  }

  /**
   * A card whose buttons are links out, not postbacks.
   *
   * Kept separate from `sendButtons` rather than bolted onto it with a
   * flag, because the two do opposite things: a postback button drives
   * the conversation forward and comes back on a webhook, a web_url
   * button ends it by sending the person somewhere else. They are the
   * same widget only by accident of Meta's API.
   *
   * Quick replies are not an option here — they carry payloads, not
   * URLs — so this is always a button template.
   */
  async sendLinkButtons(args: {
    accountId: string;
    conversationId: string;
    text: string;
    buttons: Array<{ label: string; url: string }>;
    senderId?: string | null;
  }): Promise<IgSendOutcome> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    const buttons: IgButton[] = args.buttons.map((b) => ({
      type: 'web_url',
      title: b.label,
      url: b.url,
    }));

    const result = await sendButtonTemplate({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      recipientId: target.recipientIgsid,
      text: args.text,
      buttons,
      tag: target.decision.requiresTag ?? undefined,
    });

    const internalId = await this.persistOutbound({
      conversationId: target.conversationId,
      messageId: result.messageId,
      contentType: 'interactive',
      contentText: args.text,
      senderId: args.senderId,
      metadata: {
        ig_interactive: 'button_template',
        // `options` deliberately mirrors sendButtons' shape so the inbox
        // renderer needs one branch, not two — with `url` instead of
        // `id` marking these as unclickable-in-CRM link-outs.
        options: args.buttons,
      },
    });

    return { messageId: result.messageId, internalId };
  }

  async sendCarousel(args: {
    accountId: string;
    conversationId: string;
    elements: IgGenericElement[];
    senderId?: string | null;
  }): Promise<IgSendOutcome> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    const result = await sendGenericTemplate({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      recipientId: target.recipientIgsid,
      elements: args.elements,
      tag: target.decision.requiresTag ?? undefined,
    });

    const internalId = await this.persistOutbound({
      conversationId: target.conversationId,
      messageId: result.messageId,
      contentType: 'interactive',
      contentText: args.elements[0]?.title ?? null,
      senderId: args.senderId,
      metadata: {
        ig_interactive: 'generic_template',
        count: args.elements.length,
      },
    });

    return { messageId: result.messageId, internalId };
  }

  /**
   * React to a customer's message.
   *
   * Reactions are exempt from the messaging window at the API level,
   * but they are still an outbound action on a thread — resolveTarget
   * is used anyway so a closed window blocks them consistently with
   * everything else, rather than leaving one odd affordance alive in a
   * dead thread.
   */
  async react(args: {
    accountId: string;
    conversationId: string;
    /** The internal messages.id being reacted to. */
    messageId: string;
    /** A named Instagram reaction; null removes it. */
    reaction: IgReaction | null;
    /**
     * Required, not optional: `message_reactions` is keyed on
     * (message_id, actor_type, actor_id) and Prisma cannot address a
     * compound unique through a NULL. Every caller is an authenticated
     * agent, so there is always a user id to attribute this to.
     */
    actorUserId: string;
  }): Promise<void> {
    const target = await this.resolveTarget(
      args.accountId,
      args.conversationId,
    );

    const message = await this.prisma.messages.findFirst({
      where: { id: args.messageId, conversation_id: target.conversationId },
      select: { id: true, message_id: true },
    });
    if (!message?.message_id) {
      throw new Error('That message cannot be reacted to on Instagram.');
    }

    if (args.reaction === null) {
      await removeReaction({
        igUserId: target.igUserId,
        accessToken: target.accessToken,
        recipientId: target.recipientIgsid,
        messageId: message.message_id,
      });
      await this.prisma.message_reactions.deleteMany({
        where: {
          message_id: message.id,
          actor_type: 'agent',
          actor_id: args.actorUserId,
        },
      });
      return;
    }

    if (!(IG_REACTIONS as readonly string[]).includes(args.reaction)) {
      throw new Error(
        `Instagram only supports these reactions: ${IG_REACTIONS.join(', ')}.`,
      );
    }

    await sendReaction({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      recipientId: target.recipientIgsid,
      messageId: message.message_id,
      reaction: args.reaction,
    });

    await this.prisma.message_reactions.upsert({
      where: {
        message_id_actor_type_actor_id: {
          message_id: message.id,
          actor_type: 'agent',
          actor_id: args.actorUserId,
        },
      },
      update: { emoji: emojiFor(args.reaction) },
      create: {
        message_id: message.id,
        conversation_id: target.conversationId,
        actor_type: 'agent',
        actor_id: args.actorUserId,
        emoji: emojiFor(args.reaction),
      },
    });
  }

  /** Upload once, reuse across sends. Used by flows with fixed assets. */
  async uploadReusableMedia(args: {
    accountId: string;
    mediaType: IgMediaType;
    mediaUrl: string;
  }): Promise<{ attachmentId: string }> {
    const config = await this.connect.loadUsableConfig(args.accountId);
    if (!config) throw new InstagramNotConnectedError();

    return uploadAttachment({
      igUserId: config.igUserId,
      accessToken: config.accessToken,
      mediaType: args.mediaType,
      mediaUrl: args.mediaUrl,
      isReusable: true,
    });
  }

  /**
   * Whether this thread can be replied to right now — for the composer,
   * which needs the answer without attempting a send.
   */
  async describeWindow(
    accountId: string,
    conversationId: string,
  ): Promise<{
    decision: IgSendDecision;
    lastInboundAt: Date | null;
    humanAgentEnabled: boolean;
  }> {
    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        account_id: accountId,
        channel: 'instagram',
      },
      select: { last_inbound_at: true },
    });

    const humanAgentEnabled = InstagramConnectService.humanAgentEnabled();
    const lastInboundAt = conversation?.last_inbound_at ?? null;

    return {
      decision: evaluateSendWindow({ lastInboundAt, humanAgentEnabled }),
      lastInboundAt,
      humanAgentEnabled,
    };
  }
}

/**
 * message_reactions stores an emoji so the inbox renders WhatsApp and
 * Instagram reactions through one code path. Instagram's API speaks
 * names, so translate at the boundary.
 */
function emojiFor(reaction: IgReaction): string {
  const map: Record<IgReaction, string> = {
    love: '❤️',
    wow: '😮',
    sad: '😢',
    angry: '😡',
    like: '👍',
    laugh: '😂',
  };
  return map[reaction] ?? '❤️';
}
