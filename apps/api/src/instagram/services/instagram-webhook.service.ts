import {
  Injectable,
  Logger,
  HttpStatus,
  HttpException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import type { contacts, conversations, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { AiReplyService } from '../../ai/services/ai-reply.service';
import { InstagramIdentityService } from './instagram-identity.service';
import { InstagramMediaMirrorService } from './instagram-media-mirror.service';
import { InstagramCommentsService } from './instagram-comments.service';
import { CommentFunnelService } from './comment-funnel.service';
import type {
  IgWebhookBody,
  IgWebhookEntry,
  IgMessagingEvent,
  IgInboundMessage,
  IgAttachment,
  IgCommentValue,
} from '../types/webhook.types';

/** Resolved once per entry and threaded through every handler for it. */
interface IgContext {
  accountId: string;
  ownerUserId: string;
  igUserId: string;
  accessToken: string;
}

/** What an attachment list boils down to for the messages table. */
interface ParsedContent {
  contentType: string;
  contentText: string | null;
  mediaUrl: string | null;
  metadata: Record<string, unknown> | null;
  /** Quick-reply / postback payload, stored in interactive_reply_id. */
  interactiveReplyId: string | null;
}

/**
 * Instagram inbound webhook processing.
 *
 * Meta has already received its 200 by the time any of this runs
 * (see the controller) — so nothing here may throw out to the caller,
 * and every handler swallows and logs. A failure to process one event
 * must not abandon the rest of the batch.
 *
 * ROUTING
 *   `entry[].id` is the business's Instagram user id, which is unique
 *   in instagram_config. That single lookup is how a payload finds its
 *   tenant. WhatsApp's equivalent (phone_number_id) is NOT unique in
 *   its table and that webhook has to defensively handle duplicates;
 *   the uniqueness constraint here makes that class of bug impossible.
 */
@Injectable()
export class InstagramWebhookService {
  private readonly logger = new Logger(InstagramWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: InstagramIdentityService,
    private readonly mediaMirror: InstagramMediaMirrorService,
    private readonly comments: InstagramCommentsService,
    private readonly commentFunnel: CommentFunnelService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly flowDispatch: FlowDispatchService,
    private readonly automationDispatch: AutomationDispatchService,
    @Inject(forwardRef(() => AiReplyService))
    private readonly aiReply: AiReplyService,
  ) {}

  // ============================================================
  // Verification handshake
  // ============================================================

  /**
   * One verify token for the whole app, from the environment.
   *
   * WhatsApp stores a per-config encrypted token and scans every row,
   * because each business registers its own webhook there. Instagram
   * has exactly ONE webhook URL per Meta app, configured once by us —
   * so a per-account token would be a lookup with nothing to look up.
   */
  handleVerification(
    mode: string,
    challenge: string,
    verifyToken: string,
  ): string {
    const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;

    if (!expected) {
      this.logger.error(
        'INSTAGRAM_WEBHOOK_VERIFY_TOKEN is not set — rejecting the verification handshake.',
      );
      throw new HttpException(
        'Webhook verification is not configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      throw new HttpException(
        'Missing verification parameters',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (verifyToken !== expected) {
      throw new HttpException(
        'Verification token mismatch',
        HttpStatus.FORBIDDEN,
      );
    }

    return challenge;
  }

  // ============================================================
  // Entry point
  // ============================================================

  /** Fire-and-forget: the controller has already answered Meta. */
  handleWebhookReceived(body: IgWebhookBody): void {
    this.processWebhook(body).catch((err) =>
      this.logger.error(
        'Unhandled error while processing an Instagram webhook',
        err instanceof Error ? err.stack : String(err),
      ),
    );
  }

  private async processWebhook(body: IgWebhookBody): Promise<void> {
    if (!body.entry?.length) return;

    for (const entry of body.entry) {
      try {
        await this.processEntry(entry);
      } catch (err) {
        this.logger.error(
          `Failed to process Instagram entry ${entry.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async processEntry(entry: IgWebhookEntry): Promise<void> {
    const ctx = await this.resolveContext(entry.id);
    if (!ctx) return;

    // Comments arrive either flat (entry.field/entry.value) or wrapped
    // (entry.changes[]) depending on Graph version. Normalise both.
    const commentChanges: Array<{ field: string; value: IgCommentValue }> = [];
    if (entry.field && entry.value) {
      commentChanges.push({ field: entry.field, value: entry.value });
    }
    for (const change of entry.changes ?? []) {
      if (change?.field && change.value) commentChanges.push(change);
    }

    for (const change of commentChanges) {
      try {
        await this.comments.ingestWebhookComment({
          accountId: ctx.accountId,
          ownerUserId: ctx.ownerUserId,
          igUserId: ctx.igUserId,
          accessToken: ctx.accessToken,
          field: change.field,
          value: change.value,
        });
      } catch (err) {
        this.logger.error(
          `Failed to ingest an Instagram ${change.field} event`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    for (const event of entry.messaging ?? []) {
      try {
        await this.processMessagingEvent(ctx, event);
      } catch (err) {
        this.logger.error(
          'Failed to process an Instagram messaging event',
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  /**
   * Map `entry[].id` back to the tenant that owns that Instagram account.
   *
   * Matches EITHER stored id. One Instagram account reports two:
   * `GET /me?fields=user_id` returns the professional account id while
   * the envelope's own `id` is an app-scoped id, and which of the two
   * appears in `entry[].id` varies by event type and Graph version.
   * Matching only one produces a webhook that verifies, returns 200,
   * and silently discards every message — with nothing but a log line
   * to show for it.
   */
  private async resolveContext(igUserId: string): Promise<IgContext | null> {
    const config = await this.prisma.instagram_config.findFirst({
      where: {
        OR: [{ ig_user_id: igUserId }, { ig_app_scoped_id: igUserId }],
      },
    });

    if (!config) {
      // Common and benign in development: a webhook for an Instagram
      // account connected to a different environment sharing the app.
      this.logger.warn(
        `No instagram_config matches entry id ${igUserId} (checked ig_user_id and ig_app_scoped_id) — event dropped`,
      );
      return null;
    }

    try {
      return {
        accountId: config.account_id,
        ownerUserId: config.user_id,
        igUserId: config.ig_user_id,
        accessToken: decrypt(config.access_token),
      };
    } catch (err) {
      this.logger.error(
        `Could not decrypt the Instagram token for account ${config.account_id}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  // ============================================================
  // Messaging event router
  // ============================================================

  private async processMessagingEvent(
    ctx: IgContext,
    event: IgMessagingEvent,
  ): Promise<void> {
    // The business is whichever side equals entry.id. Everything below
    // depends on getting this right — see webhook.types.ts.
    const isEcho = event.message?.is_echo === true;
    const customerIgsid = isEcho ? event.recipient.id : event.sender.id;

    // The business messaging its own account. No customer, no thread.
    if (event.message?.is_self === true) return;
    if (!customerIgsid || customerIgsid === ctx.igUserId) return;

    if (event.read?.mid) {
      await this.handleSeen(ctx, customerIgsid, event.read.mid);
      return;
    }

    if (event.reaction) {
      await this.handleReaction(ctx, customerIgsid, event.reaction);
      return;
    }

    if (event.message_edit) {
      await this.handleMessageEdit(ctx, event.message_edit);
      return;
    }

    if (event.message?.is_deleted) {
      await this.handleDeletion(ctx, event.message.mid);
      return;
    }

    if (event.postback) {
      await this.handlePostback(ctx, customerIgsid, event);
      return;
    }

    if (event.message) {
      await this.handleMessage(ctx, customerIgsid, event, event.message);
      return;
    }

    if (event.referral) {
      await this.handleReferral(ctx, customerIgsid, event);
    }
  }

  // ============================================================
  // Messages
  // ============================================================

  private async handleMessage(
    ctx: IgContext,
    customerIgsid: string,
    event: IgMessagingEvent,
    message: IgInboundMessage,
  ): Promise<void> {
    // Idempotency, and the echo-dedupe that keeps agent replies from
    // appearing twice. Our own sends are written with the mid Meta
    // returned, so the echo that follows finds the row already there.
    const alreadyStored = await this.prisma.messages.findFirst({
      where: { message_id: message.mid },
      select: { id: true },
    });
    if (alreadyStored) return;

    const resolved = await this.resolveThread(ctx, customerIgsid);
    if (!resolved) return;
    const { contact, conversation, contactCreated, conversationCreated } =
      resolved;

    const parsed = await this.parseContent(ctx, message);
    const isEcho = message.is_echo === true;
    const timestamp = toDate(event.timestamp);

    const replyToInternalId = message.reply_to?.mid
      ? await this.lookupInternalId(message.reply_to.mid, conversation.id)
      : null;

    const isFirstInbound =
      !isEcho &&
      !(await this.prisma.messages.findFirst({
        where: { conversation_id: conversation.id, sender_type: 'customer' },
        select: { id: true },
      }));

    try {
      await this.prisma.messages.create({
        data: {
          conversation_id: conversation.id,
          sender_type: isEcho ? 'agent' : 'customer',
          content_type: parsed.contentType,
          content_text: parsed.contentText,
          media_url: parsed.mediaUrl,
          message_id: message.mid,
          // Instagram never sends delivery receipts, only messaging_seen.
          // An inbound message is 'delivered' by definition; an echo is
          // something the business already sent, so 'sent'.
          status: isEcho ? 'sent' : 'delivered',
          created_at: timestamp,
          reply_to_message_id: replyToInternalId,
          interactive_reply_id: parsed.interactiveReplyId,
          metadata: (parsed.metadata ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      // A concurrent redelivery losing the race on message_id is the
      // expected case here; the row exists either way.
      this.logger.error(
        `Could not insert Instagram message ${message.mid}`,
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    const preview = parsed.contentText || `[${parsed.contentType}]`;

    await this.prisma.conversations
      .update({
        where: { id: conversation.id },
        data: {
          last_message_text: preview,
          last_message_at: timestamp,
          // Only a customer message reopens the 24-hour reply window.
          // An echo is the business talking, so it must not.
          ...(isEcho
            ? {}
            : {
                last_inbound_at: timestamp,
                unread_count: (conversation.unread_count ?? 0) + 1,
              }),
          updated_at: new Date(),
        },
      })
      .catch((err) =>
        this.logger.error(`Could not update conversation: ${String(err)}`),
      );

    // An echo is our own outbound coming back. It belongs in the thread
    // so agents see replies sent from the Instagram app, but it must
    // not trigger flows, automations or the AI bot — that would have
    // the CRM answering itself.
    if (isEcho) return;

    // A contact first seen through an echo of our own outbound DM had no
    // resolvable profile when it was created, so it is sitting in the
    // inbox named by its IGSID. This reply is the earliest moment Meta
    // will answer for it — retry before the contact.created payload below
    // carries the name outward.
    const namedContact = await this.identity.upgradePlaceholderName({
      contact,
      accessToken: ctx.accessToken,
    });

    if (conversationCreated) {
      void this.webhookDeliver.dispatchWebhookEvent(
        ctx.accountId,
        'conversation.created',
        { conversation_id: conversation.id, contact_id: contact.id },
      );
    }
    if (contactCreated) {
      void this.webhookDeliver.dispatchWebhookEvent(
        ctx.accountId,
        'contact.created',
        {
          contact_id: namedContact.id,
          phone: null,
          instagram_username: namedContact.ig_username,
          name: namedContact.name,
        },
      );
    }

    await this.fanOut({
      ctx,
      conversation,
      contactId: contact.id,
      customerIgsid,
      contactCreated,
      isFirstInbound,
      text: parsed.contentText ?? '',
      interactiveReplyId: parsed.interactiveReplyId,
      metaMessageId: message.mid,
      contentType: parsed.contentType,
      // Story replies get their own trigger type so automations can
      // distinguish a story reply from an ordinary DM.
      isStoryReply: !!parsed.metadata?.ig_reply_to_story,
    });
  }

  /**
   * Ice-breaker taps and button presses.
   *
   * Modelled as a message rather than a side-channel event: to a flow
   * or automation this is indistinguishable from a WhatsApp interactive
   * reply, and modelling it the same way is what lets the existing
   * engines handle it with no Instagram-specific branch.
   */
  private async handlePostback(
    ctx: IgContext,
    customerIgsid: string,
    event: IgMessagingEvent,
  ): Promise<void> {
    const postback = event.postback!;
    const mid = postback.mid;

    if (mid) {
      const seen = await this.prisma.messages.findFirst({
        where: { message_id: mid },
        select: { id: true },
      });
      if (seen) return;
    }

    const resolved = await this.resolveThread(ctx, customerIgsid);
    if (!resolved) return;
    const { contact, conversation, contactCreated, conversationCreated } =
      resolved;

    const title = postback.title ?? '';
    const payload = postback.payload ?? '';
    const timestamp = toDate(event.timestamp);

    await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'interactive',
        content_text: title,
        message_id: mid ?? null,
        status: 'delivered',
        created_at: timestamp,
        interactive_reply_id: payload,
        metadata: { ig_event: 'postback', title, payload },
      },
    });

    await this.prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        last_message_text: title || '[button]',
        last_message_at: timestamp,
        last_inbound_at: timestamp,
        unread_count: (conversation.unread_count ?? 0) + 1,
        updated_at: new Date(),
      },
    });

    if (conversationCreated) {
      void this.webhookDeliver.dispatchWebhookEvent(
        ctx.accountId,
        'conversation.created',
        { conversation_id: conversation.id, contact_id: contact.id },
      );
    }

    await this.fanOut({
      ctx,
      conversation,
      contactId: contact.id,
      customerIgsid,
      contactCreated,
      // A postback is a tap on something we sent, so the thread already
      // existed — never a first inbound message.
      isFirstInbound: false,
      text: title,
      interactiveReplyId: payload,
      metaMessageId: mid ?? '',
      contentType: 'interactive',
    });
  }

  /**
   * ig.me deep-link attribution arriving without a message.
   *
   * Recorded on the conversation rather than as a message: nobody said
   * anything yet, so a message row would be a lie in the transcript.
   */
  private async handleReferral(
    ctx: IgContext,
    customerIgsid: string,
    event: IgMessagingEvent,
  ): Promise<void> {
    const resolved = await this.resolveThread(ctx, customerIgsid);
    if (!resolved) return;

    this.logger.log(
      `Instagram referral for account ${ctx.accountId}: ref=${event.referral?.ref ?? '?'} source=${event.referral?.source ?? '?'}`,
    );

    void this.webhookDeliver.dispatchWebhookEvent(
      ctx.accountId,
      'conversation.created',
      {
        conversation_id: resolved.conversation.id,
        contact_id: resolved.contact.id,
        referral: event.referral,
      },
    );
  }

  // ============================================================
  // Reactions / seen / edits / deletions
  // ============================================================

  private async handleReaction(
    ctx: IgContext,
    customerIgsid: string,
    reaction: NonNullable<IgMessagingEvent['reaction']>,
  ): Promise<void> {
    const contact = await this.prisma.contacts.findFirst({
      where: { account_id: ctx.accountId, ig_scoped_id: customerIgsid },
      select: { id: true },
    });
    if (!contact) return;

    const conversation = await this.prisma.conversations.findFirst({
      where: {
        account_id: ctx.accountId,
        contact_id: contact.id,
        channel: 'instagram',
      },
      select: { id: true },
    });
    if (!conversation) return;

    const targetId = await this.lookupInternalId(reaction.mid, conversation.id);
    if (!targetId) {
      this.logger.warn(
        `Instagram reaction target not found, skipping: ${reaction.mid}`,
      );
      return;
    }

    if (reaction.action === 'unreact') {
      await this.prisma.message_reactions
        .deleteMany({
          where: {
            message_id: targetId,
            actor_type: 'customer',
            actor_id: contact.id,
          },
        })
        .catch((err) =>
          this.logger.error(`Reaction delete failed: ${String(err)}`),
        );
      return;
    }

    // Instagram sends both a name ('love') and the rendered emoji.
    // message_reactions stores emoji to match the WhatsApp path, so the
    // inbox renders both channels' reactions identically; the name is
    // the fallback when Meta omits the emoji.
    const emoji = reaction.emoji || reaction.reaction || '❤️';

    await this.prisma.message_reactions
      .upsert({
        where: {
          message_id_actor_type_actor_id: {
            message_id: targetId,
            actor_type: 'customer',
            actor_id: contact.id,
          },
        },
        update: { emoji },
        create: {
          message_id: targetId,
          conversation_id: conversation.id,
          actor_type: 'customer',
          actor_id: contact.id,
          emoji,
        },
      })
      .catch((err) =>
        this.logger.error(`Reaction upsert failed: ${String(err)}`),
      );
  }

  /**
   * `messaging_seen` — the customer read up to `mid`.
   *
   * Instagram has no per-message delivery receipt, so this is the only
   * status signal the channel ever produces. Everything at or before
   * the read message is marked read in one statement.
   */
  private async handleSeen(
    ctx: IgContext,
    customerIgsid: string,
    mid: string,
  ): Promise<void> {
    const contact = await this.prisma.contacts.findFirst({
      where: { account_id: ctx.accountId, ig_scoped_id: customerIgsid },
      select: { id: true },
    });
    if (!contact) return;

    const conversation = await this.prisma.conversations.findFirst({
      where: {
        account_id: ctx.accountId,
        contact_id: contact.id,
        channel: 'instagram',
      },
      select: { id: true },
    });
    if (!conversation) return;

    const target = await this.prisma.messages.findFirst({
      where: { message_id: mid, conversation_id: conversation.id },
      select: { created_at: true },
    });

    // Meta sometimes reports a read for a message we never stored (sent
    // from the Instagram app before the account was connected). Falling
    // back to "everything so far" is right: the customer has clearly
    // caught up on the thread.
    const upTo = target?.created_at ?? new Date();

    await this.prisma.messages
      .updateMany({
        where: {
          conversation_id: conversation.id,
          sender_type: { not: 'customer' },
          created_at: { lte: upTo },
          status: { not: 'read' },
        },
        data: { status: 'read' },
      })
      .catch((err) =>
        this.logger.error(
          `Could not apply Instagram read status: ${String(err)}`,
        ),
      );
  }

  private async handleMessageEdit(
    ctx: IgContext,
    edit: NonNullable<IgMessagingEvent['message_edit']>,
  ): Promise<void> {
    const existing = await this.prisma.messages.findFirst({
      where: { message_id: edit.mid },
      select: { id: true, content_text: true, metadata: true },
    });
    if (!existing) {
      this.logger.warn(`Instagram edit for unknown message ${edit.mid}`);
      return;
    }

    const previous =
      (existing.metadata as Record<string, unknown> | null) ?? {};

    await this.prisma.messages.update({
      where: { id: existing.id },
      data: {
        content_text: edit.text ?? existing.content_text,
        metadata: {
          ...previous,
          edited: true,
          edit_count: Number(edit.num_edit ?? 1),
          // Keep the original so an agent can see what changed —
          // "they edited it after I replied" is a real support case.
          original_text: previous.original_text ?? existing.content_text,
        },
      },
    });
  }

  /**
   * Tombstone rather than delete: reply chains and reactions point at
   * this row, and the thread should read "message deleted" rather than
   * silently losing a turn of the conversation.
   */
  private async handleDeletion(ctx: IgContext, mid: string): Promise<void> {
    await this.prisma.messages
      .updateMany({
        where: { message_id: mid, deleted_at: null },
        data: { deleted_at: new Date() },
      })
      .catch((err) =>
        this.logger.error(`Could not tombstone ${mid}: ${String(err)}`),
      );
  }

  // ============================================================
  // Content parsing
  // ============================================================

  /**
   * Collapse an Instagram message into the columns `messages` has.
   *
   * `content_type` is deliberately constrained to the vocabulary the
   * WhatsApp path already uses, so the inbox renderer needs no
   * Instagram-specific cases. Anything that does not map (a shared
   * post, a story mention) becomes the nearest equivalent, with the
   * detail preserved in `metadata`.
   */
  private async parseContent(
    ctx: IgContext,
    message: IgInboundMessage,
  ): Promise<ParsedContent> {
    const base: ParsedContent = {
      contentType: 'text',
      contentText: message.text ?? null,
      mediaUrl: null,
      metadata: null,
      interactiveReplyId: message.quick_reply?.payload ?? null,
    };

    if (message.is_unsupported) {
      return {
        ...base,
        contentText:
          message.text ?? '[unsupported message type — view it on Instagram]',
        metadata: { ig_unsupported: true },
      };
    }

    // A reply to one of the business's stories. High-value automation
    // trigger, so the story context is kept rather than flattened away.
    if (message.reply_to?.story) {
      return {
        ...base,
        metadata: {
          ig_reply_to_story: {
            id: message.reply_to.story.id,
            url: message.reply_to.story.url,
          },
        },
      };
    }

    const attachment = message.attachments?.[0];
    if (!attachment) return base;

    const { contentType, kind } = mapAttachment(attachment);
    const sourceUrl = attachment.payload?.url ?? null;

    const mediaUrl = sourceUrl
      ? ((await this.mediaMirror.mirror({
          accountId: ctx.accountId,
          sourceUrl,
          kind,
        })) ?? sourceUrl)
      : null;

    const metadata: Record<string, unknown> = {
      ig_attachment_type: attachment.type,
    };
    if (attachment.payload?.title) metadata.title = attachment.payload.title;
    if (attachment.payload?.reel_video_id) {
      metadata.reel_video_id = attachment.payload.reel_video_id;
    }
    if (sourceUrl && mediaUrl !== sourceUrl) {
      // Keep the original for debugging a mirror that looks wrong. It
      // will be dead within hours, which is exactly why we mirrored.
      metadata.ig_source_url_expired = true;
    }
    if (message.attachments && message.attachments.length > 1) {
      // Rare, but Instagram can batch. Only the first becomes the
      // message body; record that others existed rather than pretend
      // they did not.
      metadata.ig_additional_attachments = message.attachments.length - 1;
    }

    return {
      contentType,
      contentText: message.text ?? attachment.payload?.title ?? null,
      mediaUrl,
      metadata,
      interactiveReplyId: base.interactiveReplyId,
    };
  }

  // ============================================================
  // Shared helpers
  // ============================================================

  private async resolveThread(
    ctx: IgContext,
    customerIgsid: string,
  ): Promise<{
    // The full row, not a projection: identity resolution
    // (upgradePlaceholderName) reads ig_scoped_id and avatar_url too.
    contact: contacts;
    conversation: conversations;
    contactCreated: boolean;
    conversationCreated: boolean;
  } | null> {
    const contactOutcome = await this.identity.findOrCreateContact({
      accountId: ctx.accountId,
      ownerUserId: ctx.ownerUserId,
      igsid: customerIgsid,
      accessToken: ctx.accessToken,
    });
    if (!contactOutcome) return null;

    const convOutcome = await this.identity.findOrCreateConversation({
      accountId: ctx.accountId,
      ownerUserId: ctx.ownerUserId,
      contactId: contactOutcome.contact.id,
    });
    if (!convOutcome) return null;

    return {
      contact: contactOutcome.contact,
      conversation: convOutcome.conversation,
      contactCreated: contactOutcome.wasCreated,
      conversationCreated: convOutcome.created,
    };
  }

  private async lookupInternalId(
    metaId: string,
    conversationId: string,
  ): Promise<string | null> {
    const row = await this.prisma.messages.findFirst({
      where: { message_id: metaId, conversation_id: conversationId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Hand the inbound message to flows, automations, the AI bot and the
   * partner webhook fan-out — the same four engines the WhatsApp
   * webhook drives, in the same order and with the same precedence.
   *
   * Precedence matters: a flow that consumes the message suppresses
   * automations and the AI bot, so the customer gets one answer rather
   * than three.
   *
   * Comment → DM funnels sit AHEAD of flows in that order. A funnel tap
   * is addressed to one specific run by id, so it is the narrowest
   * possible claim on a message — where a flow's keyword trigger or the
   * AI bot would both happily answer "I followed you! ✅" with something
   * of their own, mid-funnel.
   */
  private async fanOut(args: {
    ctx: IgContext;
    conversation: conversations;
    contactId: string;
    /** The sender's IGSID. Per-event, not per-context — funnels need it
     *  to ask Meta whether this person follows the business. */
    customerIgsid: string;
    contactCreated: boolean;
    isFirstInbound: boolean;
    text: string;
    interactiveReplyId: string | null;
    metaMessageId: string;
    contentType: string;
    /** True when the inbound is a reply to one of our Instagram stories. */
    isStoryReply?: boolean;
  }): Promise<void> {
    const { ctx, conversation, contactId } = args;

    // Funnels first. Only a button tap can belong to one, so this is a
    // cheap prefix check on the payload for every other inbound.
    if (args.interactiveReplyId) {
      try {
        const consumed = await this.commentFunnel.onPostback({
          accountId: ctx.accountId,
          ownerUserId: ctx.ownerUserId,
          accessToken: ctx.accessToken,
          contactId,
          conversationId: conversation.id,
          fromIgsid: args.customerIgsid,
          payload: args.interactiveReplyId,
        });
        if (consumed) {
          void this.webhookDeliver.dispatchWebhookEvent(
            ctx.accountId,
            'message.received',
            {
              channel: 'instagram',
              conversation_id: conversation.id,
              contact_id: contactId,
              instagram_message_id: args.metaMessageId,
              content_type: args.contentType,
              text: args.text || null,
            },
          );
          return;
        }
      } catch (err) {
        // Fall through to the normal engines rather than swallowing the
        // message: a broken funnel should degrade to "no funnel", not to
        // "Instagram stopped replying".
        this.logger.error(`[funnel] Instagram dispatch failed: ${String(err)}`);
      }
    }

    let flowConsumed = false;
    try {
      const result = await this.flowDispatch.dispatchInbound({
        accountId: ctx.accountId,
        userId: ctx.ownerUserId,
        contactId,
        conversationId: conversation.id,
        isFirstInboundMessage: args.isFirstInbound,
        channel: 'instagram',
        message: args.interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: args.interactiveReplyId,
              reply_title: args.text,
              meta_message_id: args.metaMessageId,
            }
          : {
              kind: 'text',
              text: args.text,
              meta_message_id: args.metaMessageId,
            },
      });
      flowConsumed = result.consumed === true;
    } catch (err) {
      this.logger.error(`[flows] Instagram dispatch failed: ${String(err)}`);
    }

    const triggers: Array<
      | 'new_contact_created'
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
      | 'instagram_story_reply'
    > = [];
    if (!flowConsumed) triggers.push('new_message_received', 'keyword_match');
    // Story replies also fire the dedicated trigger so automations can
    // react specifically to them (e.g. "reply to my story → send DM").
    if (args.isStoryReply) triggers.push('instagram_story_reply');
    if (args.contactCreated) triggers.unshift('new_contact_created');
    if (args.isFirstInbound) triggers.unshift('first_inbound_message');

    for (const triggerType of triggers) {
      this.automationDispatch
        .dispatch({
          accountId: ctx.accountId,
          triggerType,
          contactId,
          context: {
            message_text: args.text,
            conversation_id: conversation.id,
            channel: 'instagram',
          },
        })
        .catch((err) =>
          this.logger.error(
            `[automations] Instagram dispatch failed for ${triggerType}: ${String(err)}`,
          ),
        );
    }

    if (!flowConsumed && !args.interactiveReplyId && args.text.trim()) {
      void this.aiReply.dispatchInboundToAiReply({
        accountId: ctx.accountId,
        conversationId: conversation.id,
        contactId,
        configOwnerUserId: ctx.ownerUserId,
      });
    }

    void this.webhookDeliver.dispatchWebhookEvent(
      ctx.accountId,
      'message.received',
      {
        channel: 'instagram',
        conversation_id: conversation.id,
        contact_id: contactId,
        instagram_message_id: args.metaMessageId,
        content_type: args.contentType,
        text: args.text || null,
      },
    );
  }
}

// ============================================================
// Pure helpers
// ============================================================

/**
 * Instagram timestamps are epoch **milliseconds** — unlike WhatsApp's,
 * which are seconds. Getting this wrong puts every message in 1970.
 */
function toDate(timestamp: number | string | undefined): Date {
  if (timestamp === undefined || timestamp === null) return new Date();
  const n = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (!Number.isFinite(n)) return new Date();
  return new Date(n);
}

function mapAttachment(attachment: IgAttachment): {
  contentType: string;
  kind: string;
} {
  switch (attachment.type) {
    case 'image':
      return { contentType: 'image', kind: 'image' };
    case 'video':
    case 'ig_reel':
      return { contentType: 'video', kind: 'video' };
    case 'audio':
      return { contentType: 'audio', kind: 'audio' };
    case 'file':
      return { contentType: 'document', kind: 'file' };
    case 'story_mention':
      // A story mention is an image (or a video frame) of the story the
      // business was tagged in.
      return { contentType: 'image', kind: 'image' };
    case 'share':
      // A shared post or link. The payload URL is a preview image.
      return { contentType: 'image', kind: 'image' };
    default:
      return { contentType: 'text', kind: 'file' };
  }
}
