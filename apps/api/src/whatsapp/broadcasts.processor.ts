import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  DashboardBroadcastService,
  BROADCASTS_QUEUE,
} from './services/dashboard-broadcast.service';

interface DeliverBroadcastJobData {
  broadcastId: string;
}

/**
 * Delivers dashboard broadcasts in the background so the browser makes
 * one request and a page refresh (or api restart) never orphans a send.
 * deliver() only touches recipients still in status='pending', so BullMQ
 * retries resume where the previous attempt stopped instead of
 * double-sending. Concurrency 1 keeps the per-phone-number Meta send
 * rate governed by the service's own batch pacing.
 */
@Processor(BROADCASTS_QUEUE, { concurrency: 1 })
export class BroadcastsProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastsProcessor.name);

  constructor(private readonly broadcasts: DashboardBroadcastService) {
    super();
  }

  async process(job: Job<DeliverBroadcastJobData>): Promise<void> {
    try {
      await this.broadcasts.deliver(job.data.broadcastId);
    } catch (err) {
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      if (isFinalAttempt) {
        this.logger.error(
          `broadcast delivery exhausted ${attempts} attempts for broadcastId=${job.data.broadcastId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
      throw err;
    }
  }
}
