import {
  Injectable,
  Logger,
  HttpStatus,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InstagramSendService,
  InstagramWindowClosedError,
  InstagramNotConnectedError,
} from '../../instagram/services/instagram-send.service';
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendProductMessage,
  sendProductListMessage,
  MediaKind,
} from '../../whatsapp/meta-api.util';
import {
  decrypt,
  encrypt,
  isLegacyFormat,
} from '../../common/security/encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  metaVariantToE164,
  isRecipientNotAllowedError,
} from '../utils/phone.util';
import { ApiError } from '../utils/respond.util';
import {
  renderTemplateBody,
  type SendTimeParams,
} from '../utils/template-send-builder.util';
import { buildTemplateSnapshot } from '../../common/messages/template-snapshot.util';
import {
  toMessageMetadata,
  type WhatsAppMessageMetadata,
} from '../../common/messages/message-content.types';

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
  /**
   * Structured send-time values: header text/media/location, per-button
   * substitutions, named body values. Typed rather than `any` because
   * this is the object the whole template path threads through — an
   * untyped one is how a LOCATION header came to be dropped silently
   * between the wizard and Meta.
   */
  templateMessageParams?: SendTimeParams;
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

  constructor(
    private readonly prisma: PrismaService,
    // forwardRef: InstagramModule imports V1Module for its webhook
    // fan-out, so this is a genuine cycle.
    @Inject(forwardRef(() => InstagramSendService))
    private readonly instagramSend: InstagramSendService,
  ) {}

  validateSendMessageParams(params: {
    messageType: string;
    contentText?: string | null;
    mediaUrl?: string | null;
    templateName?: string | null;
  }): void {
    const { messageType, contentText, mediaUrl, templateName } = params;

    if (!messageType) {
      throw new ApiError(
        'bad_request',
        'message_type is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(
      messageType,
    );

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

    this.validateSendMessageParams({
      messageType,
      contentText,
      mediaUrl,
      templateName,
    });

    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(
      messageType,
    );

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
      throw new ApiError(
        'not_found',
        'Conversation not found',
        HttpStatus.NOT_FOUND,
      );
    }

    // Everything below this point speaks the WhatsApp Cloud API —
    // templates, product messages, E.164 phone numbers, phone-variant
    // retries. None of it has an Instagram equivalent, so rather than
    // thread a second transport through a 200-line WhatsApp-shaped
    // method, Instagram conversations are routed out here.
    if (conversation.channel === 'instagram') {
      return this.sendOnInstagram({
        accountId,
        conversationId,
        messageType,
        contentText,
        mediaUrl,
        templateName,
      });
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
    if (
      messageType === 'product' &&
      !interactiveProductParams?.productRetailerId
    ) {
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
          bodyText:
            interactiveProductParams?.bodyText || contentText || undefined,
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
          bodyText:
            interactiveProductParams?.bodyText || 'Check out our products!',
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
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      this.logger.error(
        `[send-message] Meta send failed for all variants: ${message}`,
      );
      const hint =
        /132000/.test(message) || /parameter.*match/.test(message)
          ? ' The template may be out of sync with Meta. Try syncing templates from Settings → Templates and retry.'
          : '';
      throw new ApiError(
        'meta_error',
        `Meta API error: ${message}${hint}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (workingPhone !== sanitizedPhone) {
      // Store the correction canonically — `workingPhone` is Meta's
      // digits-only wire form, and writing that back would undo the
      // E.164 invariant on every trunk-variant retry.
      const canonical = metaVariantToE164(workingPhone);
      if (canonical) {
        this.logger.log(
          `[send-message] Auto-corrected contact phone: ${contact.phone} → ${canonical}`,
        );
        await this.prisma.contacts.update({
          where: { id: contact.id },
          data: { phone: canonical },
        });
      }
    }

    let finalContentText = contentText || null;
    let previewText = contentText || `[${messageType}]`;
    // What the customer will actually see. Meta returns only a message
    // id, so unless it is captured here the thread keeps nothing but
    // the body text — no header image, no footer, no buttons. See
    // buildTemplateSnapshot.
    let messageMetadata: WhatsAppMessageMetadata | null = null;
    if (messageType === 'template' && templateRow) {
      messageMetadata = {
        template: buildTemplateSnapshot(templateRow, {
          ...templateMessageParams,
          body: templateMessageParams?.body ?? templateParams,
        }),
      };
    }
    if (messageType === 'template' && !finalContentText) {
      // Callers may or may not pre-render the body: the inbox composer
      // sends content_text, while the contact-detail send and the public
      // v1 API pass only template_name + params. Derive it here so the
      // stored message never ends up textless — an empty bubble in the
      // thread and a "[template]" conversation preview. No-op when the
      // template row is missing locally (legacy body-only send path).
      const bodyText: string | undefined =
        templateRow?.body_text ?? templateRow?.bodyText;
      if (bodyText) {
        finalContentText = renderTemplateBody(bodyText, {
          body: templateMessageParams?.body ?? templateParams,
        });
        previewText = finalContentText;
      }
    }
    if (
      messageType === 'product' &&
      interactiveProductParams?.productRetailerId
    ) {
      finalContentText = JSON.stringify({
        type: 'product',
        retailer_id: interactiveProductParams.productRetailerId,
        name: interactiveProductParams.bodyText || 'Product Message',
        price: interactiveProductParams.footerText || '',
      });
      previewText = `🛍️ Product: ${interactiveProductParams.productRetailerId}`;
    } else if (
      messageType === 'product_list' &&
      interactiveProductParams?.sections
    ) {
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
        content_type:
          messageType === 'product' || messageType === 'product_list'
            ? 'interactive'
            : messageType,
        content_text: finalContentText,
        media_url: mediaUrl || null,
        template_name: templateName || null,
        message_id: waMessageId,
        status: 'sent',
        reply_to_message_id: replyToMessageId || null,
        metadata: toMessageMetadata(messageMetadata),
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
      this.logger.error(
        `[flows] pause-on-agent-send failed: ${err?.message || err}`,
      );
    }

    return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
  }

  /**
   * Instagram branch of `POST /v1/messages`.
   *
   * Kept narrow on purpose. The public API's WhatsApp path accepts
   * templates, product messages and product lists; Instagram supports
   * none of those, so rather than silently ignoring the parameters this
   * rejects them by name. An integrator who sends `type: "template"` to
   * an Instagram conversation has a bug, and a clear 400 is the fastest
   * way for them to find it.
   *
   * Persistence, the 24-hour window check and the outbound message row
   * all live in InstagramSendService — this only translates the public
   * API's vocabulary into it.
   */
  private async sendOnInstagram(args: {
    accountId: string;
    conversationId: string;
    messageType: string;
    contentText?: string | null;
    mediaUrl?: string | null;
    templateName?: string | null;
  }): Promise<SendMessageResult> {
    if (args.messageType === 'template' || args.templateName) {
      throw new ApiError(
        'unsupported_on_channel',
        'Instagram has no message templates. Send a text message instead — note that ' +
          'Instagram only allows replies within 24 hours of the customer’s last message.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (args.messageType === 'product' || args.messageType === 'product_list') {
      throw new ApiError(
        'unsupported_on_channel',
        'Product messages are a WhatsApp-only feature.',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      if (args.messageType === 'text') {
        if (!args.contentText?.trim()) {
          throw new ApiError(
            'bad_request',
            "'content_text' is required for a text message",
            HttpStatus.BAD_REQUEST,
          );
        }
        const result = await this.instagramSend.sendText({
          accountId: args.accountId,
          conversationId: args.conversationId,
          text: args.contentText,
        });
        return {
          messageId: result.internalId,
          whatsappMessageId: result.messageId,
        };
      }

      if (!args.mediaUrl) {
        throw new ApiError(
          'bad_request',
          "'media_url' is required for a media message",
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.instagramSend.sendMedia({
        accountId: args.accountId,
        conversationId: args.conversationId,
        // 'document' is WhatsApp's name for it; Instagram calls it 'file'.
        mediaType:
          args.messageType === 'document' ? 'file' : (args.messageType as any),
        mediaUrl: args.mediaUrl,
        caption: args.contentText ?? undefined,
      });
      return {
        messageId: result.internalId,
        whatsappMessageId: result.messageId,
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // A closed messaging window is the expected failure here and is
      // safe to surface verbatim — the message explains exactly why and
      // what the integrator can do about it.
      if (err instanceof InstagramWindowClosedError) {
        throw new ApiError(
          'messaging_window_closed',
          err.message,
          HttpStatus.CONFLICT,
        );
      }
      if (err instanceof InstagramNotConnectedError) {
        throw new ApiError(
          'instagram_not_configured',
          err.message,
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }
}
