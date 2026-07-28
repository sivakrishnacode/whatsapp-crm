import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  InstagramTokenRefreshService,
  IG_TOKEN_QUEUE,
} from '../services/instagram-token-refresh.service';

/**
 * Drives the daily Instagram token-refresh sweep.
 *
 * concurrency 1: the sweep is a handful of Graph calls once a day, and
 * serialising guarantees two workers can never race to refresh the same
 * token (which would invalidate one of the two results).
 */
@Processor(IG_TOKEN_QUEUE, { concurrency: 1 })
export class InstagramTokenRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(InstagramTokenRefreshProcessor.name);

  constructor(private readonly refresh: InstagramTokenRefreshService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    try {
      await this.refresh.refreshExpiringTokens();
    } catch (err) {
      this.logger.error(
        'Instagram token refresh sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
