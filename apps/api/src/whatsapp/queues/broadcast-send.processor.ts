import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  BROADCAST_SEND_CONCURRENCY,
  BROADCAST_SEND_QUEUE,
  BROADCAST_SEND_RATE_DURATION_MS,
  BROADCAST_SEND_RATE_MAX,
} from '../../queue/queue.constants';
import { BroadcastFinalizeService } from './broadcast-finalize.service';
import {
  BroadcastRecipientSendService,
  BroadcastUnsendableError,
} from './broadcast-recipient-send.service';
import type { BroadcastSendJobData } from './broadcast-orchestrator.processor';

/**
 * One job = one message to one person.
 *
 * Two limits, doing different jobs. `concurrency` caps how many sends
 * are in flight at once; the `limiter` caps how fast new ones may
 * start. Meta throttles on rate, so the limiter is the one that keeps a
 * customer's number out of trouble — but without a concurrency cap a
 * spell of slow responses would still pile up open sockets.
 *
 * ⚠️ The limiter's state lives in Redis, so it is shared across every
 * API instance: scaling out does not multiply the send rate. It is also
 * per *queue*, not per phone number (grouped rate limiting is a BullMQ
 * Pro feature), which is why the default is Meta's most conservative
 * tier rather than a number tuned for one busy account.
 */
@Injectable()
@Processor(BROADCAST_SEND_QUEUE, {
  concurrency: BROADCAST_SEND_CONCURRENCY,
  limiter: {
    max: BROADCAST_SEND_RATE_MAX,
    duration: BROADCAST_SEND_RATE_DURATION_MS,
  },
})
export class BroadcastSendProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastSendProcessor.name);

  constructor(
    private readonly sender: BroadcastRecipientSendService,
    private readonly finalize: BroadcastFinalizeService,
  ) {
    super();
  }

  async process(job: Job<BroadcastSendJobData>): Promise<void> {
    const { broadcastId, recipientId } = job.data;

    try {
      const outcome = await this.sender.sendOne(broadcastId, recipientId);
      await this.sender.markRecipient(recipientId, outcome);
    } catch (err) {
      // The account cannot send at all — a missing config or a token
      // that no longer decrypts. Retrying each of the remaining
      // recipients through its own backoff would take hours to reach
      // the same answer, so end the whole broadcast now.
      if (err instanceof BroadcastUnsendableError) {
        await this.finalize.failEntireBroadcast(broadcastId, err.reason);
        return;
      }
      // Transient (throttle, 5xx, network). Leave the row pending and
      // let BullMQ's backoff bring it back.
      throw err;
    }

    // Every recipient asks "was I the last one?". The answer is a
    // single atomic statement, so asking N times costs N cheap
    // no-ops and never races.
    await this.finalize.finalizeIfComplete(broadcastId);
  }

  /**
   * Retries exhausted. The row is still 'pending' (that is what made it
   * retryable), so nothing else will ever come back for it — record the
   * failure here or the broadcast hangs forever, one recipient short of
   * complete.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<BroadcastSendJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    const { broadcastId, recipientId } = job.data;
    this.logger.error(
      `broadcast-send exhausted ${attempts} attempts: broadcastId=${broadcastId} recipientId=${recipientId}: ${err.message}`,
    );
    await this.sender.markRecipient(recipientId, {
      status: 'failed',
      error: err.message,
    });
    await this.finalize.finalizeIfComplete(broadcastId);
  }
}
