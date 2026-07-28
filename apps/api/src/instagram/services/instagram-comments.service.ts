import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { InstagramIdentityService } from './instagram-identity.service';
import {
  getMediaComments,
  replyToComment,
  sendPrivateReply,
  setCommentHidden,
  deleteComment,
  listMedia,
} from '../ig-api.util';
import type { IgCommentValue } from '../types/webhook.types';

/**
 * Meta allows exactly one private reply per comment, and only within
 * 7 days of it being posted. Both are enforced before the API call so
 * an agent gets a clear reason rather than a raw Graph error.
 */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
    await this.prisma.instagram_comments.upsert({
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

    // The comment → DM funnel. Only fires for commenters we can match
    // to a contact, because the automation engine is contact-scoped.
    if (contactId) {
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
        update: { text: comment.text ?? null },
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
      await this.prisma.instagram_media.upsert({
        where: {
          account_id_ig_media_id: {
            account_id: args.accountId,
            ig_media_id: item.id,
          },
        },
        create: {
          account_id: args.accountId,
          ig_media_id: item.id,
          media_type: item.mediaType ?? null,
          media_product_type: item.mediaProductType ?? null,
          permalink: item.permalink ?? null,
          thumbnail_url: item.thumbnailUrl ?? null,
          caption: item.caption ?? null,
          posted_at: item.timestamp ? new Date(item.timestamp) : null,
        },
        update: {
          permalink: item.permalink ?? null,
          thumbnail_url: item.thumbnailUrl ?? null,
          caption: item.caption ?? null,
          synced_at: new Date(),
        },
      });
    }

    return { synced: media.length };
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
