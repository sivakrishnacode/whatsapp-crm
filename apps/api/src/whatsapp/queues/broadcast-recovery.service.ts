import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BroadcastQueueService } from '../../queue/broadcast-queue.service';

/** Never re-enqueue more than this on one boot. */
const MAX_RECOVERED = 100;

/**
 * On boot, re-enqueue broadcasts that were mid-flight when the process
 * last stopped.
 *
 * Three things leave a broadcast stranded, and this covers all of them
 * with one query:
 *
 * - **The upgrade that introduced this queue.** Jobs already sitting on
 *   the old `broadcasts-send` queue have no worker any more. Their
 *   broadcasts would sit in 'sending' with pending recipients forever.
 * - **A Redis flush.** The queue is a work list, not the system of
 *   record; the database is. Recipients still marked 'pending' are the
 *   truth, and they are re-derivable at any time.
 * - **A crash between enqueue and fan-out.**
 *
 * Safe to run every boot because both layers below it are idempotent:
 * the orchestrate job is keyed by broadcast id, and each recipient job
 * re-checks its row before sending. The worst case is a no-op job.
 */
@Injectable()
export class BroadcastRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(BroadcastRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcastQueue: BroadcastQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Never let recovery stop the API from starting: a broadcast that
    // resumes ten minutes late is a much smaller problem than an app
    // that will not boot because Redis is briefly unreachable.
    try {
      await this.recoverStuckBroadcasts();
    } catch (err) {
      this.logger.error(
        `broadcast recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async recoverStuckBroadcasts(): Promise<number> {
    const stuck = await this.prisma.broadcasts.findMany({
      where: {
        status: { in: ['queued', 'sending'] },
        broadcast_recipients: { some: { status: 'pending' } },
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: MAX_RECOVERED,
    });
    if (stuck.length === 0) return 0;

    for (const broadcast of stuck) {
      await this.broadcastQueue.enqueueBroadcast(broadcast.id);
    }
    this.logger.log(
      `re-enqueued ${stuck.length} unfinished broadcast(s) after restart`,
    );
    return stuck.length;
  }
}
