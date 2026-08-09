import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { SUBSCRIPTION_SWEEP_QUEUE } from '../queue/queue.constants';
import { SubscriptionSweepService } from './services/subscription-sweep.service';

/**
 * Runs the repeatable subscription sweep registered by
 * SubscriptionSweepService. Concurrency 1 — two passes would only race
 * each other on the same rows, which the status preconditions make
 * harmless but pointless.
 */
@Processor(SUBSCRIPTION_SWEEP_QUEUE, { concurrency: 1 })
export class SubscriptionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionSweepProcessor.name);

  constructor(private readonly sweep: SubscriptionSweepService) {
    super();
  }

  async process(): Promise<{ expired: number; pastDue: number }> {
    try {
      return await this.sweep.sweep();
    } catch (err) {
      this.logger.error(
        'subscription sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
