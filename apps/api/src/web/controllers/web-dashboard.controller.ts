import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { WebSendService } from '../services/web-send.service';
import { WebStreamService } from '../services/web-stream.service';
import { SendWebAgentMessageDto } from '../dto/send-web-agent-message.dto';
import { WebSessionsService } from '../services/web-sessions.service';

/**
 * Agent-side endpoints for web conversations, consumed by the inbox.
 *
 * Counterpart to `whatsapp/send` and `instagram/send`. There is
 * deliberately no window endpoint here: web has no messaging window
 * (`CHANNEL_CAPABILITIES.web.replyWindowHours` is null), so a composer
 * that asked "can I reply?" would be asking a question with one answer.
 * The inbox reads the capability instead of calling anything.
 */
@Controller('web')
@UseGuards(SupabaseAuthGuard)
export class WebDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly send: WebSendService,
    private readonly stream: WebStreamService,
    private readonly sessions: WebSessionsService,
  ) {}

  /**
   * Visitor sessions and the engagement funnel.
   *
   * Member-readable, not agent-gated: this is reporting, and the numbers are
   * the same ones the Home dashboard shows.
   */
  @Get('sessions')
  async listSessions(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('days') days?: string,
  ) {
    const window = Number(days) || 30;
    const [summary, rows] = await Promise.all([
      this.sessions.summary(account.accountId, window),
      this.sessions.list(account.accountId, { days: window }),
    ]);
    return { summary, sessions: rows };
  }

  @Post('send')
  @RequireRole('agent')
  async sendMessage(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: SendWebAgentMessageDto,
  ) {
    const senderId = account.userId;

    if (body.message_type === 'buttons') {
      if (!body.buttons?.length) {
        throw new BadRequestException('Buttons require at least one option.');
      }
      const result = await this.send.sendButtons({
        accountId: account.accountId,
        conversationId: body.conversation_id,
        bodyText: body.content_text ?? '',
        buttons: body.buttons,
        senderId,
      });
      return { id: result.internalId, message_id: result.messageId };
    }

    if (body.message_type && body.message_type !== 'text') {
      if (!body.media_url) {
        throw new BadRequestException('A media message needs a media_url.');
      }
      const result = await this.send.sendMedia({
        accountId: account.accountId,
        conversationId: body.conversation_id,
        kind: body.message_type,
        link: body.media_url,
        caption: body.content_text,
        senderId,
      });
      return { id: result.internalId, message_id: result.messageId };
    }

    if (!body.content_text?.trim()) {
      throw new BadRequestException('A text message cannot be empty.');
    }
    const result = await this.send.sendText({
      accountId: account.accountId,
      conversationId: body.conversation_id,
      text: body.content_text,
      senderId,
    });
    return { id: result.internalId, message_id: result.messageId };
  }

  /**
   * Agent is typing. Real on this channel — we hold the visitor's socket,
   * so unlike WhatsApp (where we cannot send a typing indicator at all)
   * this actually reaches them.
   */
  @Post('conversations/:id/typing')
  @RequireRole('agent')
  async typing(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') conversationId: string,
  ) {
    await this.assertOwnWebConversation(account.accountId, conversationId);
    await this.stream.setAgentTyping(conversationId);
    return { ok: true };
  }

  /** Agent read the thread — pushes a read receipt to the visitor. */
  @Post('conversations/:id/read')
  @RequireRole('agent')
  async read(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') conversationId: string,
  ) {
    await this.assertOwnWebConversation(account.accountId, conversationId);
    await this.stream.publish(conversationId, {
      type: 'read',
      by: 'agent',
      at: new Date().toISOString(),
    });
    return { ok: true };
  }

  /**
   * The visit behind a conversation: landing page, referrer, UTM.
   *
   * Web-only context with no equivalent on the Meta channels, and the
   * reason `web_sessions` exists — "which campaign produced this
   * conversation" is unanswerable from `messages` alone.
   */
  @Get('conversations/:id/session')
  async session(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') conversationId: string,
  ) {
    await this.assertOwnWebConversation(account.accountId, conversationId);

    const session = await this.prisma.web_sessions.findFirst({
      where: { account_id: account.accountId, conversation_id: conversationId },
      orderBy: { started_at: 'desc' },
      select: {
        started_at: true,
        last_seen_at: true,
        page_url: true,
        referrer: true,
        utm: true,
        country: true,
        pages_viewed: true,
      },
    });

    return session
      ? {
          started_at: session.started_at.toISOString(),
          last_seen_at: session.last_seen_at.toISOString(),
          page_url: session.page_url,
          referrer: session.referrer,
          utm: session.utm,
          country: session.country,
          pages_viewed: session.pages_viewed,
        }
      : null;
  }

  /**
   * Account-scoped AND channel-pinned. Without the channel filter an
   * agent could aim a web typing indicator at a WhatsApp thread, which
   * would publish to a Redis channel nobody reads — a silent no-op that
   * looks like a bug in the widget.
   */
  private async assertOwnWebConversation(
    accountId: string,
    conversationId: string,
  ): Promise<void> {
    const found = await this.prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId, channel: 'web' },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException('No such web conversation.');
    }
  }
}
