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
import type { Prisma } from '@prisma/client';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramCommentsService } from '../services/instagram-comments.service';
import type { BulkModerationAction } from '../services/instagram-comments.service';
import { InstagramConnectService } from '../services/instagram-connect.service';

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

const BULK_ACTIONS: readonly BulkModerationAction[] = [
  'hide',
  'unhide',
  'delete',
  'resolve',
];

/** Guards against a client asking for 50 000 rows via `?limit=`. */
function pageSize(limit: string | undefined, fallback = DEFAULT_PAGE): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_PAGE);
}

function pageOffset(offset: string | undefined): number {
  const parsed = Number(offset);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

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

  /**
   * The moderation queue.
   *
   * Returns three things the UI cannot compute for itself:
   *   - `total`, so "showing 25 of 340" is honest and paging knows when
   *     to stop;
   *   - `counts`, the per-status tallies behind the tab labels — these
   *     have to be unfiltered by status or every tab would read the
   *     count of the tab you are already on;
   *   - `replies`, the answers already posted under each comment.
   *     Without them the queue can say a comment was handled but never
   *     what was said, which is exactly what an agent picking up
   *     someone else's work needs to know.
   */
  @Get('comments')
  async list(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('status') status: string | undefined,
    @Query('media_id') mediaId: string | undefined,
    @Query('q') q: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Res() res: Response,
  ) {
    const take = pageSize(limit, 50);
    const skip = pageOffset(offset);
    const search = q?.trim();

    // The business's own comments are stored for context but are never
    // moderation work — they surface as `replies`, never as rows.
    const baseWhere: Prisma.instagram_commentsWhereInput = {
      account_id: account.accountId,
      is_from_business: false,
      ...(mediaId ? { ig_media_id: mediaId } : {}),
    };

    const where: Prisma.instagram_commentsWhereInput = {
      ...baseWhere,
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { text: { contains: search, mode: 'insensitive' } },
              { from_username: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total, grouped] = await Promise.all([
      this.prisma.instagram_comments.findMany({
        where,
        orderBy: { commented_at: sort === 'oldest' ? 'asc' : 'desc' },
        take,
        skip,
      }),
      this.prisma.instagram_comments.count({ where }),
      // Tab counts. Deliberately ignores `status` and `q` — a tab whose
      // number changed every time you typed in the search box would be
      // useless for deciding which tab to open.
      this.prisma.instagram_comments.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const group of grouped) {
      counts[group.status] = group._count._all;
      counts.all += group._count._all;
    }

    // Two extra queries beat N+1 joins for a page of comments that
    // mostly point at a handful of posts.
    const mediaIds = [...new Set(rows.map((r) => r.ig_media_id))];
    const commentIds = rows.map((r) => r.ig_comment_id);

    const [media, replies, contacts, funnelRuns] = await Promise.all([
      this.prisma.instagram_media.findMany({
        where: {
          account_id: account.accountId,
          ig_media_id: { in: mediaIds },
        },
      }),
      this.prisma.instagram_comments.findMany({
        where: {
          account_id: account.accountId,
          parent_comment_id: { in: commentIds },
        },
        orderBy: { commented_at: 'asc' },
      }),
      this.loadContacts(
        account.accountId,
        rows.map((r) => r.contact_id),
      ),
      // Which of these comments a Comment Funnel already answered.
      // Without it the queue shows an enabled "Send DM" on a comment
      // whose single private reply the funnel has already spent — the
      // agent clicks, Meta refuses, and nothing explains why.
      this.prisma.instagram_comment_funnel_runs.findMany({
        where: {
          account_id: account.accountId,
          ig_comment_id: { in: commentIds },
        },
        select: {
          ig_comment_id: true,
          state: true,
          was_following: true,
          delivered_at: true,
          conversation_id: true,
          funnel: { select: { id: true, name: true } },
        },
      }),
    ]);

    const mediaByIgId = new Map(media.map((m) => [m.ig_media_id, m]));
    const funnelByCommentId = new Map(
      funnelRuns.map((run) => [run.ig_comment_id, run]),
    );
    const repliesByParent = new Map<string, typeof replies>();
    for (const reply of replies) {
      const parent = reply.parent_comment_id;
      if (!parent) continue;
      const bucket = repliesByParent.get(parent);
      if (bucket) bucket.push(reply);
      else repliesByParent.set(parent, [reply]);
    }

    return res.status(HttpStatus.OK).json({
      comments: rows.map((r) => ({
        ...r,
        media: mediaByIgId.get(r.ig_media_id) ?? null,
        replies: repliesByParent.get(r.ig_comment_id) ?? [],
        contact: r.contact_id ? (contacts.get(r.contact_id) ?? null) : null,
        funnel_run: funnelByCommentId.get(r.ig_comment_id) ?? null,
      })),
      total,
      counts,
      limit: take,
      offset: skip,
    });
  }

  /**
   * Published posts, with the moderation backlog attached.
   *
   * `open_comments` is computed here rather than tallied in the browser
   * because the client could only ever count the comments it had
   * fetched — a post with 300 waiting comments read as whatever fitted
   * in the last page.
   */
  @Get('media')
  async listMedia(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('q') q: string | undefined,
    @Query('type') type: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Res() res: Response,
  ) {
    const take = pageSize(limit, DEFAULT_PAGE);
    const skip = pageOffset(offset);
    const search = q?.trim();

    const where: Prisma.instagram_mediaWhereInput = {
      account_id: account.accountId,
      ...(search ? { caption: { contains: search, mode: 'insensitive' } } : {}),
      ...(type && type !== 'all'
        ? { media_product_type: type.toUpperCase() }
        : {}),
    };

    const orderBy: Prisma.instagram_mediaOrderByWithRelationInput =
      sort === 'oldest'
        ? { posted_at: 'asc' }
        : sort === 'likes'
          ? { like_count: { sort: 'desc', nulls: 'last' } }
          : sort === 'comments'
            ? { comments_count: { sort: 'desc', nulls: 'last' } }
            : { posted_at: 'desc' };

    const [media, total, openGroups, totals] = await Promise.all([
      this.prisma.instagram_media.findMany({ where, orderBy, take, skip }),
      this.prisma.instagram_media.count({ where }),
      this.prisma.instagram_comments.groupBy({
        by: ['ig_media_id'],
        where: {
          account_id: account.accountId,
          status: 'open',
          is_from_business: false,
        },
        _count: { _all: true },
      }),
      // Account-wide, not page-wide — the header summary must not move
      // when you page through the grid or type in the search box.
      this.prisma.instagram_media.aggregate({
        where: { account_id: account.accountId },
        _count: { _all: true },
        _sum: { like_count: true, comments_count: true },
      }),
    ]);

    const openByMedia = new Map(
      openGroups.map((g) => [g.ig_media_id, g._count._all]),
    );

    return res.status(HttpStatus.OK).json({
      media: media.map((m) => ({
        ...m,
        open_comments: openByMedia.get(m.ig_media_id) ?? 0,
      })),
      total,
      limit: take,
      offset: skip,
      stats: {
        posts: totals._count._all,
        open_comments: [...openByMedia.values()].reduce((a, b) => a + b, 0),
        likes: totals._sum.like_count ?? 0,
        comments: totals._sum.comments_count ?? 0,
      },
    });
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

  /** Backfill comments across every synced post, in one action. */
  @Post('media/comments/sync-all')
  async syncAllComments(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.syncAllMediaComments({
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

  /**
   * Re-read one post from Meta.
   *
   * Likes and comment totals are a sync-time snapshot that nothing
   * pushes updates for, so the detail panel needs a way to refresh the
   * post being looked at without re-syncing the whole grid.
   */
  @Post('media/:mediaId/refresh')
  async refreshMedia(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      const media = await this.comments.refreshMedia({
        accountId: account.accountId,
        accessToken: config.accessToken,
        mediaId,
      });

      const open = await this.prisma.instagram_comments.count({
        where: {
          account_id: account.accountId,
          ig_media_id: media.ig_media_id,
          status: 'open',
          is_from_business: false,
        },
      });

      // Same shape as a row from `GET media`, so the client can swap it
      // straight into the list it already has.
      return res
        .status(HttpStatus.OK)
        .json({ media: { ...media, open_comments: open } });
    } catch (err) {
      return fail(res, err);
    }
  }

  /** Turn commenting on or off for one post. */
  @Post('media/:mediaId/comment-settings')
  async setCommentSettings(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('mediaId') mediaId: string,
    @Body() body: { enabled?: boolean },
    @Res() res: Response,
  ) {
    try {
      const config = await this.requireToken(account.accountId);
      await this.comments.setCommentsEnabled({
        accountId: account.accountId,
        accessToken: config.accessToken,
        mediaId,
        enabled: body.enabled !== false,
      });
      return res.status(HttpStatus.OK).json({ ok: true });
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

  /**
   * One action, many comments — the spam-sweep path.
   *
   * Partial success is the normal case (Meta rejects individual
   * comments for reasons we cannot predict), so this answers 200 with a
   * tally rather than failing the whole request on the first error.
   */
  @Post('comments/bulk')
  async bulk(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { ids?: string[]; action?: string },
    @Res() res: Response,
  ) {
    const ids = (body.ids ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const action = body.action;

    if (!ids.length) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'ids is required' });
    }
    if (ids.length > MAX_PAGE) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: `At most ${MAX_PAGE} comments at a time.` });
    }
    if (!BULK_ACTIONS.includes(action as BulkModerationAction)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: `action must be one of: ${BULK_ACTIONS.join(', ')}`,
      });
    }

    try {
      const config = await this.requireToken(account.accountId);
      const result = await this.comments.bulkModerate({
        accountId: account.accountId,
        accessToken: config.accessToken,
        commentIds: ids,
        action: action as BulkModerationAction,
      });
      return res.status(HttpStatus.OK).json(result);
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

  // ------------------------------------------------------------

  /**
   * Resolve the contacts behind a page of comments, so a known
   * commenter links to their CRM record instead of being an anonymous
   * @handle. Account-scoped, because `contact_id` is a foreign key we
   * are about to hand back to the browser.
   */
  private async loadContacts(
    accountId: string,
    ids: (string | null)[],
  ): Promise<Map<string, { id: string; name: string | null }>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map();

    const contacts = await this.prisma.contacts.findMany({
      where: { account_id: accountId, id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(contacts.map((c) => [c.id, c]));
  }
}

function fail(res: Response, err: unknown): Response {
  return res.status(HttpStatus.BAD_REQUEST).json({
    error: err instanceof Error ? err.message : 'Instagram request failed',
  });
}
