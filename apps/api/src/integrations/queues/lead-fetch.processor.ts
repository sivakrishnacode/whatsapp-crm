import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { LEAD_FETCH_QUEUE } from '../../queue/queue.constants';
import { FacebookLeadService } from '../services/facebook-lead.service';

export interface LeadFetchJobData {
  leadgenId: string;
  pageId: string;
}

/**
 * Fetches and files one Facebook lead.
 *
 * Leads arrive in bursts when an ad performs, and each job is a Graph
 * call plus a handful of writes, so concurrency 5 clears a burst
 * quickly without opening a Graph connection per lead.
 */
@Injectable()
@Processor(LEAD_FETCH_QUEUE, { concurrency: 5 })
export class LeadFetchProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadFetchProcessor.name);

  constructor(private readonly leads: FacebookLeadService) {
    super();
  }

  async process(job: Job<LeadFetchJobData>): Promise<void> {
    await this.leads.processLead(job.data.leadgenId, job.data.pageId);
  }

  /**
   * A lead that never got filed is a customer who filled in a form and
   * was never contacted, so this is logged at error level with the
   * leadgen id: it is recoverable by hand from Meta's Forms Library,
   * but only if somebody knows it happened.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<LeadFetchJobData>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    this.logger.error(
      `[facebook leads] gave up after ${attempts} attempts for leadgen ${job.data.leadgenId} (page ${job.data.pageId}): ${err.message}`,
    );
  }
}
