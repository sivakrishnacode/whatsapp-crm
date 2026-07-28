import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, decrypt } from '../../common/security/encryption.util';
import { refreshLongLivedToken } from '../ig-api.util';
import { MetaTokenExpiredError } from '../../common/messaging/meta-errors';

export const IG_TOKEN_QUEUE = 'instagram-token-refresh';

/** Daily. The window this guards is 60 days wide; hourly would be noise. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh anything expiring within this many days.
 *
 * Ten days of slack means the sweep can fail for over a week — a bad
 * deploy, a Redis outage, Meta having a bad day — and the connection
 * still survives. Cutting it finer saves nothing: refreshing early
 * resets the clock to a full 60 days regardless.
 */
const REFRESH_THRESHOLD_DAYS = 10;

/**
 * Meta refuses to refresh a token less than 24 hours old. Freshly
 * connected accounts are therefore skipped rather than failed —
 * they are nowhere near expiry anyway.
 */
const MIN_TOKEN_AGE_MS = 25 * 60 * 60 * 1000;

/**
 * Keeps Instagram connections alive.
 *
 * WHY THIS IS NOT OPTIONAL
 *   Instagram long-lived tokens expire after exactly 60 days and Meta
 *   provides no silent renewal. If this sweep stops running, every
 *   Instagram connection in the system dies 60 days later — all at
 *   once, with no warning, and the only remedy is each business
 *   re-authorising by hand. It is the single highest-consequence
 *   background job in the Instagram integration.
 *
 * FAILURE IS RECORDED, NOT THROWN
 *   A per-account failure marks that row and moves on. One business's
 *   revoked token must not stop the sweep from renewing everybody
 *   else's.
 */
@Injectable()
export class InstagramTokenRefreshService implements OnModuleInit {
  private readonly logger = new Logger(InstagramTokenRefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(IG_TOKEN_QUEUE) private readonly queue: Queue,
  ) {}

  /** Fixed jobId so a restart replaces the repeatable rather than stacking one. */
  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        'token-refresh-sweep',
        {},
        {
          repeat: { every: SWEEP_INTERVAL_MS },
          jobId: 'instagram-token-refresh-sweep',
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      // Redis down at boot must not take the api with it — the rest of
      // the Instagram module works fine without the sweep.
      this.logger.error(
        'Failed to register the Instagram token-refresh repeatable job',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async refreshExpiringTokens(): Promise<{
    checked: number;
    refreshed: number;
    failed: number;
  }> {
    const threshold = new Date(
      Date.now() + REFRESH_THRESHOLD_DAYS * 86_400_000,
    );

    const due = await this.prisma.instagram_config.findMany({
      where: {
        token_expires_at: { lte: threshold },
        // An already-expired token cannot be refreshed — there is no
        // grace period. Those rows need a human to reconnect, so
        // leave them for the UI to surface rather than burning a
        // guaranteed-failing API call on every sweep.
        status: { in: ['connected', 'error'] },
      },
      select: {
        id: true,
        account_id: true,
        ig_user_id: true,
        access_token: true,
        token_expires_at: true,
        token_refreshed_at: true,
      },
    });

    if (due.length === 0) {
      return { checked: 0, refreshed: 0, failed: 0 };
    }

    this.logger.log(`Refreshing ${due.length} Instagram token(s)`);

    let refreshed = 0;
    let failed = 0;

    for (const config of due) {
      if (config.token_expires_at && config.token_expires_at < new Date()) {
        await this.markExpired(
          config.id,
          'Token expired before it could be refreshed — the business must reconnect.',
        );
        failed++;
        continue;
      }

      const lastTouched = config.token_refreshed_at;
      if (
        lastTouched &&
        Date.now() - lastTouched.getTime() < MIN_TOKEN_AGE_MS
      ) {
        // Meta rejects tokens under 24h old. Not an error.
        continue;
      }

      try {
        const result = await refreshLongLivedToken({
          longLivedToken: decrypt(config.access_token),
        });

        await this.prisma.instagram_config.update({
          where: { id: config.id },
          data: {
            access_token: encrypt(result.accessToken),
            token_expires_at: new Date(Date.now() + result.expiresIn * 1000),
            token_refreshed_at: new Date(),
            status: 'connected',
            last_error: null,
          },
        });
        refreshed++;
      } catch (err) {
        failed++;
        const message =
          err instanceof Error ? err.message : 'Token refresh failed';

        if (err instanceof MetaTokenExpiredError) {
          // The business revoked access from the Instagram app, or the
          // token died earlier than we thought. Only a reconnect fixes
          // this, so say so precisely.
          await this.markExpired(
            config.id,
            'Instagram access was revoked or the token expired. Reconnect the account.',
          );
        } else {
          await this.prisma.instagram_config.update({
            where: { id: config.id },
            data: { status: 'error', last_error: message },
          });
        }

        this.logger.error(
          `Token refresh failed for account ${config.account_id} (ig_user_id=${config.ig_user_id}): ${message}`,
        );
      }
    }

    this.logger.log(
      `Instagram token sweep done — checked ${due.length}, refreshed ${refreshed}, failed ${failed}`,
    );
    return { checked: due.length, refreshed, failed };
  }

  private async markExpired(id: string, reason: string): Promise<void> {
    await this.prisma.instagram_config.update({
      where: { id },
      data: { status: 'token_expired', last_error: reason },
    });
  }
}
