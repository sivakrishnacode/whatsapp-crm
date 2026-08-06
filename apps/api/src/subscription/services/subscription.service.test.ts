import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionService } from './subscription.service';
import type { PrismaService } from '../../prisma/prisma.service';

// The limits/usage logic lives in Postgres SECURITY DEFINER RPCs — these
// tests pin the service's parameterized calls and its fail-closed mapping.

function makePrismaMock() {
  return {
    $queryRawUnsafe: vi.fn(),
    subscription_plans: { findMany: vi.fn() },
  };
}

/** A row as Prisma returns it, snake_case and Decimal-ish. */
function planRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'STARTER',
    display_name: 'Starter',
    description: 'For growing businesses',
    price_monthly: 300,
    price_yearly: 3000,
    trial_days: 15,
    features: ['1,000 contacts'],
    max_contacts: 1000,
    max_messages_monthly: 5000,
    max_broadcasts_monthly: 25,
    max_flows: 10,
    max_team_members: 3,
    max_storage_mb: 1024,
    ...overrides,
  };
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
      await expect(service.getUserSubscription('user-1')).rejects.toThrow(
        'db down',
      );
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
        expect.stringContaining(
          'check_subscription_limit($1::uuid, $2, $3::integer)',
        ),
        'user-1',
        'contacts',
        1,
      );
    });

    it('keeps a null limitValue null (unlimited plans)', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { allowed: true, currentUsage: 5, limitValue: null, reason: '' },
      ]);
      const result = await service.checkSubscriptionLimit(
        'user-1',
        'messages',
        3,
      );
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
      await expect(service.incrementUsage('user-1', 'messages')).resolves.toBe(
        true,
      );
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('increment_usage($1::uuid, $2, $3::integer)'),
        'user-1',
        'messages',
        1,
      );

      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ success: false }]);
      await expect(
        service.decrementUsage('user-1', 'messages', 2),
      ).resolves.toBe(false);
    });

    it('returns false instead of throwing when the RPC errors', async () => {
      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('boom'));
      await expect(service.incrementUsage('user-1', 'contacts')).resolves.toBe(
        false,
      );

      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('boom'));
      await expect(service.decrementUsage('user-1', 'contacts')).resolves.toBe(
        false,
      );
    });
  });

  // This catalogue is the single source for both the pricing page and
  // the signup wizard, so what it excludes matters as much as what it
  // returns.
  describe('listSelectablePlans', () => {
    it('excludes the retired free tier and sorts cheapest first', async () => {
      prisma.subscription_plans.findMany.mockResolvedValueOnce([]);

      await service.listSelectablePlans();

      expect(prisma.subscription_plans.findMany).toHaveBeenCalledWith({
        where: { is_active: true, name: { not: 'FREE' } },
        orderBy: { price_monthly: 'asc' },
      });
    });

    it('flags Enterprise as enquiry-only so the UI shows a form, not a price', async () => {
      prisma.subscription_plans.findMany.mockResolvedValueOnce([
        planRow(),
        planRow({ name: 'ENTERPRISE', display_name: 'Enterprise' }),
      ]);

      const plans = await service.listSelectablePlans();

      expect(plans.map((plan) => plan.isEnquiryOnly)).toEqual([false, true]);
    });

    it('puts Enterprise last even though its price sorts it first', async () => {
      // Enterprise is priced by hand, so price_monthly is 0 — a plain
      // price-ascending sort would show the top tier before the entry
      // one. This is exactly what the DB returns today.
      prisma.subscription_plans.findMany.mockResolvedValueOnce([
        planRow({ name: 'ENTERPRISE', display_name: 'Enterprise', price_monthly: 0 }),
        planRow({ name: 'STARTER', price_monthly: 300 }),
        planRow({ name: 'GROWTH', display_name: 'Growth', price_monthly: 500 }),
      ]);

      const plans = await service.listSelectablePlans();

      expect(plans.map((plan) => plan.name)).toEqual([
        'STARTER',
        'GROWTH',
        'ENTERPRISE',
      ]);
    });

    it('keeps null max_flows as unlimited rather than coercing it to zero', async () => {
      prisma.subscription_plans.findMany.mockResolvedValueOnce([
        planRow({ max_flows: null }),
      ]);

      const [plan] = await service.listSelectablePlans();

      expect(plan.maxFlows).toBeNull();
    });

    it('converts Decimal prices to numbers and survives a null price', async () => {
      prisma.subscription_plans.findMany.mockResolvedValueOnce([
        planRow({ price_monthly: null, price_yearly: null }),
      ]);

      const [plan] = await service.listSelectablePlans();

      expect(plan.priceMonthly).toBe(0);
      expect(plan.priceYearly).toBe(0);
    });

    it('falls back to an empty feature list when the JSON column is not an array', async () => {
      // `features` is JSONB with a '[]' default, but nothing in the DB
      // enforces the shape — a hand-edited row could hold an object.
      prisma.subscription_plans.findMany.mockResolvedValueOnce([
        planRow({ features: { bullet: 'nope' } }),
      ]);

      const [plan] = await service.listSelectablePlans();

      expect(plan.features).toEqual([]);
    });
  });
});
