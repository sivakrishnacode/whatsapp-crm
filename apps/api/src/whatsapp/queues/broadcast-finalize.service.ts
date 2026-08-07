import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Flips a broadcast to its terminal status once no recipient is left
 * pending.
 *
 * Every recipient job calls this when it finishes, so with concurrency
 * 10 the last ten jobs of a broadcast can all call it at the same
 * instant. A read-then-write ("count pending; if zero, update") would
 * race: two workers both read zero and both write, which is harmless
 * here, but the *interesting* race is the other one — a worker reads
 * zero pending while another worker has already claimed the final
 * recipient and not yet written its row, and the broadcast is declared
 * finished while a message is still in flight.
 *
 * So finalization is a single atomic statement: the "is anything still
 * pending?" test and the status write happen in one snapshot, under one
 * lock. Calling it a hundred times is free — after the first, the
 * `status IN ('queued','sending')` guard makes every later call a
 * no-op.
 */
@Injectable()
export class BroadcastFinalizeService {
  private readonly logger = new Logger(BroadcastFinalizeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @returns true if this call is the one that finished the broadcast.
   */
  async finalizeIfComplete(broadcastId: string): Promise<boolean> {
    try {
      // sent_count / failed_count are maintained by the trigger on
      // broadcast_recipients (migration 003), so this reads its own
      // table only. "failed" only when nothing at all went out —
      // a broadcast where 999 of 1000 landed is 'sent', with the
      // per-recipient failures visible on the report.
      const updated = await this.prisma.$executeRaw`
        UPDATE public.broadcasts
        SET status = CASE WHEN COALESCE(sent_count, 0) > 0 THEN 'sent' ELSE 'failed' END,
            updated_at = now()
        WHERE id = ${broadcastId}::uuid
          AND status IN ('queued', 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM public.broadcast_recipients
            WHERE broadcast_id = ${broadcastId}::uuid
              AND status = 'pending'
          );
      `;

      if (updated > 0) {
        this.logger.log(`broadcast ${broadcastId} finished`);
      }
      return updated > 0;
    } catch (err) {
      // Never fatal to the caller: the recipient it just sent is
      // already recorded, and the next recipient's finalize call (or
      // the recovery sweep on boot) will close the broadcast out.
      this.logger.error(
        `finalize failed for ${broadcastId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Give up on a broadcast that cannot be delivered at all — no
   * WhatsApp config, an undecryptable token. Marks every still-pending
   * recipient failed with the reason, then the broadcast itself.
   *
   * Separate from `finalizeIfComplete` because the reason belongs on
   * every row: "why did this recipient not receive it?" is asked per
   * recipient in the UI, and an empty error_message there reads as a
   * bug in us rather than a disconnected WhatsApp account.
   */
  async failEntireBroadcast(
    broadcastId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.broadcast_recipients.updateMany({
      where: { broadcast_id: broadcastId, status: 'pending' },
      data: { status: 'failed', error_message: reason },
    });
    await this.prisma.broadcasts.updateMany({
      where: { id: broadcastId, status: { in: ['queued', 'sending'] } },
      data: { status: 'failed', updated_at: new Date() },
    });
    this.logger.warn(`broadcast ${broadcastId} failed outright: ${reason}`);
  }
}
