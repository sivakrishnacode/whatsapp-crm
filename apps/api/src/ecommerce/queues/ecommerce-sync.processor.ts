import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ECOMMERCE_SYNC_QUEUE } from '../../queue/queue.constants';
import { EcommerceSyncService } from '../services/ecommerce-sync.service';

export interface EcommerceSyncJobData {
  integrationId: string;
}

/**
 * Runs one store import.
 *
 * Concurrency 2: a sync walks every product page of a store's API, so
 * these are long jobs that hold a connection to somebody else's rate-
 * limited endpoint. Two at a time keeps a large catalogue from
 * monopolising the worker while still letting a second account's sync
 * start without waiting for the first to finish.
 */
@Injectable()
@Processor(ECOMMERCE_SYNC_QUEUE, { concurrency: 2 })
export class EcommerceSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(EcommerceSyncProcessor.name);

  constructor(private readonly sync: EcommerceSyncService) {
    super();
  }

  async process(job: Job<EcommerceSyncJobData>): Promise<void> {
    await this.sync.syncIntegration(job.data.integrationId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<EcommerceSyncJobData>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    // `sync_error` on the integration row is already written by the
    // service on every attempt, so the user-facing explanation exists
    // regardless. This is the operator's copy.
    this.logger.error(
      `[ecommerce sync] gave up after ${attempts} attempts for integration ${job.data.integrationId}: ${err.message}`,
    );
  }
}
