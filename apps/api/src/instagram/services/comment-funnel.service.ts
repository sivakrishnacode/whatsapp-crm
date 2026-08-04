import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { instagram_comment_funnels } from '@prisma/client';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { InstagramConnectService } from './instagram-connect.service';
import { InstagramSendService } from './instagram-send.service';
import {
  getUserProfile,
  sendPrivateReply,
  replyToComment,
} from '../ig-api.util';

/**
 * Button payload prefix. Namespaced because the same
 * `messaging_postbacks` webhook carries flow buttons, automation
 * buttons and ice-breakers — the prefix is how the funnel recognises
 * its own taps without claiming somebody else's.
 */
const PAYLOAD_PREFIX = 'c2dm';

/** Delayed opening DMs. See `reply_delay_seconds`. */
export const IG_FUNNEL_QUEUE = 'ig-comment-funnel';

export type FunnelStep = 'optin' | 'followed';

/**
 * A parked opening DM.
 *
 * Ids only — deliberately no access token. A delayed job sits in Redis
 * for up to an hour, and a decrypted long-lived Instagram token in a
 * queue payload is a credential at rest in a place nobody is auditing.
 * The worker re-reads and re-decrypts it at send time, which also means
 * a token refreshed during the wait is the one that gets used.
 */
export interface FunnelOptinJob {
  runId: string;
  accountId: string;
  commentRowId: string;
  igCommentId: string;
}

/** What `sendOptin` needs, whether it runs inline or from the worker. */
interface OptinSendArgs {
  accountId: string;
  igUserId: string;
  accessToken: string;
  commentRowId: string;
  igCommentId: string;
}

export interface FunnelCommentArgs {
  accountId: string;
  ownerUserId: string;
  igUserId: string;
  accessToken: string;
  /** Row id in `instagram_comments`, already upserted by the caller. */
  commentRowId: string;
  igCommentId: string;
  igMediaId: string | null;
  fromIgsid: string;
  text: string;
}

export interface FunnelPostbackArgs {
  accountId: string;
  ownerUserId: string;
  accessToken: string;
  contactId: string;
  conversationId: string;
  fromIgsid: string;
  /** The raw postback / quick-reply payload. */
  payload: string;
}

/**
 * Comment → DM funnels with a soft follow gate.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 *   comment → private reply (+button) → tap → [follow gate] → reward.
 *
 *   The opening "tap below" message looks like a growth-hack tic. It
 *   is not. Meta's User Profile API refuses to answer for someone who
 *   has only commented — a comment is not consent — so
 *   `is_user_follow_business` is unavailable until they send something.
 *   That first button exists to manufacture the inbound event which
 *   unlocks the lookup. Remove it and the gate cannot be evaluated at
 *   all.
 *
 * SOFT GATE
 *   The reward ships whether or not they actually followed. So there is
 *   no re-check, no loop, and no terminal "refused" state — a tap on
 *   "I followed you" delivers, full stop. `was_following` records what
 *   we saw for reporting, and is never control flow twice.
 *
 *   This is why every follow-status failure fails OPEN (see
 *   `resolveFollowState`): under a soft gate, a lookup error that
 *   withheld the reward would be strictly worse than not checking.
 *
 * WHY IT IS NOT AN AUTOMATION
 *   `automations` dispatch on a contact id, and
 *   instagram-comments.service deliberately never creates a contact
 *   from a comment. So the audience this feature exists for — people
 *   who have never messaged the business — is precisely the audience
 *   the automations engine cannot see.
 *
 * NEVER THROWS ON THE WEBHOOK PATH
 *   Both entry points are called fire-and-forget from webhook handling
 *   that has already answered Meta. An exception here would be
 *   invisible, so failures are logged and parked on the run row
 *   (`state='failed'`, `last_error`) where the funnel's stats panel can
 *   show them.
 *
 * THE DELAY IS A QUEUE, NOT A SLEEP
 *   `reply_delay_seconds` parks the opening DM on a delayed BullMQ job.
 *   Sleeping on the webhook path would hold a request Meta has already
 *   been answered on, and lose every pending reply on a deploy. The
 *   run row is still created synchronously, before the job — it is what
 *   claims the comment, and the delay must not open a window where two
 *   funnels both think they have it.
 */
@Injectable()
export class CommentFunnelService {
  private readonly logger = new Logger(CommentFunnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly send: InstagramSendService,
    private readonly connect: InstagramConnectService,
    @InjectQueue(IG_FUNNEL_QUEUE) private readonly queue: Queue,
  ) {}

  // ------------------------------------------------------------
  // Entry 1 — a comment arrives
  // ------------------------------------------------------------

  /**
   * Match the comment to a funnel and open the DM.
   *
   * Called for EVERY inbound comment, including from people with no
   * contact row — which is the whole point, and the one thing the
   * automation dispatch alongside it cannot do.
   *
   * Returns true when a funnel claimed this comment, so the caller can
   * suppress the older `instagram_comment` automation trigger. Both
   * fire on the same webhook, and a commenter who happens to already be
   * a contact would otherwise get two unrelated DMs about one comment.
   */
  async onComment(args: FunnelCommentArgs): Promise<boolean> {
    try {
      if (!(await this.isEnabledForAccount(args.accountId))) return false;

      const funnel = await this.matchFunnel(
        args.accountId,
        args.igMediaId,
        args.text,
      );
      if (!funnel) return false;

      // Meta allows exactly one private reply per comment. The column is
      // the authority for the manual path too, so checking it here keeps
      // both honest about the same budget.
      const comment = await this.prisma.instagram_comments.findUnique({
        where: { id: args.commentRowId },
        select: { private_replied_at: true },
      });
      if (comment?.private_replied_at) return false;

      // The run row is created BEFORE the send, because its id is the
      // button payload. Creating it afterwards would mean sending a
      // button that addresses a row which does not exist yet — and the
      // tap can beat our own write back.
      //
      // The unique index on (funnel_id, from_igsid) is what makes a
      // repeat commenter get one DM rather than one per comment. A
      // P2002 here is that guarantee working, not an error.
      let run: { id: string };
      try {
        run = await this.prisma.instagram_comment_funnel_runs.create({
          data: {
            account_id: args.accountId,
            funnel_id: funnel.id,
            ig_comment_id: args.igCommentId,
            from_igsid: args.fromIgsid,
            state: 'awaiting_optin',
          },
          select: { id: true },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          this.logger.debug(
            `Funnel ${funnel.id} already ran for ${args.fromIgsid} — skipping`,
          );
          // Claimed: this person is already in this funnel. Letting an
          // automation answer their second comment would undo the
          // one-DM-per-person guarantee the index just enforced.
          return true;
        }
        throw err;
      }

      // Claimed either way from here — the run row exists. A delayed
      // funnel returns before sending anything, which is precisely why
      // the claim had to happen above it.
      if (funnel.reply_delay_seconds > 0) {
        await this.scheduleOptin(run.id, funnel, args);
      } else {
        await this.sendOptin(run.id, funnel, args);
      }

      return true;
    } catch (err) {
      this.logger.error(
        `Funnel onComment failed for comment ${args.igCommentId}: ${String(err)}`,
      );
      // Unclaimed: we do not know how far we got, and leaving the
      // automation path open is the less surprising of the two failures.
      return false;
    }
  }

  // ------------------------------------------------------------
  // The opening DM — inline, or an hour later
  // ------------------------------------------------------------

  /**
   * Park the opening DM on the delay queue.
   *
   * Falls back to sending immediately when the enqueue fails. A dropped
   * job means someone commented, was claimed, and never heard back —
   * strictly worse than a DM that arrives sooner than configured.
   */
  private async scheduleOptin(
    runId: string,
    funnel: instagram_comment_funnels,
    args: OptinSendArgs,
  ): Promise<void> {
    const job: FunnelOptinJob = {
      runId,
      accountId: args.accountId,
      commentRowId: args.commentRowId,
      igCommentId: args.igCommentId,
    };

    try {
      await this.queue.add('optin', job, {
        delay: funnel.reply_delay_seconds * 1000,
        // One job per run, forever. BullMQ rejects a duplicate jobId
        // while the job is live, which makes a retried webhook delivery
        // for the same comment a no-op rather than a second DM.
        jobId: `optin:${runId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        // Kept, briefly: a funnel whose sends are failing is diagnosable
        // from the queue before the run rows are the only evidence.
        removeOnFail: 100,
      });
    } catch (err) {
      this.logger.warn(
        `Could not schedule funnel run ${runId} (${String(err)}) — sending now instead`,
      );
      await this.sendOptin(runId, funnel, args);
    }
  }

  /**
   * Worker entry point for a delayed run.
   *
   * Everything the delay made stale is re-checked here: the funnel may
   * have been paused or deleted, the account switched off, the token
   * expired, or an agent may have spent the comment's one private reply
   * by hand while the job sat in Redis.
   */
  async runDelayedOptin(job: FunnelOptinJob): Promise<void> {
    const run = await this.prisma.instagram_comment_funnel_runs.findFirst({
      where: { id: job.runId, account_id: job.accountId },
      include: { funnel: true },
    });

    // Deleted funnel, deleted run, or a tap that already advanced it.
    // Silent: none of these are faults, they are the delay working.
    if (!run) return;
    if (run.state !== 'awaiting_optin') return;

    if (!run.funnel.is_active) {
      await this.fail(
        run.id,
        new Error('Funnel was paused before the DM went out'),
      );
      return;
    }
    if (!(await this.isEnabledForAccount(job.accountId))) {
      await this.fail(
        run.id,
        new Error('Comment funnels were switched off before the DM went out'),
      );
      return;
    }

    const comment = await this.prisma.instagram_comments.findUnique({
      where: { id: job.commentRowId },
      select: { private_replied_at: true },
    });
    if (comment?.private_replied_at) {
      await this.fail(
        run.id,
        new Error('The comment’s one private reply was already spent'),
      );
      return;
    }

    const config = await this.connect.loadUsableConfig(job.accountId);
    if (!config) {
      await this.fail(
        run.id,
        new Error('No usable Instagram connection when the delay elapsed'),
      );
      return;
    }

    await this.sendOptin(run.id, run.funnel, {
      accountId: job.accountId,
      igUserId: config.igUserId,
      accessToken: config.accessToken,
      commentRowId: job.commentRowId,
      igCommentId: job.igCommentId,
    });
  }

  /**
   * Private-reply with the opening button, then spend the budget and
   * post the public reply.
   *
   * Never throws: a send failure is parked on the run row. The caller
   * has already claimed the comment and cannot un-claim it.
   */
  private async sendOptin(
    runId: string,
    funnel: instagram_comment_funnels,
    args: OptinSendArgs,
  ): Promise<void> {
    try {
      await sendPrivateReply({
        igUserId: args.igUserId,
        accessToken: args.accessToken,
        commentId: args.igCommentId,
        text: funnel.optin_text,
        quickReplies: [
          {
            title: funnel.optin_button_label,
            payload: `${PAYLOAD_PREFIX}:${runId}:optin`,
          },
        ],
      });
    } catch (err) {
      await this.fail(runId, err);
      return;
    }

    // Spend the comment's single private reply, and record the send
    // even though there is no conversation to hang a message on yet —
    // the thread materialises when they tap.
    await this.prisma.instagram_comments.update({
      where: { id: args.commentRowId },
      data: { private_replied_at: new Date(), updated_at: new Date() },
    });

    await this.prisma.instagram_comment_funnels.update({
      where: { id: funnel.id },
      data: { matched_count: { increment: 1 } },
    });

    // The public "check your DMs" reply, rotated across the configured
    // variants. Non-fatal on purpose: the DM is the deliverable, and a
    // failed public comment must not roll back a private reply that has
    // already been spent.
    const publicReply = pickPublicReply(
      funnel.public_reply_texts,
      funnel.matched_count,
    );
    if (publicReply) {
      try {
        await replyToComment({
          accessToken: args.accessToken,
          commentId: args.igCommentId,
          message: publicReply,
        });
      } catch (err) {
        this.logger.warn(
          `Funnel public reply failed (non-fatal): ${String(err)}`,
        );
      }
    }
  }

  // ------------------------------------------------------------
  // Entry 2 — they tapped a button
  // ------------------------------------------------------------

  /**
   * Advance the machine. Returns true when this tap belonged to a
   * funnel, so the caller can stop flows, automations and the AI bot
   * from also answering it.
   */
  async onPostback(args: FunnelPostbackArgs): Promise<boolean> {
    const parsed = parsePayload(args.payload);
    if (!parsed) return false;

    try {
      const run = await this.prisma.instagram_comment_funnel_runs.findFirst({
        where: { id: parsed.runId, account_id: args.accountId },
        include: { funnel: true },
      });

      // A payload we recognise but cannot resolve is still ours — say so
      // rather than letting a flow answer a half-finished funnel.
      if (!run) return true;
      if (run.state === 'delivered' || run.state === 'failed') return true;

      // Attach the thread the tap created. Not known until now: the
      // contact and conversation are minted by the messaging webhook,
      // not by the comment.
      await this.prisma.instagram_comment_funnel_runs.update({
        where: { id: run.id },
        data: {
          contact_id: args.contactId,
          conversation_id: args.conversationId,
          updated_at: new Date(),
        },
      });

      if (parsed.step === 'optin') {
        await this.handleOptin(run.id, run.funnel, args);
        return true;
      }

      // 'followed' — soft gate, so their word is good enough. Deliver
      // without re-checking: a second lookup could only produce a false
      // negative (follow status lags by seconds) and cost a conversion
      // the gate was never meant to block.
      await this.deliver(run.id, run.funnel, args);
      return true;
    } catch (err) {
      this.logger.error(
        `Funnel onPostback failed for run ${parsed.runId}: ${String(err)}`,
      );
      await this.fail(parsed.runId, err);
      // Still ours. Handing a failed funnel tap to the AI bot would
      // produce a confident non-sequitur on top of a broken funnel.
      return true;
    }
  }

  // ------------------------------------------------------------
  // Steps
  // ------------------------------------------------------------

  private async handleOptin(
    runId: string,
    funnel: instagram_comment_funnels,
    args: FunnelPostbackArgs,
  ): Promise<void> {
    if (!funnel.follow_gate_enabled) {
      await this.deliver(runId, funnel, args);
      return;
    }

    const following = await this.resolveFollowState(
      args.fromIgsid,
      args.accessToken,
    );

    await this.prisma.instagram_comment_funnel_runs.update({
      where: { id: runId },
      data: { was_following: following.known ? following.value : null },
    });

    // Already a follower — asking them to follow reads as broken, and
    // is the fastest way to make the whole funnel feel automated.
    if (following.value) {
      await this.deliver(runId, funnel, args);
      return;
    }

    await this.send.sendButtons({
      accountId: args.accountId,
      conversationId: args.conversationId,
      text: funnel.follow_ask_text ?? '',
      buttons: [
        {
          id: `${PAYLOAD_PREFIX}:${runId}:followed`,
          title: funnel.follow_button_label,
        },
      ],
    });

    await this.prisma.instagram_comment_funnel_runs.update({
      where: { id: runId },
      data: { state: 'awaiting_follow', updated_at: new Date() },
    });
  }

  private async deliver(
    runId: string,
    funnel: instagram_comment_funnels,
    args: FunnelPostbackArgs,
  ): Promise<void> {
    const buttons = parseRewardButtons(funnel.reward_buttons);

    if (buttons.length > 0) {
      await this.send.sendLinkButtons({
        accountId: args.accountId,
        conversationId: args.conversationId,
        text: funnel.reward_text,
        buttons,
      });
    } else {
      await this.send.sendText({
        accountId: args.accountId,
        conversationId: args.conversationId,
        text: funnel.reward_text,
      });
    }

    await this.prisma.instagram_comment_funnel_runs.update({
      where: { id: runId },
      data: {
        state: 'delivered',
        delivered_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.prisma.instagram_comment_funnels.update({
      where: { id: funnel.id },
      data: { delivered_count: { increment: 1 } },
    });
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  /**
   * The account master switch.
   *
   * Separate from `is_active` on the funnel so an account can be paused
   * wholesale — during a Meta review, say — without editing, and then
   * un-editing, every funnel it owns.
   */
  private async isEnabledForAccount(accountId: string): Promise<boolean> {
    const config = await this.prisma.instagram_config.findUnique({
      where: { account_id: accountId },
      select: { comment_funnels_enabled: true, status: true },
    });
    return (
      config?.comment_funnels_enabled === true &&
      config.status !== 'token_expired'
    );
  }

  /**
   * The funnel this comment belongs to, or null.
   *
   * EXACTLY ONE funnel ever answers a comment. `.find()` takes the first
   * match and stops, and the comment's single private reply is spent by
   * whoever wins — so two active funnels covering the same post can never
   * both DM the same commenter.
   *
   * WHICH one wins: post-scoped beats account-wide. Someone who built a
   * funnel for one launch post and left a catch-all running means the
   * specific one — the catch-all is the fallback, and ordering it that way
   * is what makes "all posts" safe to leave on.
   *
   * `nulls: 'last'` is load-bearing, not decoration. `ig_media_id` is
   * NULL for the account-wide funnel, and Postgres sorts NULLS FIRST on a
   * DESC ordering — so a plain `{ ig_media_id: 'desc' }` put the catch-all
   * at the FRONT and inverted the whole precedence rule. It cost the
   * post-scoped funnel every comment its catch-all's keywords happened to
   * match, silently, and the unit tests could not see it because they stub
   * `findMany` and never execute an ORDER BY.
   */
  private async matchFunnel(
    accountId: string,
    igMediaId: string | null,
    text: string,
  ): Promise<instagram_comment_funnels | null> {
    const candidates = await this.prisma.instagram_comment_funnels.findMany({
      where: {
        account_id: accountId,
        is_active: true,
        OR: [{ ig_media_id: null }, { ig_media_id: igMediaId ?? undefined }],
      },
      orderBy: [
        { ig_media_id: { sort: 'desc', nulls: 'last' } },
        { created_at: 'asc' },
      ],
    });

    return candidates.find((f) => matchesKeywords(f.keywords, text)) ?? null;
  }

  /**
   * Does this person follow the business?
   *
   * FAILS OPEN. An unreachable profile API, a blocked business, a
   * revoked token — all resolve to "treat as following", which under a
   * soft gate means deliver immediately. The alternative is showing
   * someone "you aren't following!" because of an outage on our side,
   * which is both wrong and the most annoying possible failure.
   *
   * `known` distinguishes a real `false` from a fallback, so
   * `was_following` can stay honest about what we actually observed.
   */
  private async resolveFollowState(
    igsid: string,
    accessToken: string,
  ): Promise<{ value: boolean; known: boolean }> {
    try {
      const profile = await getUserProfile({ igsid, accessToken });
      if (typeof profile.isUserFollowBusiness !== 'boolean') {
        return { value: true, known: false };
      }
      return { value: profile.isUserFollowBusiness, known: true };
    } catch (err) {
      this.logger.warn(
        `Follow lookup failed for ${igsid}, treating as following: ${String(err)}`,
      );
      return { value: true, known: false };
    }
  }

  private async fail(runId: string, err: unknown): Promise<void> {
    try {
      await this.prisma.instagram_comment_funnel_runs.update({
        where: { id: runId },
        data: {
          state: 'failed',
          last_error: err instanceof Error ? err.message : String(err),
          updated_at: new Date(),
        },
      });
    } catch {
      // The run row is diagnostics. Losing it must not escalate into a
      // second failure on a path that has no one left to report to.
    }
  }
}

// ============================================================
// Pure helpers — exported for the tests
// ============================================================

export function parsePayload(
  payload: string,
): { runId: string; step: FunnelStep } | null {
  if (!payload?.startsWith(`${PAYLOAD_PREFIX}:`)) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const [, runId, step] = parts;
  if (!runId) return null;
  if (step !== 'optin' && step !== 'followed') return null;
  return { runId, step };
}

/**
 * Case-insensitive substring match; empty list matches everything.
 *
 * Deliberately the same rule as the automations engine applies to
 * `instagram_comment` triggers (automation-trigger-match.util). Two
 * keyword semantics in one product is a support burden nobody can
 * explain — a merchant who learns it once should not be surprised here.
 */
export function matchesKeywords(
  keywords: readonly string[],
  text: string,
): boolean {
  if (!keywords || keywords.length === 0) return true;
  const haystack = (text ?? '').toLowerCase();
  if (!haystack) return false;
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/**
 * Which public reply this match gets, or null for "answer privately
 * only".
 *
 * Round-robin on `matched_count` rather than random: a merchant who
 * writes three variants can watch their post and see all three, and a
 * support conversation about "why did it post the same one twice" has a
 * deterministic answer. Random selection collides ~30% of the time on
 * three variants, which is exactly the appearance the rotation exists
 * to avoid.
 *
 * Blank entries are filtered rather than skipped in place — an empty
 * string in the list must not become a turn where nothing is posted.
 */
export function pickPublicReply(
  variants: readonly string[] | null | undefined,
  matchedCount: number,
): string | null {
  const usable = (variants ?? []).filter((v) => v?.trim());
  if (usable.length === 0) return null;
  // Modulo of a negative would index off the front of the array. A
  // counter cannot go negative today, but it is one column default away.
  const safeCount = Number.isFinite(matchedCount)
    ? Math.max(0, Math.trunc(matchedCount))
    : 0;
  return usable[safeCount % usable.length];
}

export interface RewardButton {
  label: string;
  url: string;
}

/**
 * Reward buttons are stored as free JSON, so they are re-validated on
 * the way out rather than trusted. A row written before a constraint
 * existed, or by a migration, still has to fail safe: a malformed entry
 * is dropped, never sent as a button with an undefined URL.
 */
export function parseRewardButtons(raw: unknown): RewardButton[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (b): b is RewardButton =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as RewardButton).label === 'string' &&
        typeof (b as RewardButton).url === 'string' &&
        (b as RewardButton).label.trim().length > 0 &&
        /^https?:\/\//i.test((b as RewardButton).url),
    )
    .slice(0, 3);
}
