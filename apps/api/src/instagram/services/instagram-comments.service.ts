import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { InstagramIdentityService } from './instagram-identity.service';
import { CommentFunnelService } from './comment-funnel.service';
import {
  getMedia,
  getMediaComments,
  replyToComment,
  sendPrivateReply,
  setCommentHidden,
  deleteComment,
  listMedia,
  setMediaCommentsEnabled,
} from '../ig-api.util';
import type { IgMedia as IgMediaSnapshot } from '../ig-api.util';
import type { IgCommentValue } from '../types/webhook.types';

/**
 * Meta allows exactly one private reply per comment, and only within
 * 7 days of it being posted. Both are enforced before the API call so
 * an agent gets a clear reason rather than a raw Graph error.
 */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `resolve` is the odd one out — it is local bookkeeping, not a Meta
 * call. See `markResolved`.
 */
export type BulkModerationAction = 'hide' | 'unhide' | 'delete' | 'resolve';

export interface CommentIngestArgs {
  accountId: string;
  ownerUserId: string;
  igUserId: string;
  accessToken: string;
  field: string;
  value: IgCommentValue;
}

/**
 * Comment moderation and the comment → DM funnel.
 *
 * WHY COMMENTS ARE NOT CONVERSATIONS
 *   A comment is public, attached to a post, and has no thread of its
 *   own — modelling it as a `conversations` row would put public
 *   content in the private inbox and give every post a fake contact.
 *   `instagram_comments` is its own moderation queue.
 *
 *   A *private reply* is the bridge: it opens a real DM thread with
 *   someone who has never messaged the business, and that thread IS a
 *   conversation. The link is `private_reply_conversation_id`.
 */
@Injectable()
export class InstagramCommentsService {
  private readonly logger = new Logger(InstagramCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: InstagramIdentityService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly automationDispatch: AutomationDispatchService,
    private readonly commentFunnel: CommentFunnelService,
  ) {}

  // ------------------------------------------------------------
  // Ingest
  // ------------------------------------------------------------

  async ingestWebhookComment(args: CommentIngestArgs): Promise<void> {
    // `mentions` is subscribed because it shares the comments webhook
    // shape, but a mention is not a comment on our own media and does
    // not belong in the moderation queue.
    if (args.field !== 'comments' && args.field !== 'live_comments') {
      this.logger.debug(`Ignoring Instagram ${args.field} event`);
      return;
    }

    const value = args.value;
    if (!value?.id) return;

    const fromId = value.from?.id;
    // The account's own comments arrive on the same webhook. They must
    // be stored (so a reply shows as handled) but never queued as work.
    const isFromBusiness = !!fromId && fromId === args.igUserId;

    // Link to a contact when the commenter is already known, so the
    // Comments view can show their history. Never create one — a
    // comment is not consent to be in someone's CRM, and creating a
    // contact per commenter would flood the database on a viral post.
    let contactId: string | null = null;
    if (fromId && !isFromBusiness) {
      const existing = await this.prisma.contacts.findFirst({
        where: { account_id: args.accountId, ig_scoped_id: fromId },
        select: { id: true },
      });
      contactId = existing?.id ?? null;
    }

    const commentedAt = value.timestamp
      ? new Date(
          typeof value.timestamp === 'string'
            ? Number(value.timestamp) || Date.parse(value.timestamp)
            : value.timestamp,
        )
      : new Date();

    const record = {
      ig_media_id: value.media?.id ?? '',
      parent_comment_id: value.parent_id ?? null,
      from_igsid: fromId ?? null,
      from_username: value.from?.username ?? null,
      contact_id: contactId,
      text: value.text ?? null,
      is_from_business: isFromBusiness,
      status: isFromBusiness ? 'replied' : 'open',
      commented_at: Number.isNaN(commentedAt.getTime())
        ? new Date()
        : commentedAt,
    };

    // Upsert, because Meta redelivers. The unique key is
    // (account_id, ig_comment_id).
    const commentRow = await this.prisma.instagram_comments.upsert({
      where: {
        account_id_ig_comment_id: {
          account_id: args.accountId,
          ig_comment_id: value.id,
        },
      },
      create: {
        account_id: args.accountId,
        ig_comment_id: value.id,
        ...record,
      },
      // Only the mutable parts. Never overwrite a status an agent has
      // already moved to 'hidden' or 'replied'.
      update: { text: record.text, from_username: record.from_username },
      select: { id: true },
    });

    if (isFromBusiness) return;

    void this.webhookDeliver.dispatchWebhookEvent(
      args.accountId,
      'instagram.comment.created',
      {
        comment_id: value.id,
        media_id: value.media?.id,
        from_username: value.from?.username,
        text: value.text,
        contact_id: contactId,
      },
    );

    // Comment → DM funnels. Deliberately OUTSIDE the `if (contactId)`
    // below: a first-time commenter has no contact row, and that is
    // exactly who this feature is for. Awaited rather than
    // fire-and-forget so the funnel has claimed the comment's single
    // private reply before any automation can spend it.
    const claimedByFunnel = await this.commentFunnel.onComment({
      accountId: args.accountId,
      ownerUserId: args.ownerUserId,
      igUserId: args.igUserId,
      accessToken: args.accessToken,
      commentRowId: commentRow.id,
      igCommentId: value.id,
      igMediaId: value.media?.id ?? null,
      fromIgsid: fromId ?? '',
      text: value.text ?? '',
    });

    // The older automation-based funnel. Only fires for commenters we
    // can match to a contact, because the automation engine is
    // contact-scoped.
    if (contactId && !claimedByFunnel) {
      this.automationDispatch
        .dispatch({
          accountId: args.accountId,
          // 'instagram_comment' — NOT 'keyword_match'. The builder creates
          // automations with trigger_type='instagram_comment'; dispatching
          // 'keyword_match' here means those automations never fire.
          triggerType: 'instagram_comment',
          contactId,
          context: {
            message_text: value.text ?? '',
            channel: 'instagram',
            ig_comment_id: value.id,
            ig_media_id: value.media?.id,
          },
        })
        .catch((err) =>
          this.logger.error(
            `[automations] Instagram comment dispatch failed: ${String(err)}`,
          ),
        );
    }
  }

  // ------------------------------------------------------------
  // Backfill
  // ------------------------------------------------------------

  /**
   * Pull existing comments for one post.
   *
   * Webhooks only cover comments made *after* connecting, so a business
   * that just onboarded sees an empty queue on posts full of comments.
   */
  async syncMediaComments(args: {
    accountId: string;
    igUserId: string;
    accessToken: string;
    mediaId: string;
  }): Promise<{ synced: number }> {
    const comments = await getMediaComments({
      mediaId: args.mediaId,
      accessToken: args.accessToken,
    });

    let synced = 0;
    for (const comment of comments) {
      const isFromBusiness = comment.fromId === args.igUserId;
      await this.prisma.instagram_comments.upsert({
        where: {
          account_id_ig_comment_id: {
            account_id: args.accountId,
            ig_comment_id: comment.id,
          },
        },
        create: {
          account_id: args.accountId,
          ig_comment_id: comment.id,
          ig_media_id: args.mediaId,
          parent_comment_id: comment.parentId ?? null,
          from_igsid: comment.fromId ?? null,
          from_username: comment.username ?? null,
          text: comment.text ?? null,
          is_from_business: isFromBusiness,
          status: comment.hidden
            ? 'hidden'
            : isFromBusiness
              ? 'replied'
              : 'open',
          commented_at: comment.timestamp
            ? new Date(comment.timestamp)
            : new Date(),
        },
        // Never clobber a status an agent set here — 'replied' and
        // 'deleted' have no remote equivalent to re-derive from, and a
        // re-sync that reset them would refill a queue somebody had
        // just cleared. Hidden is the one exception: it IS remote
        // state, so someone hiding a comment in the Instagram app
        // should show up here.
        update: {
          text: comment.text ?? null,
          from_username: comment.username ?? null,
          parent_comment_id: comment.parentId ?? null,
          ...(comment.hidden ? { status: 'hidden' } : {}),
        },
      });
      synced++;
    }

    return { synced };
  }

  /** Refresh the local post cache the Comments/Posts views read. */
  async syncMedia(args: {
    accountId: string;
    igUserId: string;
    accessToken: string;
    limit?: number;
  }): Promise<{ synced: number }> {
    const media = await listMedia({
      igUserId: args.igUserId,
      accessToken: args.accessToken,
      limit: args.limit,
    });

    for (const item of media) {
      await this.upsertMedia(args.accountId, item);
    }

    return { synced: media.length };
  }

  /**
   * Re-read ONE post from Meta.
   *
   * Likes and comment totals are a snapshot taken at sync time and go
   * stale immediately; nothing pushes a like count over a webhook. This
   * is the "these numbers look old" button, scoped to the post someone
   * is actually looking at rather than re-fetching the whole grid.
   *
   * Scoped through our own row first — the media id arrives from a
   * request path, and an unscoped fetch would let one tenant read
   * another tenant's post through our token.
   */
  async refreshMedia(args: {
    accountId: string;
    accessToken: string;
    mediaId: string;
  }) {
    const existing = await this.prisma.instagram_media.findFirst({
      where: { account_id: args.accountId, ig_media_id: args.mediaId },
      select: { ig_media_id: true },
    });
    if (!existing) throw new Error('Post not found');

    const item = await getMedia({
      mediaId: existing.ig_media_id,
      accessToken: args.accessToken,
    });

    return this.upsertMedia(args.accountId, item);
  }

  /**
   * Write one post to the local cache.
   *
   * Create and update need the same values, and drifting between the
   * two is how a column silently stops being refreshed — so the mutable
   * set is defined once, here.
   */
  private upsertMedia(accountId: string, item: IgMediaSnapshot) {
    const mutable = {
      media_type: item.mediaType ?? null,
      media_product_type: item.mediaProductType ?? null,
      permalink: item.permalink ?? null,
      thumbnail_url: item.thumbnailUrl ?? null,
      media_url: item.mediaUrl ?? null,
      caption: item.caption ?? null,
      like_count: item.likeCount ?? null,
      comments_count: item.commentsCount ?? null,
      is_comment_enabled: item.isCommentEnabled ?? null,
      // `undefined` (leave alone), never `null` — a post whose carousel
      // children Meta omitted this time should keep the ones we already
      // have rather than blank the tile.
      children: item.children?.length
        ? (item.children as unknown as Prisma.InputJsonValue)
        : undefined,
    };

    return this.prisma.instagram_media.upsert({
      where: {
        account_id_ig_media_id: {
          account_id: accountId,
          ig_media_id: item.id,
        },
      },
      create: {
        account_id: accountId,
        ig_media_id: item.id,
        ...mutable,
        posted_at: item.timestamp ? new Date(item.timestamp) : null,
      },
      update: { ...mutable, synced_at: new Date() },
    });
  }

  /**
   * Backfill comments for every synced post.
   *
   * One button instead of N, because "pull in the backlog" is a
   * whole-account intent — nobody wants to click sync on forty tiles.
   * Failures are counted, not thrown: one post with revoked access
   * must not abort the other thirty-nine.
   *
   * Capped at the 50 most recent posts, and the cap is reported back as
   * `posts` so the UI can say what it actually covered. This is one
   * Graph call per post inside one HTTP request — an uncapped sweep of
   * a years-old account would sit past the proxy's timeout and return
   * a 504 having done most of the work invisibly.
   */
  async syncAllMediaComments(args: {
    accountId: string;
    igUserId: string;
    accessToken: string;
  }): Promise<{ synced: number; posts: number; failed: number }> {
    const media = await this.prisma.instagram_media.findMany({
      where: { account_id: args.accountId },
      select: { ig_media_id: true },
      orderBy: { posted_at: 'desc' },
      take: 50,
    });

    let synced = 0;
    let failed = 0;
    for (const item of media) {
      try {
        const result = await this.syncMediaComments({
          accountId: args.accountId,
          igUserId: args.igUserId,
          accessToken: args.accessToken,
          mediaId: item.ig_media_id,
        });
        synced += result.synced;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Comment backfill failed for media ${item.ig_media_id}: ${String(err)}`,
        );
      }
    }

    return { synced, posts: media.length, failed };
  }

  /**
   * Turn commenting on or off for a post.
   *
   * Scoped through our own `instagram_media` row first, for the same
   * reason `requireComment` exists: the media id arrives from a request
   * path and an unscoped call would let one tenant silence another
   * tenant's post.
   */
  async setCommentsEnabled(args: {
    accountId: string;
    accessToken: string;
    mediaId: string;
    enabled: boolean;
  }): Promise<void> {
    const media = await this.prisma.instagram_media.findFirst({
      where: { account_id: args.accountId, ig_media_id: args.mediaId },
      select: { id: true, ig_media_id: true },
    });
    if (!media) throw new Error('Post not found');

    await setMediaCommentsEnabled({
      mediaId: media.ig_media_id,
      accessToken: args.accessToken,
      enabled: args.enabled,
    });

    await this.prisma.instagram_media.update({
      where: { id: media.id },
      data: { is_comment_enabled: args.enabled },
    });
  }

  // ------------------------------------------------------------
  // Moderation actions
  // ------------------------------------------------------------

  /** Public reply, visible under the post. */
  async replyPublicly(args: {
    accountId: string;
    accessToken: string;
    commentId: string;
    message: string;
  }): Promise<{ id: string }> {
    const comment = await this.requireComment(args.accountId, args.commentId);

    const result = await replyToComment({
      commentId: comment.ig_comment_id,
      accessToken: args.accessToken,
      message: args.message,
    });

    await this.prisma.instagram_comments.update({
      where: { id: comment.id },
      data: { status: 'replied', replied_at: new Date() },
    });

    void this.webhookDeliver.dispatchWebhookEvent(
      args.accountId,
      'instagram.comment.replied',
      {
        comment_id: comment.ig_comment_id,
        reply_id: result.id,
        kind: 'public',
      },
    );

    return result;
  }

  /**
   * Reply privately, opening a DM thread with the commenter.
   *
   * This is the growth mechanic — "comment BUY and I'll DM you the
   * link". It is also the only way to start a conversation with
   * someone who has never messaged the business.
   *
   * Both of Meta's limits are checked locally first, because both
   * produce opaque Graph errors and both are permanent for that
   * comment: one reply ever, within 7 days.
   */
  async replyPrivately(args: {
    accountId: string;
    ownerUserId: string;
    igUserId: string;
    accessToken: string;
    commentId: string;
    message: string;
  }): Promise<{ conversationId: string | null; messageId: string }> {
    const comment = await this.requireComment(args.accountId, args.commentId);

    if (comment.private_replied_at) {
      throw new Error(
        'Instagram allows only one private reply per comment, and this comment already has one.',
      );
    }

    const commentedAt = comment.commented_at ?? comment.created_at;
    if (Date.now() - commentedAt.getTime() > PRIVATE_REPLY_WINDOW_MS) {
      throw new Error(
        'This comment is more than 7 days old — Instagram no longer allows a private reply to it.',
      );
    }

    if (comment.is_from_business) {
      throw new Error('Cannot send a private reply to your own comment.');
    }

    const result = await sendPrivateReply({
      igUserId: args.igUserId,
      accessToken: args.accessToken,
      commentId: comment.ig_comment_id,
      text: args.message,
    });

    // The private reply just created a thread with someone who may not
    // be a contact yet. Materialise both so the DM lands in the inbox
    // instead of appearing out of nowhere when they answer.
    let conversationId: string | null = null;
    if (comment.from_igsid) {
      const contactOutcome = await this.identity.findOrCreateContact({
        accountId: args.accountId,
        ownerUserId: args.ownerUserId,
        igsid: comment.from_igsid,
        accessToken: args.accessToken,
        knownUsername: comment.from_username ?? undefined,
      });

      if (contactOutcome) {
        const convOutcome = await this.identity.findOrCreateConversation({
          accountId: args.accountId,
          ownerUserId: args.ownerUserId,
          contactId: contactOutcome.contact.id,
        });

        if (convOutcome) {
          conversationId = convOutcome.conversation.id;

          await this.prisma.messages.create({
            data: {
              conversation_id: conversationId,
              sender_type: 'agent',
              content_type: 'text',
              content_text: args.message,
              message_id: result.messageId || null,
              status: 'sent',
              metadata: {
                ig_private_reply_to_comment: comment.ig_comment_id,
              },
            },
          });

          await this.prisma.conversations.update({
            where: { id: conversationId },
            data: {
              last_message_text: args.message,
              last_message_at: new Date(),
              updated_at: new Date(),
            },
          });

          // Backfill the contact link now that we have one.
          if (!comment.contact_id) {
            await this.prisma.instagram_comments.update({
              where: { id: comment.id },
              data: { contact_id: contactOutcome.contact.id },
            });
          }
        }
      }
    }

    await this.prisma.instagram_comments.update({
      where: { id: comment.id },
      data: {
        private_replied_at: new Date(),
        private_reply_conversation_id: conversationId,
        status: comment.status === 'open' ? 'replied' : comment.status,
        replied_at: comment.replied_at ?? new Date(),
      },
    });

    void this.webhookDeliver.dispatchWebhookEvent(
      args.accountId,
      'instagram.comment.replied',
      {
        comment_id: comment.ig_comment_id,
        kind: 'private',
        conversation_id: conversationId,
      },
    );

    return { conversationId, messageId: result.messageId };
  }

  async setHidden(args: {
    accountId: string;
    accessToken: string;
    commentId: string;
    hidden: boolean;
  }): Promise<void> {
    const comment = await this.requireComment(args.accountId, args.commentId);

    await setCommentHidden({
      commentId: comment.ig_comment_id,
      accessToken: args.accessToken,
      hidden: args.hidden,
    });

    await this.prisma.instagram_comments.update({
      where: { id: comment.id },
      data: { status: args.hidden ? 'hidden' : 'open' },
    });
  }

  /**
   * Delete at Instagram, tombstone locally.
   *
   * The row is kept deliberately: "who deleted what, and when" is
   * moderation history a business may need, and losing it on delete
   * makes the queue untrustworthy.
   */
  async remove(args: {
    accountId: string;
    accessToken: string;
    commentId: string;
  }): Promise<void> {
    const comment = await this.requireComment(args.accountId, args.commentId);

    await deleteComment({
      commentId: comment.ig_comment_id,
      accessToken: args.accessToken,
    });

    await this.prisma.instagram_comments.update({
      where: { id: comment.id },
      data: { status: 'deleted' },
    });
  }

  /**
   * Apply one moderation action to many comments.
   *
   * Sequential, not `Promise.all`: these are writes against Meta's API
   * and firing fifty at once is the fastest way to get rate-limited
   * into a partial, unrepeatable state. Per-comment failures are
   * collected rather than thrown so a spam sweep reports "38 hidden,
   * 2 failed" instead of dying on the third row and leaving the agent
   * unsure what actually happened.
   */
  async bulkModerate(args: {
    accountId: string;
    accessToken: string;
    commentIds: string[];
    action: BulkModerationAction;
  }): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    // Purely local — no Meta call, so it can be one statement instead of
    // a loop. See `markResolved` for why this action exists at all.
    if (args.action === 'resolve') {
      return this.markResolved(args.accountId, args.commentIds);
    }

    let succeeded = 0;
    const errors: string[] = [];

    for (const commentId of args.commentIds) {
      try {
        if (args.action === 'delete') {
          await this.remove({
            accountId: args.accountId,
            accessToken: args.accessToken,
            commentId,
          });
        } else {
          await this.setHidden({
            accountId: args.accountId,
            accessToken: args.accessToken,
            commentId,
            hidden: args.action === 'hide',
          });
        }
        succeeded++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Request failed');
      }
    }

    return {
      succeeded,
      failed: errors.length,
      // Only the distinct reasons — fifty copies of the same permission
      // error is not more informative than one.
      errors: [...new Set(errors)].slice(0, 3),
    };
  }

  /**
   * Clear comments out of the queue without touching Instagram.
   *
   * WHY THIS IS NOT A META CALL
   *   `open` means "we still owe this person something", which is our
   *   bookkeeping, not Meta's — Instagram has no concept of a handled
   *   comment. Plenty of comments get answered in the Instagram app, or
   *   need no answer at all ("🔥🔥"), and without this they sit in the
   *   queue forever and the tab count stops meaning anything. Hiding or
   *   deleting them would be a public, destructive way to fix a private
   *   bookkeeping problem.
   *
   * Deliberately does NOT move 'hidden' or 'deleted' rows: those are
   * remote states, and quietly relabelling them 'replied' would lose
   * the record of what was actually done to a comment.
   */
  private async markResolved(
    accountId: string,
    commentIds: string[],
  ): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    const now = new Date();
    const result = await this.prisma.instagram_comments.updateMany({
      where: {
        account_id: accountId,
        status: 'open',
        OR: [
          { id: { in: commentIds.filter(isUuid) } },
          { ig_comment_id: { in: commentIds } },
        ],
      },
      data: { status: 'replied', replied_at: now },
    });

    return {
      succeeded: result.count,
      // Rows that were already handled are not a failure — asking to
      // resolve an already-resolved comment is a no-op, not an error.
      failed: 0,
      errors: [],
    };
  }

  // ------------------------------------------------------------

  /**
   * Load a comment, scoped to the account. Every mutation goes through
   * this — the `commentId` reaching these methods comes from a request
   * body, so an unscoped lookup would let one tenant moderate
   * another's comments.
   */
  private async requireComment(accountId: string, commentId: string) {
    const comment = await this.prisma.instagram_comments.findFirst({
      where: {
        account_id: accountId,
        // Accept either our row id or Instagram's, so the UI can pass
        // whichever it has.
        OR: [
          { id: isUuid(commentId) ? commentId : undefined },
          { ig_comment_id: commentId },
        ],
      },
    });
    if (!comment) throw new Error('Comment not found');
    return comment;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
