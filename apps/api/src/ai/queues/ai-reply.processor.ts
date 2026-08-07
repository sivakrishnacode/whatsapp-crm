import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  AI_REPLY_CONCURRENCY,
  AI_REPLY_QUEUE,
} from '../../queue/queue.constants';
import {
  AiReplyService,
  type DispatchArgs,
} from '../services/ai-reply.service';

/**
 * Runs one AI auto-reply.
 *
 * ⚠️ **Speed is the requirement here.** The bot answers a person who is
 * waiting, so a queued reply must go out as fast as the old inline one
 * did. Two things make that true: the worker blocks on Redis (so a job
 * is picked up microseconds after it is added, not on a poll interval),
 * and AI_REPLY_CONCURRENCY is set high enough that a slot is free.
 * Nothing here may add a deliberate delay, and no rate limiter belongs
 * on this queue — the providers already rate-limit per key, and their
 * 429 is a retry, not a reason to make everyone wait.
 *
 * `runInboundAiReply` swallows its own business-level outcomes (no
 * config, auto-reply off, budget spent, handed off to a human) and
 * returns normally. Anything that escapes it is infrastructure — a
 * provider 5xx, a dropped connection — which is exactly what should
 * reach BullMQ's backoff.
 */
@Injectable()
@Processor(AI_REPLY_QUEUE, { concurrency: AI_REPLY_CONCURRENCY })
export class AiReplyProcessor extends WorkerHost {
  private readonly logger = new Logger(AiReplyProcessor.name);

  constructor(private readonly aiReply: AiReplyService) {
    super();
  }

  async process(job: Job<DispatchArgs>): Promise<void> {
    await this.aiReply.runInboundAiReply(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<DispatchArgs>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    // No compensating write: an unanswered message is already visible
    // in the inbox as an unanswered message, and inventing an
    // "AI failed" system message would put our plumbing in the
    // customer's conversation.
    this.logger.error(
      `[ai auto-reply] gave up after ${attempts} attempts for conversation ${job.data.conversationId}: ${err.message}`,
    );
  }
}
