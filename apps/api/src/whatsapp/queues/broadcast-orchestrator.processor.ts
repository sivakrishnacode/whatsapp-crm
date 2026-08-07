import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BROADCAST_ORCHESTRATE_QUEUE,
  BROADCAST_SEND_QUEUE,
} from '../../queue/queue.constants';
import { BroadcastFinalizeService } from './broadcast-finalize.service';

export interface OrchestrateJobData {
  broadcastId: string;
}

export interface BroadcastSendJobData {
  broadcastId: string;
  recipientId: string;
}

/** Recipients read (and enqueued) per round trip. */
const PAGE = 500;

/**
 * Turns one broadcast into one job per recipient.
 *
 * The whole point of the split: delivery used to be a single job that
 * looped over every recipient in-process. A 5,000-recipient broadcast
 * was then one unit of work that took an hour, held everything in one
 * worker's memory, and lost its place if that worker died. Now the
 * orchestrator does nothing but read ids and hand them out, and the
 * unit of retry is one message to one person.
 *
 * Enqueueing is idempotent at two levels, which is what makes it safe
 * for this job itself to be retried:
 *
 * - `jobId` is the recipient row id, so re-running the orchestrator
 *   cannot create a second job for a recipient whose job still exists.
 * - Recipient jobs re-check `status = 'pending'` before sending, which
 *   covers the case where the first job already completed and was
 *   removed from Redis.
 */
@Injectable()
@Processor(BROADCAST_ORCHESTRATE_QUEUE, { concurrency: 5 })
export class BroadcastOrchestratorProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastOrchestratorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finalize: BroadcastFinalizeService,
    @InjectQueue(BROADCAST_SEND_QUEUE) private readonly sendQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<OrchestrateJobData>): Promise<void> {
    const { broadcastId } = job.data;

    const broadcast = await this.prisma.broadcasts.findUnique({
      where: { id: broadcastId },
      select: { id: true, account_id: true, status: true },
    });
    if (!broadcast) return;
    if (broadcast.status !== 'queued' && broadcast.status !== 'sending') {
      // Cancelled, already finished, or still a draft. Not an error:
      // the recovery sweep and a manual retry can both land here.
      return;
    }

    // Fail fast, once, for the whole broadcast rather than letting
    // every one of 5,000 recipient jobs discover the same missing
    // config and write the same error 5,000 times.
    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: broadcast.account_id },
      select: { id: true },
    });
    if (!config) {
      await this.finalize.failEntireBroadcast(
        broadcastId,
        'WhatsApp not configured',
      );
      return;
    }

    // 'queued' → 'sending' happens before the fan-out, so the UI stops
    // saying "queued" as soon as work actually begins. Scoped to
    // 'queued' so a resumed broadcast is not walked backwards.
    await this.prisma.broadcasts.updateMany({
      where: { id: broadcastId, status: 'queued' },
      data: { status: 'sending', updated_at: new Date() },
    });

    let cursor: string | undefined;
    let queued = 0;

    // Keyset pagination, not offset: rows change status underneath this
    // loop as recipient jobs complete, so an OFFSET would skip rows as
    // the "pending" set shrinks. Ordering by id (unique) rather than
    // created_at (not unique) keeps the cursor total.
    for (;;) {
      const rows = await this.prisma.broadcast_recipients.findMany({
        where: {
          broadcast_id: broadcastId,
          status: 'pending',
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;

      await this.sendQueue.addBulk(
        rows.map((row) => ({
          name: 'send',
          data: { broadcastId, recipientId: row.id } as BroadcastSendJobData,
          opts: {
            jobId: row.id,
            attempts: 4,
            backoff: { type: 'exponential' as const, delay: 5000 },
            removeOnComplete: true,
            // Keep failures: they are the only durable record of a
            // send that exhausted its retries, and support questions
            // about broadcasts are almost always about one recipient.
            removeOnFail: { count: 1000 },
          },
        })),
      );

      queued += rows.length;
      cursor = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }

    this.logger.log(
      `broadcast ${broadcastId}: fanned out ${queued} recipients`,
    );

    // A broadcast whose recipients were all already handled (a resumed
    // orchestrator, or an audience that resolved to nothing left to do)
    // has no recipient job left to close it out.
    if (queued === 0) {
      await this.finalize.finalizeIfComplete(broadcastId);
    }
  }
}
