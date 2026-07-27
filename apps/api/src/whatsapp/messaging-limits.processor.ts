import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  MessagingLimitsService,
  LIMITS_QUEUE,
} from './services/messaging-limits.service';

interface LimitsSyncJobData {
  /** Present for an on-demand single-account refresh; absent for the sweep. */
  accountId?: string;
}

/**
 * Refreshes WhatsApp messaging tier + quality rating from Meta, either
 * for one account (the dashboard Refresh button) or across every
 * connected account (the 6-hourly repeatable job).
 *
 * concurrency 1: the sweep is cheap, and serialising keeps a burst of
 * Graph API calls from leaving one process. The service swallows
 * per-account failures itself, so this rarely sees a throw.
 */
@Processor(LIMITS_QUEUE, { concurrency: 1 })
export class MessagingLimitsProcessor extends WorkerHost {
  private readonly logger = new Logger(MessagingLimitsProcessor.name);

  constructor(private readonly limits: MessagingLimitsService) {
    super();
  }

  async process(job: Job<LimitsSyncJobData>): Promise<void> {
    try {
      if (job.data.accountId) {
        await this.limits.syncAccountLimits(job.data.accountId);
        return;
      }
      await this.limits.syncAllConnectedAccounts();
    } catch (err) {
      this.logger.error(
        `messaging limits sync failed (accountId=${job.data.accountId ?? 'all'})`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
