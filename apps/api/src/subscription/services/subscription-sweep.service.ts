import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { SUBSCRIPTION_SWEEP_QUEUE, envInt } from '../../queue/queue.constants';

/**
 * ============================================================
 * The clock nobody was winding.
 *
 * Nothing in this codebase ever moved a subscription out of `trial`. The
 * only writer of `expired` is a gateway webhook, so a trial that lapsed
 * sat at `status = 'trial'` forever — and since `get_account_entitlement`
 * now reads the dates as well as the status, that was survivable but
 * dishonest: the admin panel showed a live trial, at-risk MRR was
 * understated, and every "trials ending soon" list stayed full of trials
 * that had ended months ago.
 *
 * TWO TRANSITIONS, AND ONE DELIBERATE OMISSION
 *
 *   trial  → expired   once `trial_end_at` has passed.
 *
 *   active → past_due  once `current_period_end` has passed by more than
 *                      the grace window, AND ONLY when no gateway
 *                      subscription is attached. A Stripe or Razorpay row
 *                      belongs to the gateway: a renewal webhook arriving
 *                      a few hours late must not mark a paying customer
 *                      delinquent, and the gateway's own dunning is
 *                      better at this than a cron job.
 *
 *   Nothing is ever cancelled here. Cancelling ends a customer
 *   relationship, and that is a decision a person makes — from the admin
 *   panel, where it is recorded. `past_due` still allows writes (see
 *   `get_account_entitlement`: it grades as `grace`), so this sweep never
 *   takes the product away from anyone. It only makes the books true.
 * ============================================================
 */
@Injectable()
export class SubscriptionSweepService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionSweepService.name);

  constructor(
    @InjectQueue(SUBSCRIPTION_SWEEP_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Hourly is ample: everything here is billing-cycle scale, and the
    // entitlement resolver already reads the dates directly, so a
    // workspace whose trial ended twenty minutes ago is refused writes
    // before this job has noticed. `upsertJobScheduler` is idempotent
    // across restarts and updates the interval in place.
    const every = envInt('SUBSCRIPTION_SWEEP_INTERVAL_MS', 60 * 60_000);

    await this.queue.upsertJobScheduler(
      'subscription-sweep-scheduler',
      { every },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  /** Days past a period end before an unbacked subscription is flagged. */
  private graceDays(): number {
    return envInt('SUBSCRIPTION_GRACE_DAYS', 3);
  }

  async sweep(): Promise<{ expired: number; pastDue: number }> {
    const now = new Date();

    // Both writes are guarded by the status they expect, so a webhook
    // landing between the read and the write wins rather than being
    // clobbered — the same precondition trick the flows sweep uses.
    const expired = await this.prisma.user_subscriptions.updateMany({
      where: { status: 'trial', trial_end_at: { not: null, lt: now } },
      data: { status: 'expired', updated_at: now },
    });

    const cutoff = new Date(now.getTime() - this.graceDays() * 86_400_000);

    const pastDue = await this.prisma.user_subscriptions.updateMany({
      where: {
        status: 'active',
        current_period_end: { not: null, lt: cutoff },
        // The gateway owns its own rows. See the header.
        stripe_subscription_id: null,
        razorpay_subscription_id: null,
      },
      data: { status: 'past_due', updated_at: now },
    });

    if (expired.count > 0 || pastDue.count > 0) {
      this.logger.log(
        `subscription sweep: ${expired.count} trial(s) expired, ` +
          `${pastDue.count} marked past due`,
      );
    }

    return { expired: expired.count, pastDue: pastDue.count };
  }
}
