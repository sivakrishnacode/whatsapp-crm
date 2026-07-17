import {
  Controller,
  Post,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageSendService } from '../../v1/services/message-send.service';
import {
  sendReactionMessage,
  sendTemplateMessage,
} from '../meta-api.util';
import { decrypt } from '../../common/security/encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '../../v1/utils/phone.util';
import { ApiError } from '../../v1/utils/respond.util';

interface BroadcastResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

interface NewRecipient {
  phone: string;
  params?: string[];
  messageParams?: any;
}

/**
 * Dashboard-facing WhatsApp action endpoints:
 * - POST /whatsapp/send       → send message from inbox / contact detail
 * - POST /whatsapp/broadcast  → fan-out template to a phone list
 * - POST /whatsapp/react      → send emoji reaction to a message
 */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappDashboardController {
  private readonly logger = new Logger(WhatsappDashboardController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageSend: MessageSendService,
  ) {}

  /**
   * POST /api/whatsapp/send
   *
   * Dashboard outbound send. Targets either an existing conversation_id
   * (inbox) or a contact_id (contact detail → find-or-create conversation).
   */
  @Post('send')
  async send(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const {
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
      interactive_product_params,
    } = body;

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'Either conversation_id or contact_id, plus message_type, are required',
      });
    }

    // Validate message shape up front — before find-or-create — to avoid
    // orphan empty conversations from invalid payloads.
    try {
      this.messageSend.validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.getStatus()).json({ error: err.message });
      }
      throw err;
    }

    let conversationId: string | null = null;

    if (conversationIdInput) {
      const conv = await this.prisma.conversations.findFirst({
        where: {
          id: conversationIdInput,
          account_id: account.accountId,
        },
        select: { id: true },
      });

      if (!conv) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ error: 'Conversation not found' });
      }
      conversationId = conv.id;
    } else {
      // contact_id path — verify contact belongs to this account first
      const contact = await this.prisma.contacts.findFirst({
        where: { id: contact_id, account_id: account.accountId },
        select: { id: true },
      });

      if (!contact) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ error: 'Contact not found' });
      }

      // Find or create the conversation
      const existing = await this.prisma.conversations.findFirst({
        where: { account_id: account.accountId, contact_id },
        select: { id: true },
      });

      if (existing) {
        conversationId = existing.id;
      } else {
        const created = await this.prisma.conversations.create({
          data: {
            account_id: account.accountId,
            user_id: account.userId,
            contact_id,
          },
          select: { id: true },
        });
        conversationId = created.id;
      }
    }

    if (!conversationId) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Conversation not found' });
    }

    try {
      const result = await this.messageSend.sendMessageToConversation(
        account.accountId,
        {
          conversationId,
          messageType: message_type,
          contentText: content_text,
          mediaUrl: media_url,
          filename,
          templateName: template_name,
          templateLanguage: template_language,
          templateParams: template_params,
          templateMessageParams: template_message_params,
          replyToMessageId: reply_to_message_id,
          interactiveProductParams: interactive_product_params,
        },
      );

      return res.status(HttpStatus.OK).json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.getStatus()).json({ error: err.message });
      }
      this.logger.error(
        `Dashboard send failed: ${err instanceof Error ? err.message : err}`,
      );
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to send message' });
    }
  }

  /**
   * POST /api/whatsapp/broadcast
   *
   * Fan-out a template message to a list of recipients.
   * Supports both the legacy phone_numbers[] shape and the new
   * recipients[] shape with per-recipient variable substitution.
   */
  @Post('broadcast')
  async broadcast(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body;

    let recipients: NewRecipient[];

    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients;
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : [];
      recipients = phone_numbers.map((phone: string) => ({ phone, params: shared }));
    } else {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
      });
    }

    if (!template_name) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'template_name is required' });
    }

    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
    });

    if (!config) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'WhatsApp not configured. Please set up your WhatsApp integration first.',
      });
    }

    const accessToken = decrypt(config.access_token!);

    const templateRow = await this.prisma.message_templates.findFirst({
      where: {
        account_id: account.accountId,
        name: template_name,
        language: template_language || 'en_US',
      },
    });

    const results: BroadcastResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone);

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        });
        failedCount++;
        continue;
      }

      const variants = phoneVariants(sanitized);
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: template_language || 'en_US',
            template: (templateRow as any) ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : 'Unknown error';
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage;
            break;
          }
          lastError = errorMessage;
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        });
        sentCount++;
      } else {
        this.logger.warn(
          `Failed to broadcast to ${recipient.phone}: ${lastError}`,
        );
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        });
        failedCount++;
      }
    }

    return res.status(HttpStatus.OK).json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });
  }

  /**
   * POST /api/whatsapp/react
   *
   * Send or remove an emoji reaction on a message.
   * Empty emoji string "" removes the reaction.
   */
  @Post('react')
  async react(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'message_id and emoji are required' });
    }

    // Resolve target message and verify it has a Meta ID
    const targetMessage = await this.prisma.messages.findFirst({
      where: { id: message_id },
      select: { id: true, message_id: true, conversation_id: true },
    });

    if (!targetMessage) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Message not found' });
    }

    if (!targetMessage.message_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'Cannot react to a message that has not been sent to WhatsApp',
      });
    }

    // Verify the conversation belongs to this account and fetch contact phone
    const conversation = await this.prisma.conversations.findFirst({
      where: {
        id: targetMessage.conversation_id,
        account_id: account.accountId,
      },
      include: { contacts: { select: { phone: true } } },
    });

    if (!conversation) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Conversation not found' });
    }

    const contactPhone = conversation.contacts?.phone;
    if (!contactPhone) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Contact phone number not found' });
    }

    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
      select: { phone_number_id: true, access_token: true },
    });

    if (!config) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'WhatsApp not configured.' });
    }

    const accessToken = decrypt(config.access_token!);
    const sanitizedPhone = sanitizePhoneForMeta(contactPhone);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: sanitizedPhone,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      this.logger.error(`[whatsapp/react] Meta send failed: ${message}`);
      return res
        .status(502)
        .json({ error: `Meta API error: ${message}` });
    }

    // Mirror into DB: empty emoji = removal
    if (emoji === '') {
      await this.prisma.message_reactions.deleteMany({
        where: {
          message_id: targetMessage.id,
          actor_type: 'agent',
          actor_id: account.userId,
        },
      });
    } else {
      await this.prisma.message_reactions.upsert({
        where: {
          message_id_actor_type_actor_id: {
            message_id: targetMessage.id,
            actor_type: 'agent',
            actor_id: account.userId,
          },
        },
        create: {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: account.userId,
          emoji,
        },
        update: { emoji },
      });
    }

    return res.status(HttpStatus.OK).json({ success: true });
  }
}
