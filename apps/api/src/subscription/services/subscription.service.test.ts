import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionService } from './subscription.service';
import type { PrismaService } from '../../prisma/prisma.service';

// The limits/usage logic lives in Postgres SECURITY DEFINER RPCs — these
// tests pin the service's parameterized calls and its fail-closed mapping.

function makePrismaMock() {
  return { $queryRawUnsafe: vi.fn() };
}

describe('SubscriptionService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: SubscriptionService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SubscriptionService(prisma as unknown as PrismaService);
  });

  describe('getUserSubscription', () => {
    it('calls the RPC with the userId as a bind parameter and returns the row', async () => {
      const row = { plan_name: 'pro', status: 'active' };
      prisma.$queryRawUnsafe.mockResolvedValueOnce([row]);

      await expect(service.getUserSubscription('user-1')).resolves.toEqual(row);
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('get_user_subscription($1::uuid)'),
        'user-1',
      );
    });

    it('returns null when the RPC yields no rows', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await expect(service.getUserSubscription('user-1')).resolves.toBeNull();
    });

    it('propagates RPC errors (caller decides how to degrade)', async () => {
      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
      await expect(service.getUserSubscription('user-1')).rejects.toThrow('db down');
    });
  });

  describe('checkSubscriptionLimit', () => {
    it('maps an allowed row, coercing SQL types', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { allowed: true, currentUsage: '42', limitValue: '100', reason: '' },
      ]);

      await expect(
        service.checkSubscriptionLimit('user-1', 'contacts'),
      ).resolves.toEqual({
        allowed: true,
        currentUsage: 42,
        limitValue: 100,
        reason: '',
      });
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('check_subscription_limit($1::uuid, $2, $3::integer)'),
        'user-1',
        'contacts',
        1,
      );
    });

    it('keeps a null limitValue null (unlimited plans)', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { allowed: true, currentUsage: 5, limitValue: null, reason: '' },
      ]);
      const result = await service.checkSubscriptionLimit('user-1', 'messages', 3);
      expect(result.limitValue).toBeNull();
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        'user-1',
        'messages',
        3,
      );
    });

    it('fails closed when no subscription row exists', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await expect(
        service.checkSubscriptionLimit('user-1', 'broadcasts'),
      ).resolves.toEqual({
        allowed: false,
        currentUsage: 0,
        limitValue: 0,
        reason: 'No subscription found',
      });
    });

    it('fails closed when the RPC errors', async () => {
      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('boom'));
      await expect(
        service.checkSubscriptionLimit('user-1', 'flows'),
      ).resolves.toEqual({
        allowed: false,
        currentUsage: 0,
        limitValue: 0,
        reason: 'Error checking subscription limit',
      });
    });
  });

  describe('incrementUsage / decrementUsage', () => {
    it('returns the RPC success flag', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ success: true }]);
      await expect(service.incrementUsage('user-1', 'messages')).resolves.toBe(true);
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('increment_usage($1::uuid, $2, $3::integer)'),
        'user-1',
        'messages',
        1,
      );

      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ success: false }]);
      await expect(service.decrementUsage('user-1', 'messages', 2)).resolves.toBe(false);
    });

    it('returns false instead of throwing when the RPC errors', async () => {
      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('boom'));
      await expect(service.incrementUsage('user-1', 'contacts')).resolves.toBe(false);

      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('boom'));
      await expect(service.decrementUsage('user-1', 'contacts')).resolves.toBe(false);
    });
  });
});
