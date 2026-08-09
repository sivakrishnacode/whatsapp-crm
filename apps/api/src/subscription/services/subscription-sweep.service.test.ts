import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionSweepService } from './subscription-sweep.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Queue } from 'bullmq';

/**
 * The sweep's whole job is *which rows it refuses to touch*. Expiring a
 * lapsed trial is the easy half; leaving a gateway-backed subscription and
 * never cancelling anything are the parts that would quietly cost a
 * customer their product if they regressed.
 */

function makePrismaMock() {
  return {
    user_subscriptions: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeQueueMock() {
  return { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
}

/** The `where` clause of the nth updateMany call. */
function whereOf(
  mock: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> {
  const arg = mock.mock.calls[index][0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  return arg.where;
}

function dataOf(
  mock: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> {
  const arg = mock.mock.calls[index][0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  return arg.data;
}

describe('SubscriptionSweepService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let queue: ReturnType<typeof makeQueueMock>;
  let service: SubscriptionSweepService;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUBSCRIPTION_GRACE_DAYS;
    prisma = makePrismaMock();
    queue = makeQueueMock();
    service = new SubscriptionSweepService(
      queue as unknown as Queue,
      prisma as unknown as PrismaService,
    );
  });

  it('registers one repeatable scheduler on boot', async () => {
    await service.onModuleInit();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'subscription-sweep-scheduler',
      { every: 60 * 60_000 },
      expect.objectContaining({ name: 'sweep' }),
    );
  });

  it('expires a trial whose end date has passed', async () => {
    prisma.user_subscriptions.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await service.sweep();

    expect(result.expired).toBe(2);
    expect(whereOf(prisma.user_subscriptions.updateMany, 0)).toMatchObject({
      status: 'trial',
    });
    expect(dataOf(prisma.user_subscriptions.updateMany, 0)).toMatchObject({
      status: 'expired',
    });
  });

  /**
   * The status precondition is what makes the sweep safe to run beside a
   * gateway webhook: a row the webhook has already moved no longer matches.
   */
  it('only touches rows still in the status it expects', async () => {
    await service.sweep();

    expect(whereOf(prisma.user_subscriptions.updateMany, 0).status).toBe(
      'trial',
    );
    expect(whereOf(prisma.user_subscriptions.updateMany, 1).status).toBe(
      'active',
    );
  });

  /**
   * A renewal webhook arriving a few hours late must not mark a paying
   * customer delinquent. The gateway owns its own rows.
   */
  it('never flags a gateway-backed subscription', async () => {
    await service.sweep();

    expect(whereOf(prisma.user_subscriptions.updateMany, 1)).toMatchObject({
      stripe_subscription_id: null,
      razorpay_subscription_id: null,
    });
  });

  it('flags an unbacked subscription only after the grace window', async () => {
    process.env.SUBSCRIPTION_GRACE_DAYS = '5';
    const before = Date.now();

    await service.sweep();

    const where = whereOf(prisma.user_subscriptions.updateMany, 1);
    const periodEnd = where.current_period_end as { lt: Date };
    const cutoff = periodEnd.lt.getTime();

    // Five days back from now, give or take the test's own runtime.
    expect(before - cutoff).toBeGreaterThanOrEqual(5 * 86_400_000);
    expect(before - cutoff).toBeLessThan(5 * 86_400_000 + 5_000);
  });

  it('moves a lapsed unbacked subscription to past_due, not cancelled', async () => {
    prisma.user_subscriptions.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 3 });

    const result = await service.sweep();

    expect(result.pastDue).toBe(3);
    // past_due still allows writes (it grades as `grace`), so the sweep
    // never takes the product away from anyone. Cancelling is a human
    // decision made in the admin panel.
    expect(dataOf(prisma.user_subscriptions.updateMany, 1).status).toBe(
      'past_due',
    );
  });

  it('cancels nothing, ever', async () => {
    await service.sweep();

    for (const call of prisma.user_subscriptions.updateMany.mock.calls) {
      const arg = call[0] as { data: { status?: string } };
      expect(arg.data.status).not.toBe('cancelled');
    }
  });
});
