import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { BROADCAST_ORCHESTRATE_QUEUE } from './queue.constants';

/**
 * The one way to start a broadcast.
 *
 * It lives in the queue module rather than next to either producer
 * because there are two of them in different Nest modules — the
 * dashboard (`whatsapp`) and the public API (`v1`) — and the answer to
 * "what job options does a broadcast use?" must not depend on which
 * door the request came through. The public API's broadcasts used to be
 * delivered by a fire-and-forget `void deliverBroadcast()` with no
 * queue, no retry and no persistence: a restart lost them silently.
 * Now both paths are this call.
 */
@Injectable()
export class BroadcastQueueService {
  constructor(
    @InjectQueue(BROADCAST_ORCHESTRATE_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Hand a broadcast to the orchestrator.
   *
   * `jobId` is the broadcast id, so a double-submit (or a recovery
   * sweep racing a fresh enqueue) adds nothing the second time —
   * BullMQ rejects a duplicate jobId while the job still exists, and
   * the orchestrator is re-runnable anyway.
   */
  async enqueueBroadcast(broadcastId: string): Promise<void> {
    await this.queue.add(
      'orchestrate',
      { broadcastId },
      {
        jobId: broadcastId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    );
  }
}
