import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { FLOWS_RESUME_QUEUE } from '../queue/queue.constants';
import { FlowDispatchService } from './services/flow-dispatch.service';

interface ResumeJob {
  runId: string;
  resumeNodeKey: string;
}

/**
 * Continues a run parked at a `wait` node.
 *
 * ⚠️ THE JOB CARRIES IDS ONLY. The run, the flow and its nodes are
 * re-read here, so a flow edited during a two-day wait resumes against
 * what the author has now — and nothing sensitive sits in a Redis
 * payload that Bull Board renders.
 *
 * ⚠️ THE CLAIM IS WHAT MAKES IT SAFE TO HAVE TWO WAKERS. Both this job
 * and the periodic sweep can reach the same due run; `resumeFromWait`
 * clears the parking columns in a conditional UPDATE first, so exactly
 * one of them proceeds and the other finds nothing to do.
 */
@Processor(FLOWS_RESUME_QUEUE, { concurrency: 5 })
export class FlowsResumeProcessor extends WorkerHost {
  private readonly logger = new Logger(FlowsResumeProcessor.name);

  constructor(private readonly dispatch: FlowDispatchService) {
    super();
  }

  async process(job: Job<ResumeJob>): Promise<{ resumed: boolean }> {
    const { runId, resumeNodeKey } = job.data;
    try {
      const resumed = await this.dispatch.resumeFromWait(runId, resumeNodeKey);
      return { resumed };
    } catch (err) {
      this.logger.error(
        `resume failed for run ${runId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
