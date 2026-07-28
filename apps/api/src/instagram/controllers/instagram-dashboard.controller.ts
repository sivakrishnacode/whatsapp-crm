import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import {
  InstagramSendService,
  InstagramWindowClosedError,
  InstagramNotConnectedError,
} from '../services/instagram-send.service';
import { windowRemainingMs } from '../ig-window.util';
import type { IgMediaType, IgReaction } from '../ig-api.util';

interface SendBody {
  conversation_id?: string;
  message_type?: 'text' | 'image' | 'video' | 'audio' | 'file' | 'buttons';
  content_text?: string;
  media_url?: string;
  caption?: string;
  buttons?: Array<{ id: string; title: string }>;
  as_template?: boolean;
}

/**
 * Instagram send + window endpoints for the dashboard inbox.
 *
 * Mirrors whatsapp-dashboard.controller.ts's `POST /whatsapp/send`, but
 * there is deliberately no broadcast endpoint here: Instagram has no
 * message templates, so bulk unsolicited DMs are neither possible nor
 * permitted. See CHANNEL_CAPABILITIES in common/messaging/channel.ts.
 */
@Controller('instagram')
@UseGuards(SupabaseAuthGuard)
export class InstagramDashboardController {
  constructor(private readonly send: InstagramSendService) {}

  /**
   * What the composer needs to render itself: can we reply, and for
   * how much longer. Cheap — one indexed row read, no Meta call.
   */
  @Get('conversations/:id/window')
  async window(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') conversationId: string,
    @Res() res: Response,
  ) {
    const info = await this.send.describeWindow(
      account.accountId,
      conversationId,
    );

    return res.status(HttpStatus.OK).json({
      allowed: info.decision.allowed,
      requires_tag: info.decision.allowed ? info.decision.requiresTag : null,
      reason: info.decision.allowed ? null : info.decision.reason,
      code: info.decision.allowed ? null : info.decision.code,
      last_inbound_at: info.lastInboundAt?.toISOString() ?? null,
      remaining_ms: windowRemainingMs({
        lastInboundAt: info.lastInboundAt,
        humanAgentEnabled: info.humanAgentEnabled,
      }),
      human_agent_enabled: info.humanAgentEnabled,
    });
  }

  @Post('send')
  async sendMessage(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: SendBody,
    @Res() res: Response,
  ) {
    const conversationId = body.conversation_id;
    if (!conversationId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'conversation_id is required' });
    }

    const type = body.message_type ?? 'text';

    try {
      if (type === 'text') {
        if (!body.content_text?.trim()) {
          return res
            .status(HttpStatus.BAD_REQUEST)
            .json({ error: 'content_text is required for a text message' });
        }
        const result = await this.send.sendText({
          accountId: account.accountId,
          conversationId,
          text: body.content_text,
          senderId: account.userId,
        });
        return res.status(HttpStatus.OK).json(result);
      }

      if (type === 'buttons') {
        if (!body.content_text?.trim() || !body.buttons?.length) {
          return res.status(HttpStatus.BAD_REQUEST).json({
            error: 'content_text and at least one button are required',
          });
        }
        const result = await this.send.sendButtons({
          accountId: account.accountId,
          conversationId,
          text: body.content_text,
          buttons: body.buttons,
          asTemplate: body.as_template,
          senderId: account.userId,
        });
        return res.status(HttpStatus.OK).json(result);
      }

      if (!body.media_url) {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'media_url is required for a media message' });
      }

      const result = await this.send.sendMedia({
        accountId: account.accountId,
        conversationId,
        mediaType: type as IgMediaType,
        mediaUrl: body.media_url,
        caption: body.caption ?? body.content_text,
        senderId: account.userId,
      });
      return res.status(HttpStatus.OK).json(result);
    } catch (err) {
      return respondToSendError(res, err);
    }
  }

  @Post('react')
  async react(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: { conversation_id?: string; message_id?: string; reaction?: string },
    @Res() res: Response,
  ) {
    if (!body.conversation_id || !body.message_id) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'conversation_id and message_id are required' });
    }

    try {
      await this.send.react({
        accountId: account.accountId,
        conversationId: body.conversation_id,
        messageId: body.message_id,
        // An empty/absent reaction means "remove", matching how the
        // WhatsApp react endpoint treats an empty emoji.
        reaction: (body.reaction || null) as IgReaction | null,
        actorUserId: account.userId,
      });
      return res.status(HttpStatus.OK).json({ ok: true });
    } catch (err) {
      return respondToSendError(res, err);
    }
  }
}

/**
 * A closed window is a 409, not a 500: the request was well-formed and
 * the reason is actionable and safe to show verbatim. A missing
 * connection is a 400 for the same reason. Everything else is ours.
 */
export function respondToSendError(res: Response, err: unknown): Response {
  if (err instanceof InstagramWindowClosedError) {
    return res
      .status(HttpStatus.CONFLICT)
      .json({ error: err.message, code: err.code });
  }
  if (err instanceof InstagramNotConnectedError) {
    return res
      .status(HttpStatus.BAD_REQUEST)
      .json({ error: err.message, code: 'not_connected' });
  }
  return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
    error: err instanceof Error ? err.message : 'Instagram send failed',
  });
}
