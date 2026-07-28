import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramCommentsService } from '../services/instagram-comments.service';
import { InstagramConnectService } from '../services/instagram-connect.service';

const MAX_PAGE = 100;

/**
 * Comment moderation and the comment → DM funnel.
 *
 * Every mutation resolves the account's Instagram token first; the
 * service then re-scopes the comment by account id before touching it,
 * so a forged comment id from the request body cannot reach another
 * tenant's data.
 */
@Controller('instagram')
@UseGuards(SupabaseAuthGuard)
export class InstagramCommentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comments: InstagramCommentsService,
    private readonly connect: InstagramConnectService,
  ) {}

  private async requireToken(accountId: string) {
    const config = await this.connect.loadUsableConfig(accountId);
    if (!config) {
      throw new Error(
        'Instagram is not connected, or its access token has expired.',
      );
    }
    return config;
  }

  // ------------------------------------------------------------
  // Reads — straight from our own tables, no Meta round trip
  // ------------------------------------------------------------

  @Get('comments')
  async list(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('status') status: string | undefined,
    @Query('media_id') mediaId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const take = Math.min(Number(limit) || 50, MAX_PAGE);

    const rows = await this.prisma.instagram_comments.findMany({
      where: {
        account_id: account.accountId,
        ...(status ? { status } : {}),
        ...(mediaId ? { ig_media_id: mediaId } : {}),
        // The business's own comments are stored for context but are
        // never moderation work — hide them from the queue.
        is_from_business: false,
      },
      orderBy: { commented_at: 'desc' },
      take,
    });

    // One extra query beats N+1 joins for a page of comments that
    // mostly point at a handful of posts.
    const mediaIds = [...new Set(rows.map((r) => r.ig_media_id))];
    const media = mediaIds.length
      ? await this.prisma.instagram_media.findMany({
          where: {
            account_id: account.accountId,
            ig_media_id: { in: mediaIds },
          },
        })
      : [];
    const mediaByIgId = new Map(media.map((m) => [m.ig_media_id, m]));

    return res.status(HttpStatus.OK).json({
      comments: rows.map((r) => ({
        ...r,
        media: mediaByIgId.get(r.ig_media_id) ?? null,
      })),
    });
  }

  @Get('media')
  async listMedia(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const media = await this.prisma.instagram_media.findMany({
      where: { account_id: account.accountId },
      orderBy: { posted_at: 'desc' },
      take: MAX_PAGE,
    });
    return res.status(HttpStatus.OK).json({ media });
  }

  // ------------------------------------------------------------
  // Sync
  // ------------------------------------------------------------

  /**
   * Backfill posts. Needed because webhooks only cover activity after
   * connecting — without this a new account's Posts view is empty.
   */
  @Post('media/sync')
  async syncMedia(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.syncMedia({
        accountId: account.accountId,
        igUserId: config.igUserId,
        accessToken: config.accessToken,
      });
      return res.status(HttpStatus.OK).json(result);
    } catch (err) {
      return fail(res, err);
    }
  }

  @Post('media/:mediaId/comments/sync')
  async syncComments(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.syncMediaComments({
        accountId: account.accountId,
        igUserId: config.igUserId,
        accessToken: config.accessToken,
        mediaId,
      });
      return res.status(HttpStatus.OK).json(result);
    } catch (err) {
      return fail(res, err);
    }
  }

  // ------------------------------------------------------------
  // Moderation
  // ------------------------------------------------------------

  @Post('comments/:id/reply')
  async reply(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') commentId: string,
    @Body() body: { message?: string },
    @Res() res: Response,
  ) {
    if (!body.message?.trim()) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'message is required' });
    }
    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.replyPublicly({
        accountId: account.accountId,
        accessToken: config.accessToken,
        commentId,
        message: body.message,
      });
      return res.status(HttpStatus.OK).json(result);
    } catch (err) {
      return fail(res, err);
    }
  }

  /**
   * Private reply — opens a DM thread with the commenter.
   *
   * Meta's one-per-comment / 7-day limits are checked in the service
   * before the API call, so a violation returns a readable 400 rather
   * than an opaque Graph error.
   */
  @Post('comments/:id/private-reply')
  async privateReply(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') commentId: string,
    @Body() body: { message?: string },
    @Res() res: Response,
  ) {
    if (!body.message?.trim()) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'message is required' });
    }
    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.replyPrivately({
        accountId: account.accountId,
        ownerUserId: config.userId,
        igUserId: config.igUserId,
        accessToken: config.accessToken,
        commentId,
        message: body.message,
      });
      return res.status(HttpStatus.OK).json({
        conversation_id: result.conversationId,
        message_id: result.messageId,
      });
    } catch (err) {
      return fail(res, err);
    }
  }

  @Post('comments/:id/hide')
  async hide(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') commentId: string,
    @Body() body: { hidden?: boolean },
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      await this.comments.setHidden({
        accountId: account.accountId,
        accessToken: config.accessToken,
        commentId,
        hidden: body.hidden !== false,
      });
      return res.status(HttpStatus.OK).json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  }

  @Delete('comments/:id')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') commentId: string,
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      await this.comments.remove({
        accountId: account.accountId,
        accessToken: config.accessToken,
        commentId,
      });
      return res.status(HttpStatus.OK).json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  }
}

function fail(res: Response, err: unknown): Response {
  return res.status(HttpStatus.BAD_REQUEST).json({
    error: err instanceof Error ? err.message : 'Instagram request failed',
  });
}
