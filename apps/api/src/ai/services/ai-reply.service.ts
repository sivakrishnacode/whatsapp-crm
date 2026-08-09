import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelSenderService } from '../../common/messaging/channel-sender.service';
import { AI_REPLY_QUEUE } from '../../queue/queue.constants';
import { loadAiConfig } from '../lib/config';
import { buildConversationContext } from '../lib/context';
import { generateReply } from '../lib/generate';
import { latestUserMessage, matchesHandoffPhrase } from '../lib/query';
import { triggerMatches } from '../../automations/services/automation-trigger-match.util';
import { AgentRuntimeService } from './agent-runtime.service';
import { AiCreditsService } from '../credits/ai-credits.service';
import type { AiConfig } from '../lib/types';

export interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
}

@Injectable()
export class AiReplyService {
  private readonly logger = new Logger(AiReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: AgentRuntimeService,
    private readonly credits: AiCreditsService,
    @Inject(forwardRef(() => ChannelSenderService))
    private readonly channelSender: ChannelSenderService,
    @InjectQueue(AI_REPLY_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Is this contact allowed to be answered by the bot right now?
   *
   * Test mode is the honest form of "try it before you go live": the bot
   * answers ONLY the allowlisted numbers, and every other customer is
   * left for a human — rather than the bot answering everyone while a
   * quota counts down.
   *
   * The comparison is canonical E.164 on both sides (`contacts.phone` is
   * E.164 by check constraint; the allowlist is normalised on save), so it
   * needs no fuzzy matching. A contact with no phone at all — an
   * Instagram DM, a web-widget visitor — cannot be in a list of phone
   * numbers, so test mode silences the bot on those channels too. That is
   * the correct reading of "only reply to my test numbers".
   */
  private async isAllowedInTestMode(
    config: AiConfig,
    contactId: string,
  ): Promise<boolean> {
    if (!config.testMode) return true;
    if (config.testNumbers.length === 0) return false;

    const contact = await this.prisma.contacts.findUnique({
      where: { id: contactId },
      select: { phone: true },
    });
    const phone = contact?.phone?.trim();
    if (!phone) return false;

    return config.testNumbers.includes(phone);
  }

  /**
   * Does an active automation already answer THIS message, on THIS
   * channel?
   *
   * ⚠️ THIS MUST ASK THE SAME QUESTION `AutomationDispatchService.dispatch`
   * ASKS, OR THE BOT GOES SILENT FOR NOTHING.
   *
   * The point of the gate is to stop the customer getting two replies to
   * one message. So the only automation that should silence the bot is
   * one that actually fires — which the dispatcher decides with three
   * filters, not one:
   *
   *   1. active, and one of the two triggers that answer a plain message;
   *   2. `channels` includes this conversation's channel (empty = any);
   *   3. `triggerMatches` — i.e. a `keyword_match` whose keywords are
   *      actually in the text.
   *
   * This used to be filter 1 alone: a single `findFirst` on
   * (accountId, isActive, triggerType). One active automation anywhere in
   * the workspace therefore turned the AI off EVERYWHERE, permanently —
   * every channel, every conversation, every message, matching keyword or
   * not. A "web chat" automation scoped to `channels = {web}` with the
   * keyword "hi" silenced the WhatsApp and Instagram bots completely; the
   * account's `ai_reply_count` was 0 on every thread it had ever had, and
   * nothing logged a reason. The customer's message got no automation
   * reply (right — wrong channel) and no AI reply (wrong).
   *
   * Fails CLOSED on error, unlike the gates around it: if we cannot tell
   * whether an automation is answering, the safe outcome is one reply
   * from the automation rather than a possible two.
   */
  private async anAutomationOwnsThisMessage(args: {
    accountId: string;
    conversationId: string;
    text: string;
  }): Promise<boolean> {
    const { accountId, conversationId, text } = args;

    try {
      const automations = await this.prisma.automation.findMany({
        where: {
          accountId,
          isActive: true,
          triggerType: { in: ['new_message_received', 'keyword_match'] },
        },
        select: { triggerType: true, triggerConfig: true, channels: true },
      });
      if (automations.length === 0) return false;

      const channel = await this.channelSender.channelOf(
        accountId,
        conversationId,
      );

      return automations.some((automation) => {
        // An empty `channels` array means "no restriction" — the default,
        // and what every automation predating the column carries.
        if (
          automation.channels.length > 0 &&
          !automation.channels.includes(channel)
        ) {
          return false;
        }
        return triggerMatches(
          automation.triggerType,
          automation.triggerConfig,
          {
            message_text: text,
            conversation_id: conversationId,
            channel,
          },
        );
      });
    } catch (err) {
      this.logger.error(
        `[ai auto-reply] could not check automations for conversation ${conversationId}, deferring to them: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  private async claimReplySlot(
    conversationId: string,
    config: AiConfig,
  ): Promise<boolean> {
    const claimResult = await this.prisma.$queryRawUnsafe<
      { claim_ai_reply_slot: boolean }[]
    >(
      'SELECT claim_ai_reply_slot($1::uuid, $2::integer) as claim_ai_reply_slot',
      conversationId,
      config.autoReplyMaxPerConversation,
    );
    return claimResult?.[0]?.claim_ai_reply_slot === true;
  }

  /** Stop the bot on this thread, and tell the customer if wording is set. */
  private async handOff(args: {
    config: AiConfig;
    accountId: string;
    conversationId: string;
    contactId: string;
    reason: string;
  }): Promise<void> {
    const { config, accountId, conversationId, contactId, reason } = args;

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: { ai_autoreply_disabled: true },
    });

    this.logger.log(
      `[ai auto-reply] handed off conversation ${conversationId} (${reason})`,
    );

    const message = config.escalation.handoffMessage?.trim();
    if (!message) return;

    // The handoff message is a real outbound message, so it consumes a
    // reply slot like any other. `ai_autoreply_disabled` above is the real
    // stop; claiming keeps the per-thread count honest.
    if (!(await this.claimReplySlot(conversationId, config))) return;

    try {
      await this.channelSender.sendText({
        accountId,
        conversationId,
        contactId,
        text: message,
      });
    } catch (err) {
      this.logger.error(`[ai auto-reply] handoff message failed: ${err}`);
    }
  }

  /**
   * Hand an inbound message to the AI reply queue.
   *
   * Called from every inbound webhook (WhatsApp, Instagram, web). It
   * used to *be* the reply: a `void`-ed call that ran the whole
   * retrieval-plus-provider round trip inside the webhook handler.
   * Two problems with that, both of which cost real replies:
   *
   * - A provider call takes seconds and occasionally tens of seconds.
   *   Meta retries a webhook we are slow to acknowledge, and a restart
   *   during one silently dropped the answer — the customer's message
   *   just never got a reply, with nothing anywhere saying why.
   * - There was no retry. A transient 503 from OpenAI was final.
   *
   * The job payload is four ids. Everything else — the config, the
   * conversation, the contact — is read at run time, so a job that
   * waits behind a queue cannot answer using stale settings.
   */
  async dispatchInboundToAiReply(args: DispatchArgs): Promise<void> {
    try {
      await this.queue.add('reply', args, {
        // One job per inbound message. No jobId: two messages in the
        // same conversation are two separate things to answer, and the
        // per-conversation reply budget (claim_ai_reply_slot) is what
        // stops the bot talking too much — not deduplication here.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100, age: 3600 },
        removeOnFail: { count: 200 },
      });
    } catch (err) {
      // Callers are fire-and-forget from a webhook handler; a Redis
      // blip must not turn into a 500 that makes Meta redeliver the
      // whole webhook.
      this.logger.error(
        `[ai auto-reply] could not queue reply for conversation ${args.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The actual auto-reply. Called by the queue processor, never
   * directly from a request path.
   */
  async runInboundAiReply(args: DispatchArgs): Promise<void> {
    const { accountId, conversationId, contactId, configOwnerUserId } = args;

    try {
      // 1. Load active AI configuration.
      const config = await loadAiConfig(this.prisma, accountId);
      if (!config || !config.autoReplyEnabled) return;

      // 1b. Gate: credits. An empty wallet with no key of their own
      //     stops the bot BEFORE knowledge retrieval and the provider
      //     call, and — unlike the two request-path entry points —
      //     silently: there is nobody watching a queue job, and a
      //     customer must not receive "this business is out of AI
      //     credits" as an answer to their question. The thread simply
      //     stays for a human, which is what an unanswered thread means
      //     everywhere else in this service.
      if (config.source === 'platform' && config.creditBalance < 1) {
        this.logger.warn(
          `[ai auto-reply] account ${accountId} is out of AI credits — conversation ${conversationId} left for a human.`,
        );
        return;
      }

      // 2. Gate: conversation state.
      const conv = await this.prisma.conversations.findUnique({
        where: { id: conversationId },
        select: {
          assigned_agent_id: true,
          ai_autoreply_disabled: true,
          ai_reply_count: true,
        },
      });
      if (!conv) return;
      if (conv.assigned_agent_id) return; // human owns the thread
      if (conv.ai_autoreply_disabled) return; // bot turned off
      if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

      // 3. Gate: test mode.
      if (!(await this.isAllowedInTestMode(config, contactId))) return;

      // 4. Build the transcript.
      const messages = await buildConversationContext(
        this.prisma,
        conversationId,
      );
      if (messages.length === 0) return;

      const inboundText = latestUserMessage(messages);

      // 5. Gate: an active automation already owns THIS message.
      //    Deliberately after the transcript: the question is only
      //    answerable with the text and the channel in hand.
      if (
        await this.anAutomationOwnsThisMessage({
          accountId,
          conversationId,
          text: inboundText,
        })
      ) {
        return;
      }

      // 6. Trigger phrases short-circuit the model entirely. "Talk to a
      //    human" must not depend on a model agreeing that it qualifies —
      //    and it saves a paid call on the account's own key.
      if (config.escalation.handoffEnabled) {
        const phrase = matchesHandoffPhrase(
          inboundText,
          config.escalation.handoffTriggerPhrases,
        );
        if (phrase) {
          await this.handOff({
            config,
            accountId,
            conversationId,
            contactId,
            reason: `trigger phrase "${phrase}"`,
          });
          return;
        }
      }

      // 7. Assemble the run — knowledge, tools, prompt. The playground
      //    uses this same call, which is what makes the test panel mean
      //    anything.
      const run = await this.runtime.assemble({
        config,
        messages,
        ctx: {
          accountId,
          contactId,
          actorUserId: configOwnerUserId,
          mode: 'auto_reply',
        },
      });

      let text: string;
      let handoff: boolean;
      try {
        const result = await generateReply({
          config,
          systemPrompt: run.systemPrompt,
          messages,
          tools: run.tools,
          executeTool: run.executeTool,
        });
        text = result.text;
        handoff = result.handoff;

        // Charged as soon as the provider answers, not after the send.
        // The tokens are spent either way, and the paths below can exit
        // without sending (handoff, empty reply, reply budget already
        // claimed) — metering after the send would give away every one
        // of those calls.
        if (config.source === 'platform') {
          await this.credits.chargeGeneration({
            accountId,
            feature: 'auto_reply',
            provider: config.provider,
            model: config.model,
            usage: result.usage,
            conversationId,
            userId: configOwnerUserId,
          });
        }
      } catch (err) {
        // The provider failed (bad key, rate limit, timeout). If the
        // business wrote a fallback message, saying it beats leaving the
        // customer on read; otherwise stay silent rather than inventing an
        // apology in a voice they did not choose.
        this.logger.error(`[ai auto-reply] generation failed: ${err}`);
        const fallback = config.escalation.fallbackMessage?.trim();
        if (!fallback) return;
        if (!(await this.claimReplySlot(conversationId, config))) return;
        await this.channelSender.sendText({
          accountId,
          conversationId,
          contactId,
          text: fallback,
        });
        return;
      }

      // 8. Handoff protocol.
      if (handoff || !text) {
        await this.handOff({
          config,
          accountId,
          conversationId,
          contactId,
          reason: handoff ? 'model asked to hand off' : 'empty reply',
        });
        return;
      }

      // 9. The greeting rides in front of the FIRST bot reply on a thread
      //    rather than being sent on its own: two messages back to back
      //    reads as a bot, and a greeting-only message answers nothing.
      const greeting = config.profile.greetingMessage?.trim();
      const finalText =
        greeting && conv.ai_reply_count === 0 ? `${greeting}\n\n${text}` : text;

      // 10. Atomically claim the reply slot — two inbound messages can be
      //     processed concurrently and the cap must hold.
      if (!(await this.claimReplySlot(conversationId, config))) return;

      // 11. Send, routed by the conversation's channel. The AI bot works
      //     on Instagram DMs and WhatsApp alike without knowing which —
      //     that is the whole point of ChannelSenderService.
      await this.channelSender.sendText({
        accountId,
        conversationId,
        contactId,
        text: finalText,
      });
    } catch (err) {
      this.logger.error(`[ai auto-reply] dispatch failed: ${err}`);
    }
  }
}
