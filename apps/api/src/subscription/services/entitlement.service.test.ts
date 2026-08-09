import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementService } from './entitlement.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The behaviour worth pinning here is not the SQL — that lives in
 * migration 075 and is exercised against the database. It is the two
 * decisions this wrapper makes on its own:
 *
 *   1. A lookup that FAILS allows the action. A lookup that says "lapsed"
 *      refuses it. Confusing those two is the difference between an
 *      outage and a working gate.
 *   2. Recording usage never throws. The message has already been sent.
 */

function makePrismaMock() {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

const GOOD_ROW = {
  allowed: true,
  current_usage: 10,
  limit_value: 5000,
  standing: 'good' as const,
  reason: 'ok' as const,
};

describe('EntitlementService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: EntitlementService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrismaMock();
    service = new EntitlementService(prisma as unknown as PrismaService);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('checkLimit', () => {
    it('passes the row through when the check succeeds', async () => {
      prisma.$queryRaw.mockResolvedValue([GOOD_ROW]);

      const check = await service.checkLimit('acc-1', 'messages');

      expect(check).toEqual({
        allowed: true,
        currentUsage: 10,
        limitValue: 5000,
        standing: 'good',
        reason: 'ok',
      });
    });

    it('honours a refusal that the database actually returned', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          allowed: false,
          current_usage: 5000,
          limit_value: 5000,
          standing: 'good',
          reason: 'limit_reached',
        },
      ]);

      const check = await service.checkLimit('acc-1', 'messages');

      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('limit_reached');
    });

    /**
     * The one that matters. A dropped connection or a migration mid-flight
     * must not become an outage for paying customers — the same choice the
     * web app's AuthGate makes for the onboarding gate.
     */
    it('fails OPEN when the lookup itself throws', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection reset'));

      const check = await service.checkLimit('acc-1', 'messages');

      expect(check.allowed).toBe(true);
      expect(check.reason).toBe('check_failed');
    });

    it('fails open when the function returns no row at all', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const check = await service.checkLimit('acc-1', 'messages');

      expect(check.allowed).toBe(true);
      expect(check.reason).toBe('check_failed');
    });

    it('passes the increment through so a fan-out is sized', async () => {
      prisma.$queryRaw.mockResolvedValue([GOOD_ROW]);

      await service.checkLimit('acc-1', 'messages', 4000);

      // Prisma tagged templates put values in the second argument.
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      expect(values).toContain(4000);
    });
  });

  describe('recordUsage', () => {
    it('records the metric and the delta', async () => {
      await service.recordUsage('acc-1', 'broadcasts', 2);

      const values = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(values).toContain('broadcasts');
      expect(values).toContain(2);
    });

    it('does nothing for a zero delta', async () => {
      await service.recordUsage('acc-1', 'messages', 0);

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('never throws — the message has already been sent', async () => {
      prisma.$executeRaw.mockRejectedValue(new Error('deadlock'));

      await expect(
        service.recordUsage('acc-1', 'messages'),
      ).resolves.toBeUndefined();
    });
  });

  describe('refusalMessage', () => {
    it('tells a lapsed account its data is still there', () => {
      const message = service.refusalMessage('messages', {
        allowed: false,
        currentUsage: 0,
        limitValue: 0,
        standing: 'lapsed',
        reason: 'subscription_lapsed',
      });

      expect(message).toMatch(/data is still here/i);
      expect(message).toMatch(/choose a plan/i);
    });

    it('names the limit and how much of it is gone', () => {
      const message = service.refusalMessage('broadcasts', {
        allowed: false,
        currentUsage: 25,
        limitValue: 25,
        standing: 'good',
        reason: 'limit_reached',
      });

      expect(message).toContain('25 of 25 broadcasts this month');
    });
  });
});
