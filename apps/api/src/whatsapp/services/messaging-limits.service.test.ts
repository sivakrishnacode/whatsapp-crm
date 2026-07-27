/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import {
  MessagingLimitsService,
  resolveTierLimit,
  resolveTierLabel,
  isKnownTier,
} from './messaging-limits.service';
import type { PrismaService } from '../../prisma/prisma.service';

vi.mock('../meta-api.util', async () => {
  const actual =
    await vi.importActual<typeof import('../meta-api.util')>(
      '../meta-api.util',
    );
  return { ...actual, fetchPhoneNumberLimits: vi.fn() };
});
vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn(() => 'decrypted-token'),
}));

import {
  fetchPhoneNumberLimits,
  MetaTokenExpiredError,
  MetaRateLimitError,
  MetaApiError,
} from '../meta-api.util';

const ACCOUNT = 'acc-1';

function makePrismaMock(configOverrides: Record<string, unknown> = {}) {
  return {
    whatsapp_config: {
      findUnique: vi.fn().mockResolvedValue({
        phone_number_id: 'pn-1',
        access_token: 'enc',
        token_expires_at: null,
        messaging_limit_tier: null,
        quality_rating: null,
        tier_daily_limit: null,
        limits_synced_at: null,
        ...configOverrides,
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ used: 0 }]),
  };
}

function makeQueueMock() {
  return { add: vi.fn().mockResolvedValue({}) };
}

function makeService(
  prisma: ReturnType<typeof makePrismaMock>,
  queue = makeQueueMock(),
) {
  return new MessagingLimitsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tier mapping', () => {
  it('maps known tiers to their daily limit', () => {
    expect(resolveTierLimit('TIER_250')).toBe(250);
    expect(resolveTierLimit('TIER_1K')).toBe(1000);
    expect(resolveTierLimit('TIER_10K')).toBe(10000);
    expect(resolveTierLimit('TIER_100K')).toBe(100000);
  });

  it('returns null for UNLIMITED and for unrecognised tiers alike', () => {
    expect(resolveTierLimit('UNLIMITED')).toBeNull();
    expect(resolveTierLimit('TIER_5M')).toBeNull();
    expect(resolveTierLimit(null)).toBeNull();
  });

  it('distinguishes unlimited from unknown via isKnownTier, not the limit', () => {
    // Both map to a null limit — this is the check that stops a tier Meta
    // adds tomorrow from rendering as "Unlimited".
    expect(isKnownTier('UNLIMITED')).toBe(true);
    expect(isKnownTier('TIER_5M')).toBe(false);
  });

  it('labels unrecognised tiers with the raw value', () => {
    expect(resolveTierLabel('TIER_5M')).toBe('Unknown tier (TIER_5M)');
    expect(resolveTierLabel(null)).toBe('Not synced yet');
    expect(resolveTierLabel('TIER_10K')).toBe('Tier 2 — 10K/day');
  });
});

describe('syncAccountLimits', () => {
  it('writes all four columns on a successful fetch', async () => {
    const prisma = makePrismaMock();
    vi.mocked(fetchPhoneNumberLimits).mockResolvedValue({
      messagingLimitTier: 'TIER_10K',
      qualityRating: 'GREEN',
      displayPhoneNumber: '+1 555',
      verifiedName: 'Acme',
    });

    await makeService(prisma).syncAccountLimits(ACCOUNT);

    expect(prisma.whatsapp_config.update).toHaveBeenCalledWith({
      where: { account_id: ACCOUNT },
      data: {
        messaging_limit_tier: 'TIER_10K',
        quality_rating: 'GREEN',
        tier_daily_limit: 10000,
        limits_synced_at: expect.any(Date),
      },
    });
  });

  it('stores an unrecognised tier raw with a null limit', async () => {
    const prisma = makePrismaMock();
    vi.mocked(fetchPhoneNumberLimits).mockResolvedValue({
      messagingLimitTier: 'TIER_5M',
      qualityRating: 'NA',
      displayPhoneNumber: null,
      verifiedName: null,
    });

    await makeService(prisma).syncAccountLimits(ACCOUNT);

    expect(prisma.whatsapp_config.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messaging_limit_tier: 'TIER_5M',
          tier_daily_limit: null,
        }),
      }),
    );
  });

  it('skips the Graph call entirely when the token is already expired', async () => {
    const prisma = makePrismaMock({
      token_expires_at: new Date(Date.now() - 86_400_000),
    });

    await expect(
      makeService(prisma).syncAccountLimits(ACCOUNT),
    ).resolves.toBeUndefined();

    expect(fetchPhoneNumberLimits).not.toHaveBeenCalled();
    // limits_synced_at must stay put so the UI keeps showing it as stale.
    expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
  });

  it('swallows MetaTokenExpiredError without writing', async () => {
    const prisma = makePrismaMock();
    vi.mocked(fetchPhoneNumberLimits).mockRejectedValue(
      new MetaTokenExpiredError('expired', 190, 401),
    );

    await expect(
      makeService(prisma).syncAccountLimits(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
  });

  it('swallows MetaRateLimitError without writing', async () => {
    const prisma = makePrismaMock();
    vi.mocked(fetchPhoneNumberLimits).mockRejectedValue(
      new MetaRateLimitError('slow down', 4, 429),
    );

    await expect(
      makeService(prisma).syncAccountLimits(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
  });

  it('swallows generic Meta errors without writing', async () => {
    const prisma = makePrismaMock();
    vi.mocked(fetchPhoneNumberLimits).mockRejectedValue(
      new MetaApiError('boom', 1, 500),
    );

    await expect(
      makeService(prisma).syncAccountLimits(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
  });

  it('returns quietly when the account has no whatsapp_config', async () => {
    const prisma = makePrismaMock();
    prisma.whatsapp_config.findUnique.mockResolvedValue(null);

    await expect(
      makeService(prisma).syncAccountLimits(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(fetchPhoneNumberLimits).not.toHaveBeenCalled();
  });
});

describe('syncAllConnectedAccounts', () => {
  it('continues past an account that fails', async () => {
    const prisma = makePrismaMock();
    prisma.whatsapp_config.findMany.mockResolvedValue([
      { account_id: 'a' },
      { account_id: 'b' },
      { account_id: 'c' },
    ]);
    vi.mocked(fetchPhoneNumberLimits)
      .mockRejectedValueOnce(new MetaApiError('boom'))
      .mockResolvedValue({
        messagingLimitTier: 'TIER_1K',
        qualityRating: 'GREEN',
        displayPhoneNumber: null,
        verifiedName: null,
      });

    await makeService(prisma).syncAllConnectedAccounts();

    // First threw, other two still wrote.
    expect(prisma.whatsapp_config.update).toHaveBeenCalledTimes(2);
  });

  it('only sweeps connected accounts', async () => {
    const prisma = makePrismaMock();
    await makeService(prisma).syncAllConnectedAccounts();

    expect(prisma.whatsapp_config.findMany).toHaveBeenCalledWith({
      where: { status: 'connected' },
      select: { account_id: true },
    });
  });
});

describe('getLiveUsage', () => {
  it('returns the distinct-contact count from the window query', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ used: 7 }]);

    await expect(makeService(prisma).getLiveUsage(ACCOUNT)).resolves.toBe(7);
  });

  it('scopes by account and counts distinct contacts over a 24h window', async () => {
    const prisma = makePrismaMock();
    await makeService(prisma).getLiveUsage(ACCOUNT);

    const [strings, ...params] = prisma.$queryRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = strings.join('?');

    // broadcast_recipients has no account_id — the join is load-bearing.
    expect(sql).toMatch(/JOIN\s+broadcasts/i);
    expect(sql).toMatch(/b\.account_id/);
    // Meta caps unique customers, not messages.
    expect(sql).toMatch(/COUNT\(DISTINCT br\.contact_id\)/i);
    expect(sql).toMatch(/INTERVAL '24 hours'/);
    expect(sql).toMatch(/br\.sent_at/);
    expect(params).toContain(ACCOUNT);
  });

  it('returns 0 when the query yields no rows', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(makeService(prisma).getLiveUsage(ACCOUNT)).resolves.toBe(0);
  });
});

describe('getTierStatus', () => {
  it('computes remaining and flags partial usage', async () => {
    const prisma = makePrismaMock({
      messaging_limit_tier: 'TIER_10K',
      quality_rating: 'GREEN',
      tier_daily_limit: 10000,
      limits_synced_at: new Date(),
    });
    prisma.$queryRaw.mockResolvedValue([{ used: 250 }]);

    const status = await makeService(prisma).getTierStatus(ACCOUNT);

    expect(status).toMatchObject({
      tier: 'TIER_10K',
      tierLabel: 'Tier 2 — 10K/day',
      dailyLimit: 10000,
      isUnlimited: false,
      used: 250,
      usageIsPartial: true,
      remaining: 9750,
      qualityRating: 'GREEN',
      isStale: false,
      tokenExpired: false,
    });
  });

  it('separates unlimited from an unknown tier despite both having a null limit', async () => {
    const unlimited = makePrismaMock({
      messaging_limit_tier: 'UNLIMITED',
      tier_daily_limit: null,
      limits_synced_at: new Date(),
    });
    const unknown = makePrismaMock({
      messaging_limit_tier: 'TIER_5M',
      tier_daily_limit: null,
      limits_synced_at: new Date(),
    });

    const a = await makeService(unlimited).getTierStatus(ACCOUNT);
    const b = await makeService(unknown).getTierStatus(ACCOUNT);

    expect(a.dailyLimit).toBeNull();
    expect(b.dailyLimit).toBeNull();
    expect(a.isUnlimited).toBe(true);
    expect(b.isUnlimited).toBe(false);
    expect(b.tierLabel).toBe('Unknown tier (TIER_5M)');
  });

  it('marks data older than 12h as stale', async () => {
    const prisma = makePrismaMock({
      messaging_limit_tier: 'TIER_1K',
      tier_daily_limit: 1000,
      limits_synced_at: new Date(Date.now() - 13 * 60 * 60 * 1000),
    });

    const status = await makeService(prisma).getTierStatus(ACCOUNT);
    expect(status.isStale).toBe(true);
  });

  it('treats a never-synced account as stale with a null tier', async () => {
    const prisma = makePrismaMock({ limits_synced_at: null });

    const status = await makeService(prisma).getTierStatus(ACCOUNT);
    expect(status.tier).toBeNull();
    expect(status.lastSyncedAt).toBeNull();
    expect(status.isStale).toBe(true);
    expect(status.tierLabel).toBe('Not synced yet');
  });

  it('reports tokenExpired without blocking anything else', async () => {
    const prisma = makePrismaMock({
      messaging_limit_tier: 'TIER_1K',
      tier_daily_limit: 1000,
      limits_synced_at: new Date(),
      token_expires_at: new Date(Date.now() - 1000),
    });

    const status = await makeService(prisma).getTierStatus(ACCOUNT);
    expect(status.tokenExpired).toBe(true);
    expect(status.dailyLimit).toBe(1000);
  });

  it('degrades gracefully when there is no whatsapp_config at all', async () => {
    const prisma = makePrismaMock();
    prisma.whatsapp_config.findUnique.mockResolvedValue(null);

    const status = await makeService(prisma).getTierStatus(ACCOUNT);
    expect(status.tier).toBeNull();
    expect(status.remaining).toBeNull();
    expect(status.tokenExpired).toBe(false);
  });

  it('allows remaining to go negative rather than clamping server-side', async () => {
    // Non-broadcast sends can push real usage past the cap; the raw number
    // is more useful than a floor of zero, and the UI clamps the bar only.
    const prisma = makePrismaMock({
      messaging_limit_tier: 'TIER_250',
      tier_daily_limit: 250,
      limits_synced_at: new Date(),
    });
    prisma.$queryRaw.mockResolvedValue([{ used: 300 }]);

    const status = await makeService(prisma).getTierStatus(ACCOUNT);
    expect(status.remaining).toBe(-50);
  });
});

describe('enqueueAccountSync', () => {
  it('coalesces repeat clicks behind a per-account job id', async () => {
    const prisma = makePrismaMock();
    const queue = makeQueueMock();

    await makeService(prisma, queue).enqueueAccountSync(ACCOUNT);

    expect(queue.add).toHaveBeenCalledWith(
      'account-sync',
      { accountId: ACCOUNT },
      expect.objectContaining({ jobId: `limits-sync-${ACCOUNT}` }),
    );
  });
});

describe('onModuleInit', () => {
  it('registers a 6-hourly repeatable with a stable job id', async () => {
    const prisma = makePrismaMock();
    const queue = makeQueueMock();

    await makeService(prisma, queue).onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      'global-sync',
      {},
      expect.objectContaining({
        repeat: { every: 6 * 60 * 60 * 1000 },
        jobId: 'limits-global-sync',
      }),
    );
  });

  it('does not throw when Redis is unavailable at boot', async () => {
    const prisma = makePrismaMock();
    const queue = { add: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    await expect(
      makeService(prisma, queue).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
