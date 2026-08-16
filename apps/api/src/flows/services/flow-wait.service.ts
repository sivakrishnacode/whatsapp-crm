import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { FLOWS_RESUME_QUEUE } from '../../queue/queue.constants';

/**
 * Parking and un-parking a run for a `wait` node.
 *
 * ⚠️ POSTGRES IS THE SYSTEM OF RECORD; REDIS IS THE WORK LIST.
 *   `flow_runs.resume_at` / `resume_node_key` (migration 086) are
 *   written FIRST and are what makes a parked run findable. The delayed
 *   BullMQ job is only the fast path: if Redis is flushed, the periodic
 *   flows-sweep pass picks up every run whose `resume_at` has passed and
 *   continues it. Enqueue-only would strand every waiting customer with
 *   nothing to find them by.
 *
 * ⚠️ THE JOB CARRIES NO CONFIG, ONLY IDS.
 *   The processor re-reads the run and the node when it fires, so a flow
 *   edited during a two-day wait resumes against what the author has
 *   now — and so nothing sensitive sits in a Redis payload that Bull
 *   Board renders.
 *
 * The job id is derived from the run and the node, so Meta re-delivering
 * a webhook (or a retried dispatch) cannot park the same run twice.
 */
@Injectable()
export class FlowWaitService {
  private readonly logger = new Logger(FlowWaitService.name);

  constructor(
    @InjectQueue(FLOWS_RESUME_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /** Clamp: 1 minute floor, 30 days ceiling. */
  static toMilliseconds(duration: number, unit: string): number {
    const per =
      unit === 'days' ? 86_400_000 : unit === 'hours' ? 3_600_000 : 60_000;
    const raw = Math.round(duration * per);
    return Math.min(Math.max(raw, 60_000), 30 * 86_400_000);
  }

  /**
   * Park `run` until `delayMs` has passed, then continue at
   * `resumeNodeKey`. Returns false when the DB write failed — the
   * caller then treats the wait as a no-op and keeps going, because
   * stalling a conversation forever is worse than a skipped pause.
   */
  async park(args: {
    runId: string;
    resumeNodeKey: string;
    delayMs: number;
  }): Promise<boolean> {
    const resumeAt = new Date(Date.now() + args.delayMs);
    try {
      await this.prisma.flowRun.update({
        where: { id: args.runId },
        data: {
          resumeAt,
          resumeNodeKey: args.resumeNodeKey,
          lastAdvancedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(
        `failed to park run ${args.runId}: ${(err as Error).message}`,
      );
      return false;
    }

    try {
      await this.queue.add(
        'resume',
        { runId: args.runId, resumeNodeKey: args.resumeNodeKey },
        {
          delay: args.delayMs,
          jobId: `flow-resume:${args.runId}:${args.resumeNodeKey}:${resumeAt.getTime()}`,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      // The row is already written, so the sweep will still find it.
      // Log and carry on rather than failing the run.
      this.logger.error(
        `failed to enqueue resume for ${args.runId}: ${(err as Error).message}`,
      );
    }
    return true;
  }

  /**
   * Clear the parking columns. Called by whoever actually resumes the
   * run, BEFORE it advances — the columns are the claim, so clearing
   * them is what stops the delayed job and the sweep both continuing
   * the same run.
   *
   * Returns false when the row was already claimed by someone else.
   */
  async claim(runId: string, resumeNodeKey: string): Promise<boolean> {
    const result = await this.prisma.flowRun.updateMany({
      where: {
        id: runId,
        status: 'active',
        resumeNodeKey,
        resumeAt: { not: null },
      },
      data: { resumeAt: null, resumeNodeKey: null },
    });
    return result.count > 0;
  }
}
