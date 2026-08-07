import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AUTOMATION_TRIGGER_QUEUE } from '../../queue/queue.constants';
import { AutomationDispatchService } from '../services/automation-dispatch.service';
import type { AutomationDispatchInput } from '../automation.types';

/**
 * Runs the automations that match one trigger event.
 *
 * Distinct from the `automations-pending` queue, which resumes a run
 * already in progress that parked at a wait step. This one starts runs.
 * Keeping them apart means a backlog of "wake up in 3 days" jobs cannot
 * delay a form submission's immediate reply, and the two have genuinely
 * different retry semantics.
 *
 * `dispatch()` never throws — it records per-automation failures into
 * `automation_logs` and returns — so a job reaching the failed state
 * here means the dispatch machinery itself broke (the database was
 * unreachable), which is worth retrying.
 */
@Injectable()
@Processor(AUTOMATION_TRIGGER_QUEUE, { concurrency: 10 })
export class AutomationTriggerProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationTriggerProcessor.name);

  constructor(private readonly dispatch: AutomationDispatchService) {
    super();
  }

  async process(job: Job<AutomationDispatchInput>): Promise<void> {
    await this.dispatch.dispatch(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<AutomationDispatchInput>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    this.logger.error(
      `automation trigger ${job.data.triggerType} gave up after ${attempts} attempts (account ${job.data.accountId}): ${err.message}`,
    );
  }
}
