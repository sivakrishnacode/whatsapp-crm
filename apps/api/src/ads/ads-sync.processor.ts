import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { adsEnabled } from './ads.config';
import { AdsSyncService } from './services/ads-sync.service';
import {
  MetaRateLimitError,
  MetaTokenExpiredError,
} from '../common/messaging/meta-errors';

export const ADS_SYNC_QUEUE = 'ads-sync';

/** Repeatable job that fans out to every connected workspace. */
const SWEEP_JOB = 'sweep-all-accounts';
/** One workspace's sync. Also what the on-demand refresh enqueues. */
const ACCOUNT_JOB = 'sync-account';
/** A one-off deep history pull, enqueued when an ad account is first chosen. */
const BACKFILL_JOB = 'backfill-account';

interface SyncAccountJobData {
  accountId: string;
  /** Skip the object sync and only refresh insights. */
  insightsOnly?: boolean;
}

/**
 * Nightly at 02:30 UTC, plus on demand.
 *
 * 02:30 rather than midnight: Meta's own daily aggregation settles a
 * little after the account's day boundary, and every integration in the
 * world schedules on the hour. An off-peak, off-the-hour slot gets
 * cleaner numbers and fewer throttles.
 */
const SWEEP_CRON = '30 2 * * *';

@Injectable()
@Processor(ADS_SYNC_QUEUE)
export class AdsSyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AdsSyncProcessor.name);

  constructor(
    @InjectQueue(ADS_SYNC_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly sync: AdsSyncService,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot.
   *
   * Guarded on the feature flag: a disabled feature must not leave a
   * repeatable job in Redis that keeps firing after a rollback. Removing
   * it when disabled also means flipping the flag off actually stops the
   * work rather than just hiding the UI.
   *
   * Uses `upsertJobScheduler` rather than the older
   * `queue.add(..., { repeat })` idiom in
   * whatsapp/services/messaging-limits.service.ts. Same intent — one
   * schedule that a restart replaces instead of stacking — but the
   * scheduler API states it directly instead of relying on a stable
   * jobId, and it has a matching remove for the disabled branch above.
   */
  async onModuleInit(): Promise<void> {
    try {
      if (!adsEnabled()) {
        await this.queue.removeJobScheduler(SWEEP_JOB).catch(() => undefined);
        return;
      }

      await this.queue.upsertJobScheduler(
        SWEEP_JOB,
        { pattern: SWEEP_CRON },
        {
          name: SWEEP_JOB,
          opts: { removeOnComplete: true, removeOnFail: 20 },
        },
      );
      this.logger.log(`Ads sync sweep scheduled (${SWEEP_CRON} UTC)`);
    } catch (err) {
      // A Redis hiccup at boot must not prevent the API from starting —
      // the sweep is a background nicety, and the on-demand refresh path
      // still works. Matches how MessagingLimitsService treats its own
      // repeatable job.
      this.logger.error('Could not schedule the ads sync sweep', err);
    }
  }

  /**
   * Enqueue a one-off history pull.
   *
   * Fired when an ad account is selected, so the Overview is not empty
   * until the first nightly sync. `attempts: 1` — a backfill that fails is
   * cosmetic (the nightly sync still populates recent data), and Meta's
   * async report machinery is expensive enough that retrying a failure
   * automatically is worse than leaving it.
   */
  async enqueueBackfill(accountId: string): Promise<void> {
    await this.queue.add(
      BACKFILL_JOB,
      { accountId } satisfies SyncAccountJobData,
      {
        // Stable id: re-selecting the same ad account does not queue a
        // second 90-day pull.
        jobId: `ads-backfill:${accountId}`,
        removeOnComplete: true,
        removeOnFail: 20,
        attempts: 1,
      },
    );
  }

  /** Enqueue one workspace's sync. Used by the on-demand refresh button. */
  async enqueueAccount(
    accountId: string,
    options: { insightsOnly?: boolean } = {},
  ): Promise<void> {
    await this.queue.add(
      ACCOUNT_JOB,
      {
        accountId,
        insightsOnly: options.insightsOnly,
      } satisfies SyncAccountJobData,
      {
        // Collapses a burst of refresh clicks into one job. The id is
        // per account and per mode, so a manual refresh cannot be
        // starved by the nightly fan-out.
        jobId: `ads-sync:${accountId}:${options.insightsOnly ? 'insights' : 'full'}`,
        removeOnComplete: true,
        removeOnFail: 20,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === SWEEP_JOB) return this.sweep();
    if (job.name === ACCOUNT_JOB) {
      return this.syncOne(job.data as SyncAccountJobData);
    }
    if (job.name === BACKFILL_JOB) {
      const { accountId } = job.data as SyncAccountJobData;
      // Objects first: a backfilled insight row for a campaign we have not
      // mirrored yet would render as an unnamed row on the Overview.
      await this.sync.syncObjects(accountId);
      return this.sync.backfillInsights(accountId);
    }
    this.logger.warn(`Unknown ads sync job: ${job.name}`);
    return undefined;
  }

  /**
   * Fan out to every workspace with a usable connection.
   *
   * Enqueues rather than syncing inline, so one workspace with a huge
   * account (or a throttled one) cannot delay everybody behind it, and
   * BullMQ's concurrency does the pacing.
   */
  private async sweep(): Promise<{ enqueued: number }> {
    const connected = await this.prisma.meta_ads_config.findMany({
      where: {
        status: 'connected',
        ad_account_id: { not: null },
      },
      select: { account_id: true },
    });

    for (const row of connected) {
      await this.enqueueAccount(row.account_id);
    }

    this.logger.log(`Ads sync sweep enqueued ${connected.length} account(s)`);
    return { enqueued: connected.length };
  }

  private async syncOne(data: SyncAccountJobData): Promise<unknown> {
    try {
      const result = data.insightsOnly
        ? await this.sync.syncInsights(data.accountId)
        : await this.sync.syncAccount(data.accountId);

      this.logger.log(
        `Ads sync for account ${data.accountId}: ${JSON.stringify(result)}`,
      );
      return result;
    } catch (err) {
      // Branch on the failure rather than retrying everything blindly —
      // the whole reason meta-errors.ts classifies these.
      if (err instanceof MetaTokenExpiredError) {
        // Retrying cannot help; the workspace has to reconnect. Record it
        // on the config row so the Setup page can say so.
        await this.prisma.meta_ads_config
          .update({
            where: { account_id: data.accountId },
            data: {
              status: 'error',
              last_error:
                'Your Meta access expired. Reconnect from Ads Manager → Setup.',
              updated_at: new Date(),
            },
          })
          .catch(() => undefined);

        this.logger.warn(
          `Ads token expired for account ${data.accountId} — marked for reconnect, not retrying.`,
        );
        return { skipped: 'token_expired' };
      }

      if (err instanceof MetaRateLimitError) {
        // Worth retrying, but not immediately and not forever — BullMQ's
        // `attempts` handles that. Re-throw so it counts as a failure.
        this.logger.warn(
          `Ads sync throttled for account ${data.accountId}; will retry.`,
        );
        throw err;
      }

      this.logger.error(
        `Ads sync failed for account ${data.accountId}`,
        err instanceof Error ? err.stack : err,
      );
      throw err;
    }
  }
}
