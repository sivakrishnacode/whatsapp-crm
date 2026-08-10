import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Where a human message came from. Only used for the log line — the
 * effect is identical either way.
 */
export type HumanTakeoverSource = 'dashboard' | 'echo';

/**
 * "A human is handling this thread, so the bot stays out of it."
 *
 * WHY THIS EXISTS
 *
 *   `AiReplyService` already refuses to answer a conversation with an
 *   `assigned_agent_id`, but assigning is a deliberate act almost nobody
 *   performs mid-conversation. So an agent could be chatting to someone
 *   — from the dashboard or from the Instagram app on their phone — and
 *   the bot would cheerfully open with "Hi there! I'm your assistant"
 *   two messages in. Replying IS the takeover; requiring a separate
 *   click to say so was the bug.
 *
 * WHAT COUNTS AS A HUMAN
 *
 *   Exactly two things, and neither is guessed:
 *
 *   1. A send through one of the dashboard `POST /send` controllers.
 *      Those sit behind SupabaseAuthGuard and carry the caller's user id
 *      as `senderId`; the AI, automations and flows all send through
 *      ChannelSenderService with no sender, which is why the messages
 *      table shows `sender_id = NULL` for every one of them.
 *
 *   2. An Instagram echo that survived the mid dedupe. Our own sends are
 *      stored with the mid Meta returns, so the echo that follows finds
 *      the row already there and stops. An echo that gets past it is a
 *      message this system did not send — i.e. somebody typed it in the
 *      Instagram app. That is proof, not inference, which is what makes
 *      it safe to act on.
 *
 * ⚠ THE BOT'S OWN MESSAGES MUST NEVER REACH HERE. An AI reply comes back
 *   from Meta as an echo too, and if that echo counted as a takeover the
 *   bot would switch itself off after its own first reply. The mid
 *   dedupe upstream is the only thing preventing that — see
 *   InstagramWebhookService.handleMessage, and do not "simplify" the
 *   dedupe without re-reading this.
 *
 * The pause is deliberately STICKY. It is cleared by a person deciding
 * the bot should take over again (the toggle in the thread header), not
 * by a timer — a bot that goes quiet for thirty minutes and then rejoins
 * a conversation is the same surprise, just later.
 */
@Injectable()
export class HumanTakeoverService {
  private readonly logger = new Logger(HumanTakeoverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record that a human spoke, pausing auto-reply on that thread.
   *
   * Fails soft on purpose: this runs alongside sending a message, and a
   * failure to flip a flag must never turn into a failure to deliver
   * what the agent just typed. The worst case is the bot replying once
   * more, which is what happens today anyway.
   */
  async noteHumanMessage(
    conversationId: string,
    source: HumanTakeoverSource,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      // updateMany + the `false` filter makes this idempotent and quiet:
      // every subsequent message from the same agent matches zero rows
      // instead of issuing a pointless write and a realtime event on a
      // busy thread.
      const { count } = await this.prisma.conversations.updateMany({
        where: { id: conversationId, ai_autoreply_disabled: false },
        data: { ai_autoreply_disabled: true },
      });
      if (count > 0) {
        this.logger.log(
          `[ai auto-reply] paused on ${conversationId} — human replied (${source})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not pause auto-reply on ${conversationId}: ${String(err)}`,
      );
    }
  }
}
