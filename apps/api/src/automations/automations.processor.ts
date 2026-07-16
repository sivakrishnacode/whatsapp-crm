import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AutomationDispatchService } from './services/automation-dispatch.service';
import { AUTOMATIONS_PENDING_QUEUE } from './services/automation-step-executor.service';

interface ResumeWaitJobData {
  pendingExecutionId: string;
}

/**
 * Replaces the old `GET /api/automations/cron` DB-polling endpoint.
 * BullMQ's own delayed-job scheduling + per-job execution lock replace
 * the manual `status='pending'->'running'` CAS dance; `attempts`/
 * `backoff` (set at enqueue time, see AutomationStepExecutorService's
 * `wait` handling) give real retry behavior the old cron never had.
 */
@Processor(AUTOMATIONS_PENDING_QUEUE, {
  concurrency: Number(process.env.AUTOMATIONS_WORKER_CONCURRENCY ?? 5),
})
export class AutomationsProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationsProcessor.name);

  constructor(private readonly dispatch: AutomationDispatchService) {
    super();
  }

  async process(job: Job<ResumeWaitJobData>): Promise<void> {
    try {
      await this.dispatch.resume(job.data.pendingExecutionId);
    } catch (err) {
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      if (isFinalAttempt) {
        this.logger.error(
          `resume-wait exhausted ${attempts} attempts for pendingExecutionId=${job.data.pendingExecutionId}`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.dispatch.markResumeFailed(job.data.pendingExecutionId);
      }
      throw err;
    }
  }
}
