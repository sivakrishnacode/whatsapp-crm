import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  FLOWS_SWEEP_QUEUE,
  FlowsSweepService,
} from './services/flows-sweep.service';

/**
 * Executes the repeatable stale-run sweep registered by
 * FlowsSweepService. Concurrency 1 — overlapping sweeps would only
 * race each other on the same rows (harmless thanks to the
 * status='active' precondition, but pointless work).
 */
@Processor(FLOWS_SWEEP_QUEUE, { concurrency: 1 })
export class FlowsSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(FlowsSweepProcessor.name);

  constructor(private readonly sweep: FlowsSweepService) {
    super();
  }

  async process(): Promise<{ swept: number }> {
    try {
      return await this.sweep.sweepStaleRuns();
    } catch (err) {
      this.logger.error(
        'flows sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
