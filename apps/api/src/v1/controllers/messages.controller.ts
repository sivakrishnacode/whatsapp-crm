import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseFilters,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext } from '../../auth/types/account-context.type';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, ApiError } from '../utils/respond.util';
import { resolveConversationByPhone } from '../utils/resolve-conversation.util';
import { MessageSendService } from '../services/message-send.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../services/webhook-deliver.service';

@Controller('v1/messages')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class MessagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly messageSendService: MessageSendService,
  ) {}

  @Post()
  @RequireScope('messages:send')
  async sendMessage(
    @CurrentAccount() ctx: AccountContext,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('bad_request', 'Request body must be a JSON object', HttpStatus.BAD_REQUEST);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      throw new ApiError('bad_request', "'to' is required", HttpStatus.BAD_REQUEST);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, any>)
        : null;

    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : undefined;

    const templateMessageParams =
      template?.params && !Array.isArray(template.params)
        ? template.params
        : undefined;

    // Validate parameters BEFORE creating contact/conversation
    this.messageSendService.validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
    });

    const resolved = await resolveConversationByPhone(
      this.prisma,
      this.webhookDeliver,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null,
    );

    const result = await this.messageSendService.sendMessageToConversation(
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      },
    );

    res.status(HttpStatus.CREATED);
    return ok({
      message_id: result.messageId,
      whatsapp_message_id: result.whatsappMessageId,
      conversation_id: resolved.conversationId,
      contact_id: resolved.contactId,
      contact_created: resolved.contactCreated,
    });
  }
}
