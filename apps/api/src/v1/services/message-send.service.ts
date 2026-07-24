import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendProductMessage,
  sendProductListMessage,
  MediaKind,
} from '../../whatsapp/meta-api.util';
import { decrypt, encrypt, isLegacyFormat } from '../../common/security/encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '../utils/phone.util';
import { ApiError } from '../utils/respond.util';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'product',
  'product_list',
  ...MEDIA_KINDS,
] as const;

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: any;
  replyToMessageId?: string | null;
  interactiveProductParams?: {
    catalogId?: string;
    productRetailerId?: string;
    bodyText?: string;
    footerText?: string;
    headerText?: string;
    sections?: Array<{
      title: string;
      productRetailerIds: string[];
    }>;
  };
}

export interface SendMessageResult {
  messageId: string;
  whatsappMessageId: string;
}

function isMessageTemplate(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  return (
    typeof row.id === 'string' &&
    (typeof row.userId === 'string' || typeof row.user_id === 'string') &&
    typeof row.name === 'string' &&
    (typeof row.bodyText === 'string' || typeof row.body_text === 'string')
  );
}

@Injectable()
export class MessageSendService {
  private readonly logger = new Logger(MessageSendService.name);

  constructor(private readonly prisma: PrismaService) {}

  validateSendMessageParams(params: {
    messageType: string;
    contentText?: string | null;
    mediaUrl?: string | null;
    templateName?: string | null;
  }): void {
    const { messageType, contentText, mediaUrl, templateName } = params;

    if (!messageType) {
      throw new ApiError('bad_request', 'message_type is required', HttpStatus.BAD_REQUEST);
    }

    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
      throw new ApiError(
        'bad_request',
        `Unsupported message_type "${messageType}"`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (messageType === 'text' && !contentText) {
      throw new ApiError(
        'bad_request',
        'content_text is required for text messages',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (messageType === 'template' && !templateName) {
      throw new ApiError(
        'bad_request',
        'template_name is required for template messages',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (isMediaKind && !mediaUrl) {
      throw new ApiError(
        'bad_request',
        `media_url is required for ${messageType} messages`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (
      isMediaKind &&
      messageType !== 'audio' &&
      typeof contentText === 'string' &&
      contentText.length > 1024
    ) {
      throw new ApiError(
        'bad_request',
        'Caption exceeds the 1024-character limit',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async sendMessageToConversation(
    accountId: string,
    params: SendMessageParams,
  ): Promise<SendMessageResult> {
    const {
      conversationId,
      messageType,
      contentText,
      mediaUrl,
      filename,
      templateName,
      templateLanguage,
      templateParams,
      templateMessageParams,
      replyToMessageId,
      interactiveProductParams,
    } = params;

    if (!conversationId) {
      throw new ApiError(
        'bad_request',
        'conversation_id is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.validateSendMessageParams({ messageType, contentText, mediaUrl, templateName });

    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        account_id: accountId,
      },
      include: {
        contacts: true,
      },
    });

    if (!conversation) {
      throw new ApiError('not_found', 'Conversation not found', HttpStatus.NOT_FOUND);
    }

    const contact = conversation.contacts;
    if (!contact?.phone) {
      throw new ApiError(
        'bad_request',
        'Contact phone number not found',
        HttpStatus.BAD_REQUEST,
      );
    }

    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(sanitizedPhone)) {
      throw new ApiError(
        'bad_request',
        'Invalid phone number format',
        HttpStatus.BAD_REQUEST,
      );
    }

    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: accountId },
    });

    if (!config) {
      throw new ApiError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const accessToken = decrypt(config.access_token);

    if (isLegacyFormat(config.access_token)) {
      void this.prisma.whatsapp_config
        .update({
          where: { id: config.id },
          data: { access_token: encrypt(accessToken) },
        })
        .catch((err: any) => {
          this.logger.warn(
            `[send-message] access_token GCM upgrade failed: ${err?.message || err}`,
          );
        });
    }

    let contextMessageId: string | undefined;
    if (replyToMessageId) {
      const parent = await this.prisma.messages.findFirst({
        where: {
          id: replyToMessageId,
          conversation_id: conversationId,
        },
        select: { message_id: true },
      });

      if (!parent) {
        throw new ApiError(
          'bad_request',
          'reply_to_message_id not found in this conversation',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!parent.message_id) {
        this.logger.warn(
          '[send-message] reply target has no Meta message_id; sending without context',
        );
      } else {
        contextMessageId = parent.message_id;
      }
    }

    let templateRow: any = null;
    if (messageType === 'template' && templateName) {
      const data = await this.prisma.message_templates.findFirst({
        where: {
          account_id: accountId,
          name: templateName,
          language: templateLanguage || 'en_US',
        },
      });
      if (data && !isMessageTemplate(data)) {
        throw new ApiError(
          'template_malformed',
          'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      templateRow = data ?? null;
    }

    // Product / product-list messages need a Meta Commerce catalog id plus a
    // valid retailer id (SKU). Resolve the catalog id once and validate up
    // front so a missing value fails with a clear, actionable message instead
    // of Meta's opaque "(#131009) Parameter value is not valid".
    const resolvedCatalogId =
      interactiveProductParams?.catalogId || config.catalog_id || '';
    if (messageType === 'product' || messageType === 'product_list') {
      if (!resolvedCatalogId) {
        throw new ApiError(
          'whatsapp_catalog_not_configured',
          'No Meta Commerce catalog is linked to this WhatsApp account. Add your Catalog ID in WhatsApp settings before sending product messages.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (messageType === 'product' && !interactiveProductParams?.productRetailerId) {
      throw new ApiError(
        'bad_request',
        'product_retailer_id is required to send a product message.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      messageType === 'product_list' &&
      (!interactiveProductParams?.sections?.length ||
        interactiveProductParams.sections.every(
          (s) => !s.productRetailerIds?.length,
        ))
    ) {
      throw new ApiError(
        'bad_request',
        'At least one product (retailer_id) is required to send a product list message.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const attempt = async (phone: string): Promise<string> => {
      if (messageType === 'template') {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName: templateName!,
          language: templateLanguage || 'en_US',
          template: templateRow ?? undefined,
          messageParams: templateMessageParams ?? undefined,
          params: templateParams || [],
          contextMessageId,
        });
        return result.messageId;
      }
      if (messageType === 'product') {
        const result = await sendProductMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          catalogId: resolvedCatalogId,
          productRetailerId: interactiveProductParams?.productRetailerId || '',
          bodyText: interactiveProductParams?.bodyText || contentText || undefined,
          footerText: interactiveProductParams?.footerText || undefined,
          contextMessageId,
        });
        return result.messageId;
      }
      if (messageType === 'product_list') {
        const result = await sendProductListMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          catalogId: resolvedCatalogId,
          headerText: interactiveProductParams?.headerText || 'Catalogue',
          bodyText: interactiveProductParams?.bodyText || 'Check out our products!',
          footerText: interactiveProductParams?.footerText || undefined,
          sections: interactiveProductParams?.sections || [],
          contextMessageId,
        });
        return result.messageId;
      }
      if (isMediaKind) {
        const result = await sendMediaMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          kind: messageType as MediaKind,
          link: mediaUrl!,
          caption: contentText || undefined,
          filename: filename || undefined,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: contentText!,
        contextMessageId,
      });
      return result.messageId;
    };

    let waMessageId = '';
    let workingPhone = sanitizedPhone;
    try {
      const variants = phoneVariants(sanitizedPhone);
      let lastError: unknown = null;

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant);
          workingPhone = variant;
          lastError = null;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(message)) {
            throw err;
          }
          lastError = err;
          this.logger.warn(
            `[send-message] variant "${variant}" rejected by Meta, trying next…`,
          );
        }
      }

      if (lastError) throw lastError;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error';
      this.logger.error(`[send-message] Meta send failed for all variants: ${message}`);
      const hint = /132000/.test(message) || /parameter.*match/.test(message)
        ? ' The template may be out of sync with Meta. Try syncing templates from Settings → Templates and retry.'
        : '';
      throw new ApiError('meta_error', `Meta API error: ${message}${hint}`, HttpStatus.BAD_GATEWAY);
    }

    if (workingPhone !== sanitizedPhone) {
      this.logger.log(
        `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`,
      );
      await this.prisma.contacts.update({
        where: { id: contact.id },
        data: { phone: workingPhone },
      });
    }

    let finalContentText = contentText || null;
    let previewText = contentText || `[${messageType}]`;
    if (messageType === 'product' && interactiveProductParams?.productRetailerId) {
      finalContentText = JSON.stringify({
        type: 'product',
        retailer_id: interactiveProductParams.productRetailerId,
        name: interactiveProductParams.bodyText || 'Product Message',
        price: interactiveProductParams.footerText || '',
      });
      previewText = `🛍️ Product: ${interactiveProductParams.productRetailerId}`;
    } else if (messageType === 'product_list' && interactiveProductParams?.sections) {
      finalContentText = JSON.stringify({
        type: 'product_list',
        title: interactiveProductParams.headerText || 'Product List',
        sections: interactiveProductParams.sections,
      });
      previewText = `🛍️ Product List: ${interactiveProductParams.headerText || ''}`;
    }

    const messageRecord = await this.prisma.messages.create({
      data: {
        conversation_id: conversationId,
        sender_type: 'agent',
        content_type: messageType === 'product' || messageType === 'product_list' ? 'interactive' : messageType,
        content_text: finalContentText,
        media_url: mediaUrl || null,
        template_name: templateName || null,
        message_id: waMessageId,
        status: 'sent',
        reply_to_message_id: replyToMessageId || null,
      },
    });

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        last_message_text: previewText,
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    });

    try {
      await this.prisma.flowRun.updateMany({
        where: {
          accountId: accountId,
          contactId: contact.id,
          status: 'active',
        },
        data: {
          status: 'paused_by_agent',
          endedAt: new Date(),
          endReason: 'agent_replied',
        },
      });
    } catch (err: any) {
      this.logger.error(`[flows] pause-on-agent-send failed: ${err?.message || err}`);
    }

    return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
  }
}
