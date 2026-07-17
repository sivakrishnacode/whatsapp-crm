import { Injectable, Logger, HttpStatus, HttpException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { decrypt, isLegacyFormat, encrypt } from '../../common/security/encryption.util';
import { normalizePhone, phonesMatch } from '../phone-utils.util';
import { isTemplateWebhookField, handleTemplateWebhookChange } from '../utils/template-webhook.util';
import { getMediaUrl } from '../meta-api.util';

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  context?: { id: string };
  order?: {
    catalog_id: string;
    text?: string;
    product_items: Array<{
      product_retailer_id: string;
      quantity: string;
      item_price: string;
      currency: string;
    }>;
  };
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: WhatsAppMessage[];
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
      }>;
    };
    field: string;
  }>;
}

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

@Injectable()
export class WhatsappWebhookService {
  private readonly logger = new Logger(WhatsappWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly flowDispatch: FlowDispatchService,
    private readonly automationDispatch: AutomationDispatchService,
  ) {}

  /**
   * Verify verification token from Meta Graph API subscribe request.
   */
  async handleVerification(
    mode: string,
    challenge: string,
    verifyToken: string,
  ): Promise<string> {
    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      throw new HttpException('Missing verification parameters', HttpStatus.BAD_REQUEST);
    }

    const configs = await this.prisma.whatsapp_config.findMany({
      select: {
        id: true,
        verify_token: true,
      },
    });

    let matchedConfig: { id: string; verify_token: string | null } | null = null;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Skip malformed / wrong-key verify token
      }
    }

    if (matchedConfig) {
      // Upgrade verify token to GCM if it was legacy CBC format
      if (isLegacyFormat(matchedConfig.verify_token!)) {
        try {
          await this.prisma.whatsapp_config.update({
            where: { id: matchedConfig.id },
            data: { verify_token: encrypt(verifyToken) },
          });
        } catch (err) {
          this.logger.warn(`Failed to upgrade verify token to GCM: ${err}`);
        }
      }
      return challenge;
    }

    throw new HttpException('Verification token mismatch', HttpStatus.FORBIDDEN);
  }

  /**
   * Asynchronously process verified webhook payload.
   */
  handleWebhookReceived(body: { entry?: WhatsAppWebhookEntry[] }): void {
    // Process asynchronously so we send response immediately to Meta
    this.processWebhook(body).catch((err) => {
      this.logger.error('Error processing webhook:', err);
    });
  }

  private async processWebhook(body: { entry?: WhatsAppWebhookEntry[] }): Promise<void> {
    if (!body.entry) return;

    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (isTemplateWebhookField(change.field)) {
          await handleTemplateWebhookChange(
            { field: change.field, value: change.value },
            this.prisma,
          );
          continue;
        }

        const value = change.value;

        if (value.statuses) {
          for (const status of value.statuses) {
            await this.handleStatusUpdate(status);
          }
        }

        if (!value.messages || !value.contacts) continue;

        const phoneNumberId = value.metadata.phone_number_id;

        const configRows = await this.prisma.whatsapp_config.findMany({
          where: { phone_number_id: phoneNumberId },
        });

        if (configRows.length === 0) {
          this.logger.error(`No config found for phone_number_id: ${phoneNumberId}`);
          continue;
        }

        if (configRows.length > 1) {
          this.logger.error(
            `Multiple configs (${configRows.length}) found for phone_number_id: ${phoneNumberId} — inbound message dropped.`,
          );
          continue;
        }

        const config = configRows[0];
        const decryptedAccessToken = decrypt(config.access_token);

        for (let i = 0; i < value.messages.length; i++) {
          const message = value.messages[i];
          const contact = value.contacts[i] || value.contacts[0];

          await this.processMessage(
            message,
            contact,
            config.account_id,
            config.user_id,
            decryptedAccessToken,
          );
        }
      }
    }
  }

  private async handleStatusUpdate(status: {
    id: string;
    status: string;
    timestamp: string;
    recipient_id: string;
  }): Promise<void> {
    // 1) Mirror onto messages
    try {
      await this.prisma.messages.updateMany({
        where: { message_id: status.id },
        data: { status: status.status },
      });
    } catch (err) {
      this.logger.error(`Error updating message status: ${err}`);
    }

    // 2) Mirror onto broadcast_recipients
    const tsIso = new Date(parseInt(status.timestamp) * 1000);
    try {
      const recipient = await this.prisma.broadcast_recipients.findFirst({
        where: { whatsapp_message_id: status.id },
        select: { id: true, status: true },
      });

      if (recipient && isValidStatusTransition(recipient.status, status.status)) {
        const update: Record<string, any> = { status: status.status };
        if (status.status === 'sent') update.sent_at = tsIso;
        if (status.status === 'delivered') update.delivered_at = tsIso;
        if (status.status === 'read') update.read_at = tsIso;

        await this.prisma.broadcast_recipients.update({
          where: { id: recipient.id },
          data: update,
        });
      }
    } catch (err) {
      this.logger.error(`Error updating broadcast recipient status: ${err}`);
    }

    // 3) Webhook fan-out
    try {
      const msgRow = await this.prisma.messages.findFirst({
        where: { message_id: status.id },
        select: {
          conversation_id: true,
          conversations: {
            select: { account_id: true },
          },
        },
      });

      if (msgRow?.conversations?.account_id) {
        await this.webhookDeliver.dispatchWebhookEvent(
          msgRow.conversations.account_id,
          'message.status_updated',
          {
            whatsapp_message_id: status.id,
            conversation_id: msgRow.conversation_id,
            status: status.status,
          },
        );
      }
    } catch (err) {
      this.logger.error(`Error dispatching message.status_updated event: ${err}`);
    }
  }

  private async flagBroadcastReplyIfAny(accountId: string, contactId: string): Promise<void> {
    try {
      const recs = await this.prisma.broadcast_recipients.findMany({
        where: {
          contact_id: contactId,
          broadcasts: {
            account_id: accountId,
          },
          status: { in: ['sent', 'delivered', 'read'] },
        },
        select: { id: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      });

      if (recs.length === 0) return;

      await this.prisma.broadcast_recipients.update({
        where: { id: recs[0].id },
        data: {
          status: 'replied',
          replied_at: new Date(),
        },
      });
    } catch (err) {
      this.logger.error('flagBroadcastReplyIfAny failed:', err);
    }
  }

  private async lookupInternalIdByMetaId(
    metaId: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      const msg = await this.prisma.messages.findFirst({
        where: {
          message_id: metaId,
          conversation_id: conversationId,
        },
        select: { id: true },
      });
      return msg?.id ?? null;
    } catch (err) {
      this.logger.error(`lookupInternalIdByMetaId failed: ${err}`);
      return null;
    }
  }

  private async handleReaction(
    message: WhatsAppMessage,
    conversationId: string,
    contactId: string,
  ): Promise<void> {
    const reaction = message.reaction;
    if (!reaction?.message_id) return;

    const targetInternalId = await this.lookupInternalIdByMetaId(
      reaction.message_id,
      conversationId,
    );
    if (!targetInternalId) {
      this.logger.warn(`reaction target message not found; skipping: ${reaction.message_id}`);
      return;
    }

    if (!reaction.emoji) {
      try {
        await this.prisma.message_reactions.deleteMany({
          where: {
            message_id: targetInternalId,
            actor_type: 'customer',
            actor_id: contactId,
          },
        });
      } catch (err) {
        this.logger.error(`reaction delete failed: ${err}`);
      }
      return;
    }

    try {
      await this.prisma.message_reactions.upsert({
        where: {
          message_id_actor_type_actor_id: {
            message_id: targetInternalId,
            actor_type: 'customer',
            actor_id: contactId,
          },
        },
        update: {
          emoji: reaction.emoji,
        },
        create: {
          message_id: targetInternalId,
          conversation_id: conversationId,
          actor_type: 'customer',
          actor_id: contactId,
          emoji: reaction.emoji,
        },
      });
    } catch (err) {
      this.logger.error(`reaction upsert failed: ${err}`);
    }
  }

  private async processMessage(
    message: WhatsAppMessage,
    contact: { profile: { name: string }; wa_id: string },
    accountId: string,
    configOwnerUserId: string,
    accessToken: string,
  ): Promise<void> {
    const senderPhone = normalizePhone(message.from);
    const contactName = contact.profile.name;

    const contactOutcome = await this.findOrCreateContact(
      accountId,
      configOwnerUserId,
      senderPhone,
      contactName,
    );
    if (!contactOutcome) return;
    const contactRecord = contactOutcome.contact;

    const [convResult, parsedContent] = await Promise.all([
      this.findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id),
      this.parseMessageContent(message, accessToken),
    ]);

    if (!convResult) return;
    const conversation = convResult.conversation;

    if (convResult.created) {
      void this.webhookDeliver.dispatchWebhookEvent(accountId, 'conversation.created', {
        conversation_id: conversation.id,
        contact_id: contactRecord.id,
      });
    }

    if (contactOutcome.wasCreated) {
      void this.webhookDeliver.dispatchWebhookEvent(accountId, 'contact.created', {
        contact_id: contactRecord.id,
        phone: contactRecord.phone,
        name: contactRecord.name,
      });
    }

    if (message.type === 'reaction') {
      await this.handleReaction(message, conversation.id, contactRecord.id);
      return;
    }

    const ALLOWED_CONTENT_TYPES = new Set([
      'text',
      'image',
      'document',
      'audio',
      'video',
      'location',
      'template',
      'interactive',
    ]);
    const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
      ? message.type
      : message.type === 'sticker'
        ? 'image'
        : 'text';

    const [replyToInternalIdRaw, firstMsgRow] = await Promise.all([
      message.context?.id
        ? this.lookupInternalIdByMetaId(message.context.id, conversation.id)
        : Promise.resolve(null),
      this.prisma.messages.findFirst({
        where: {
          conversation_id: conversation.id,
          sender_type: 'customer',
        },
        select: { id: true },
      }),
    ]);

    const replyToInternalId = replyToInternalIdRaw;
    if (message.context?.id && !replyToInternalId) {
      this.logger.warn(`reply context parent not found: ${message.context.id}`);
    }

    const isFirstInboundMessage = !firstMsgRow;

    try {
      await this.prisma.messages.create({
        data: {
          conversation_id: conversation.id,
          sender_type: 'customer',
          content_type: contentType,
          content_text: parsedContent.contentText,
          media_url: parsedContent.mediaUrl,
          message_id: message.id,
          status: 'delivered',
          created_at: new Date(parseInt(message.timestamp) * 1000),
          reply_to_message_id: replyToInternalId,
          interactive_reply_id: parsedContent.interactiveReplyId,
        },
      });
    } catch (err) {
      this.logger.error(`Error inserting message: ${err}`);
      return;
    }

    if (message.type === 'order' && message.order) {
      try {
        const productItems = message.order.product_items || [];
        let totalAmount = 0;
        let currency = 'INR';
        const itemsJson: any[] = [];

        for (const item of productItems) {
          const qty = parseFloat(item.quantity) || 0;
          const price = parseFloat(item.item_price) || 0;
          totalAmount += qty * price;
          if (item.currency) currency = item.currency;

          const localProduct = await this.prisma.whatsapp_products.findFirst({
            where: {
              account_id: accountId,
              retailer_id: item.product_retailer_id,
            },
            select: { name: true },
          });

          itemsJson.push({
            retailer_id: item.product_retailer_id,
            name: localProduct?.name || `Product: ${item.product_retailer_id}`,
            quantity: qty,
            unit_price: price,
            currency: item.currency,
          });
        }

        await this.prisma.whatsapp_orders.create({
          data: {
            account_id: accountId,
            contact_id: contactRecord.id,
            whatsapp_message_id: message.id,
            total_amount: totalAmount,
            currency: currency,
            status: 'pending',
            notes: message.order.text || null,
            items: itemsJson,
          },
        });
      } catch (orderErr) {
        this.logger.error('Exception during order insertion:', orderErr);
      }
    }

    try {
      await this.prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          last_message_text: parsedContent.contentText || `[${message.type}]`,
          last_message_at: new Date(),
          unread_count: (conversation.unread_count || 0) + 1,
          updated_at: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(`Error updating conversation: ${err}`);
    }

    void this.flagBroadcastReplyIfAny(accountId, contactRecord.id);

    const inboundText = parsedContent.contentText ?? message.text?.body ?? '';
    let flowConsumed = false;

    // Dispatch Flows Engine directly
    try {
      const flowResult = await this.flowDispatch.dispatchInbound({
        accountId,
        userId: configOwnerUserId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        isFirstInboundMessage,
        message: parsedContent.interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: parsedContent.interactiveReplyId,
              reply_title: parsedContent.contentText ?? '',
              meta_message_id: message.id,
            }
          : {
              kind: 'text',
              text: parsedContent.contentText ?? message.text?.body ?? '',
              meta_message_id: message.id,
            },
      });
      flowConsumed = flowResult.consumed === true;
    } catch (err) {
      this.logger.error('[flows] engine dispatch failed:', err);
    }

    // Trigger Automations directly
    const automationTriggers: (
      | 'new_contact_created'
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
    )[] = [];

    if (!flowConsumed) {
      automationTriggers.push('new_message_received', 'keyword_match');
    }
    if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
    if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');

    for (const triggerType of automationTriggers) {
      this.automationDispatch
        .dispatch({
          accountId,
          triggerType,
          contactId: contactRecord.id,
          context: {
            message_text: inboundText,
            conversation_id: conversation.id,
          },
        })
        .catch((err) => this.logger.error(`[automations] dispatch failed for ${triggerType}:`, err));
    }

    // Trigger AI Auto-reply via HTTP bridge to frontend
    if (!flowConsumed && !parsedContent.interactiveReplyId && inboundText.trim()) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      fetch(`${frontendUrl}/api/internal/ai-reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
        },
        body: JSON.stringify({
          accountId,
          conversationId: conversation.id,
          contactId: contactRecord.id,
          configOwnerUserId,
        }),
      }).catch((err) => this.logger.error('[ai auto-reply] bridge dispatch failed:', err));
    }

    // Trigger message.received event (public API)
    void this.webhookDeliver.dispatchWebhookEvent(accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      whatsapp_message_id: message.id,
      content_type: contentType,
      text: parsedContent.contentText,
    });
  }

  private async parseMessageContent(
    message: WhatsAppMessage,
    accessToken: string,
  ): Promise<{
    contentText: string | null;
    mediaUrl: string | null;
    mediaType: string | null;
    interactiveReplyId: string | null;
  }> {
    const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
      try {
        await getMediaUrl({ mediaId, accessToken });
        return `/api/whatsapp/media/${mediaId}`;
      } catch (error) {
        this.logger.error(
          `Failed to verify media ${mediaId} with Meta: ${
            error instanceof Error ? error.message : error
          }`,
        );
        return null;
      }
    };

    const empty = {
      contentText: null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    };

    switch (message.type) {
      case 'text':
        return { ...empty, contentText: message.text?.body || null };

      case 'image':
        if (message.image?.id) {
          return {
            ...empty,
            contentText: message.image.caption || null,
            mediaUrl: await verifyAndBuildUrl(message.image.id),
            mediaType: message.image.mime_type,
          };
        }
        return empty;

      case 'video':
        if (message.video?.id) {
          return {
            ...empty,
            contentText: message.video.caption || null,
            mediaUrl: await verifyAndBuildUrl(message.video.id),
            mediaType: message.video.mime_type,
          };
        }
        return empty;

      case 'document':
        if (message.document?.id) {
          return {
            ...empty,
            contentText: message.document.caption || message.document.filename || null,
            mediaUrl: await verifyAndBuildUrl(message.document.id),
            mediaType: message.document.mime_type,
          };
        }
        return empty;

      case 'audio':
        if (message.audio?.id) {
          return {
            ...empty,
            mediaUrl: await verifyAndBuildUrl(message.audio.id),
            mediaType: message.audio.mime_type,
          };
        }
        return empty;

      case 'sticker':
        if (message.sticker?.id) {
          return {
            ...empty,
            mediaUrl: await verifyAndBuildUrl(message.sticker.id),
            mediaType: message.sticker.mime_type,
          };
        }
        return empty;

      case 'location':
        if (message.location) {
          const loc = message.location;
          const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
            .filter(Boolean)
            .join(' - ');
          return { ...empty, contentText: locationText };
        }
        return empty;

      case 'reaction':
        return { ...empty, contentText: message.reaction?.emoji || null };

      case 'order':
        if (message.order) {
          const order = message.order;
          const items = order.product_items || [];
          const summary = items
            .map(
              (item) =>
                `- ${item.quantity}x [SKU: ${item.product_retailer_id}] (${item.currency} ${item.item_price})`,
            )
            .join('\n');
          const contentText = `🛒 *Cart Submitted*:\n${summary}${
            order.text ? `\n\nNote: ${order.text}` : ''
          }`;
          return {
            ...empty,
            contentText,
          };
        }
        return empty;

      case 'interactive': {
        const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
        if (reply?.id) {
          return {
            ...empty,
            contentText: reply.title || reply.id,
            interactiveReplyId: reply.id,
          };
        }
        return { ...empty, contentText: '[Interactive reply]' };
      }

      default:
        return {
          ...empty,
          contentText: `[Unsupported message type: ${message.type}]`,
        };
    }
  }

  private async findOrCreateContact(
    accountId: string,
    configOwnerUserId: string,
    phone: string,
    name: string,
  ): Promise<{ contact: any; wasCreated: boolean } | null> {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;

    const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

    // Prisma query for suffix candidates
    const candidates = await this.prisma.contacts.findMany({
      where: {
        account_id: accountId,
        phone: {
          endsWith: suffix,
        },
      },
    });

    const existingContact = candidates.find((c) => phonesMatch(c.phone, phone)) ?? null;

    if (existingContact) {
      if (name && name !== existingContact.name) {
        try {
          const updated = await this.prisma.contacts.update({
            where: { id: existingContact.id },
            data: { name, updated_at: new Date() },
          });
          return { contact: updated, wasCreated: false };
        } catch (err) {
          this.logger.error(`Error updating contact name: ${err}`);
        }
      }
      return { contact: existingContact, wasCreated: false };
    }

    try {
      const newContact = await this.prisma.contacts.create({
        data: {
          account_id: accountId,
          user_id: configOwnerUserId,
          phone,
          name: name || phone,
        },
      });
      return { contact: newContact, wasCreated: true };
    } catch (createError) {
      // Handle concurrent inserts / races
      const isUniqueError =
        createError instanceof Error && createError.message.includes('Unique constraint');
      if (isUniqueError || (createError as any)?.code === 'P2002') {
        const candidatesRetry = await this.prisma.contacts.findMany({
          where: {
            account_id: accountId,
            phone: { endsWith: suffix },
          },
        });
        const raced = candidatesRetry.find((c) => phonesMatch(c.phone, phone)) ?? null;
        if (raced) return { contact: raced, wasCreated: false };
      }
      this.logger.error('Error creating contact:', createError);
      return null;
    }
  }

  private async findOrCreateConversation(
    accountId: string,
    configOwnerUserId: string,
    contactId: string,
  ): Promise<{ conversation: any; created: boolean } | null> {
    const existing = await this.prisma.conversations.findFirst({
      where: {
        account_id: accountId,
        contact_id: contactId,
      },
    });

    if (existing) {
      return { conversation: existing, created: false };
    }

    try {
      const newConv = await this.prisma.conversations.create({
        data: {
          account_id: accountId,
          user_id: configOwnerUserId,
          contact_id: contactId,
        },
      });
      return { conversation: newConv, created: true };
    } catch (createError) {
      this.logger.error('Error creating conversation:', createError);
      return null;
    }
  }
}
