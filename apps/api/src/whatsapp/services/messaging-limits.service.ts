import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import {
  fetchPhoneNumberLimits,
  MetaRateLimitError,
  MetaTokenExpiredError,
} from '../meta-api.util';

export const LIMITS_QUEUE = 'whatsapp-limits';

/** Repeatable-job cadence. Tier changes are at most daily; quality moves slower. */
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Data older than this is flagged in the UI as possibly out of date. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/** Politeness gap between per-account Graph calls during a global sweep. */
const SWEEP_DELAY_MS = 250;

/**
 * Meta's messaging limit tiers -> messages per rolling 24h window.
 *
 * Source of truth for the mapping; whatsapp_config.tier_daily_limit is a
 * denormalised copy. UNLIMITED maps to null, and so does an unrecognised
 * tier — callers MUST disambiguate the two via the tier string itself
 * rather than testing the number, or a tier Meta adds tomorrow renders
 * as "Unlimited" to every operator.
 */
const TIER_LIMITS: Record<string, number | null> = {
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  UNLIMITED: null,
};

const TIER_LABELS: Record<string, string> = {
  TIER_250: 'Unverified — 250/day',
  TIER_1K: 'Tier 1 — 1K/day',
  TIER_10K: 'Tier 2 — 10K/day',
  TIER_100K: 'Tier 3 — 100K/day',
  UNLIMITED: 'Unlimited',
};

/** Recipient statuses that represent a conversation Meta actually counted. */
const COUNTED_RECIPIENT_STATUSES = ['sent', 'delivered', 'read', 'replied'];

export interface TierStatusDto {
  /** Raw Meta value, or null if never synced. */
  tier: string | null;
  /** Resolved display label. Always populated. */
  tierLabel: string;
  /** null = unlimited, unknown tier, or unsynced. Use isUnlimited to tell them apart. */
  dailyLimit: number | null;
  isUnlimited: boolean;
  /** Distinct contacts messaged in the last 24h. Broadcasts only — see usageIsPartial. */
  used: number;
  /**
   * Always true in v1. Usage counts broadcast recipients only; automation,
   * flow, and inbox sends consume the same Meta quota but are invisible to
   * the counter, so `used` is a floor rather than a total. Carried in the
   * payload (not just documented) so the UI can't quietly drop the caveat.
   */
  usageIsPartial: boolean;
  remaining: number | null;
  /** GREEN | YELLOW | RED | NA. */
  qualityRating: string | null;
  lastSyncedAt: string | null;
  isStale: boolean;
  tokenExpired: boolean;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveTierLimit(tier: string | null): number | null {
  if (!tier) return null;
  return TIER_LIMITS[tier] ?? null;
}

export function isKnownTier(tier: string | null): boolean {
  return !!tier && tier in TIER_LIMITS;
}

export function resolveTierLabel(tier: string | null): string {
  if (!tier) return 'Not synced yet';
  return TIER_LABELS[tier] ?? `Unknown tier (${tier})`;
}

/**
 * Per-account WhatsApp messaging limit state: syncing it from Meta,
 * computing approximate 24h usage from our own data, and assembling the
 * two into the DTO the dashboard renders.
 *
 * Deliberate design points:
 *  - syncAccountLimits NEVER throws. It runs in a loop over every
 *    connected account; one bad token must not abort the sweep.
 *  - A failed sync leaves limits_synced_at alone, so the UI's staleness
 *    indicator reflects reality instead of "we tried recently".
 *  - Access tokens are encrypted at rest; reading the column raw gives
 *    ciphertext, so every path here goes through decrypt().
 */
@Injectable()
export class MessagingLimitsService implements OnModuleInit {
  private readonly logger = new Logger(MessagingLimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(LIMITS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the 6-hourly sweep. Stable jobId means an api restart
   * replaces the repeatable rather than stacking a second one.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        'global-sync',
        {},
        {
          repeat: { every: SYNC_INTERVAL_MS },
          jobId: 'limits-global-sync',
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      // Redis down at boot must not take the whole api down with it —
      // the rest of the WhatsApp module works fine without the sweep.
      this.logger.error(
        'Failed to register the messaging-limits repeatable job',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Queue an on-demand refresh for one account. The per-account jobId
   * coalesces repeat clicks of the UI Refresh button into a single
   * Graph API call instead of one per click.
   */
  async enqueueAccountSync(accountId: string): Promise<void> {
    await this.queue.add(
      'account-sync',
      { accountId },
      {
        jobId: `limits-sync-${accountId}`,
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  /**
   * Sweep every connected account. Sequential with a small delay —
   * a sweep is cheap and bursting the Graph API buys nothing.
   */
  async syncAllConnectedAccounts(): Promise<void> {
    const configs = await this.prisma.whatsapp_config.findMany({
      where: { status: 'connected' },
      select: { account_id: true },
    });

    this.logger.log(
      `Syncing messaging limits for ${configs.length} connected account(s)`,
    );

    for (const cfg of configs) {
      await this.syncAccountLimits(cfg.account_id);
      await sleep(SWEEP_DELAY_MS);
    }
  }

  /**
   * Refresh one account's tier + quality from Meta.
   *
   * Never throws — every failure path logs and returns so a sweep keeps
   * going. Failures also leave limits_synced_at untouched, so the row
   * keeps its last-known values and the UI can show them as stale.
   */
  async syncAccountLimits(accountId: string): Promise<void> {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: accountId },
      select: {
        phone_number_id: true,
        access_token: true,
        token_expires_at: true,
      },
    });

    if (!config) {
      this.logger.warn(
        `No whatsapp_config for account ${accountId} — skipping limits sync`,
      );
      return;
    }

    // No token refresh in this build (deferred follow-up). An expired
    // token means we skip: the UI derives tokenExpired independently and
    // shows a reconnect CTA, and sending still works.
    if (
      config.token_expires_at &&
      config.token_expires_at.getTime() <= Date.now()
    ) {
      this.logger.warn(
        `Access token expired for account ${accountId} — skipping limits sync (reconnect required)`,
      );
      return;
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt access token for account ${accountId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    try {
      const limits = await fetchPhoneNumberLimits({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });

      const tier = limits.messagingLimitTier;
      if (tier && !isKnownTier(tier)) {
        // Our signal that Meta changed the enum. Stored raw anyway.
        this.logger.warn(
          `Unrecognised messaging_limit_tier "${tier}" for account ${accountId} — stored raw with a null daily limit`,
        );
      }

      await this.prisma.whatsapp_config.update({
        where: { account_id: accountId },
        data: {
          messaging_limit_tier: tier,
          quality_rating: limits.qualityRating,
          tier_daily_limit: resolveTierLimit(tier),
          limits_synced_at: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof MetaTokenExpiredError) {
        this.logger.warn(
          `Meta rejected the access token for account ${accountId} (code ${err.code}) — skipping limits sync`,
        );
        return;
      }
      if (err instanceof MetaRateLimitError) {
        this.logger.warn(
          `Rate limited by Meta while syncing limits for account ${accountId} — will retry next sweep`,
        );
        return;
      }
      this.logger.error(
        `Failed to sync messaging limits for account ${accountId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Distinct contacts this account opened a conversation with in the
   * rolling 24h window.
   *
   * DISTINCT, not COUNT(*): Meta's limit caps unique customers, not
   * messages, so counting rows overstates usage whenever a broadcast
   * hits the same contact twice.
   *
   * The join through broadcasts is not optional — broadcast_recipients
   * has no account_id column of its own.
   *
   * Undercounts by design: only broadcast sends are visible here, and
   * CSV recipients with no contact row have a null contact_id that
   * COUNT(DISTINCT) ignores. Surfaced to the user via usageIsPartial.
   */
  async getLiveUsage(accountId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ used: number }>>`
      SELECT COUNT(DISTINCT br.contact_id)::int AS used
      FROM broadcast_recipients br
      JOIN broadcasts b ON b.id = br.broadcast_id
      WHERE b.account_id = ${accountId}::uuid
        AND br.status = ANY(${COUNTED_RECIPIENT_STATUSES})
        AND br.sent_at > NOW() - INTERVAL '24 hours'
    `;
    return rows[0]?.used ?? 0;
  }

  /** Everything the dashboard card needs, in one round trip. */
  async getTierStatus(accountId: string): Promise<TierStatusDto> {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: accountId },
      select: {
        messaging_limit_tier: true,
        quality_rating: true,
        tier_daily_limit: true,
        limits_synced_at: true,
        token_expires_at: true,
      },
    });

    const used = await this.getLiveUsage(accountId);

    if (!config) {
      return {
        tier: null,
        tierLabel: resolveTierLabel(null),
        dailyLimit: null,
        isUnlimited: false,
        used,
        usageIsPartial: true,
        remaining: null,
        qualityRating: null,
        lastSyncedAt: null,
        isStale: true,
        tokenExpired: false,
      };
    }

    const tier = config.messaging_limit_tier;
    const isUnlimited = tier === 'UNLIMITED';
    const dailyLimit = config.tier_daily_limit;
    const syncedAt = config.limits_synced_at;

    return {
      tier,
      tierLabel: resolveTierLabel(tier),
      dailyLimit,
      isUnlimited,
      used,
      usageIsPartial: true,
      remaining: dailyLimit === null ? null : dailyLimit - used,
      qualityRating: config.quality_rating,
      lastSyncedAt: syncedAt ? syncedAt.toISOString() : null,
      isStale: !syncedAt || Date.now() - syncedAt.getTime() > STALE_AFTER_MS,
      tokenExpired: !!(
        config.token_expires_at &&
        config.token_expires_at.getTime() <= Date.now()
      ),
    };
  }
}
