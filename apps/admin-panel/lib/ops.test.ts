import { describe, expect, it } from 'vitest';

import { deriveLifecycle } from '@/lib/lifecycle';
import { DEFAULT_SETTINGS, parseSettings } from '@/lib/settings';
import { activeClock, clockFor, dueDates } from '@/lib/sla';
import { ROLE_CAPABILITIES, STAFF_ROLES, roleCan } from '@/lib/staff/roles';

const NOW = new Date('2026-11-09T06:00:00Z');
const MIN = 60_000;

describe('deriveLifecycle', () => {
  const base = {
    override: null,
    subscriptionStatus: 'active' as const,
    onboardingCompleted: true,
    channelLive: true,
    health: 'healthy' as const,
  };

  it('is active when onboarded, live and nothing critical', () => {
    expect(deriveLifecycle(base).stage).toBe('active');
  });

  it('is onboarding until the wizard is finished or a channel is live', () => {
    expect(deriveLifecycle({ ...base, onboardingCompleted: false }).stage).toBe(
      'onboarding'
    );
    expect(deriveLifecycle({ ...base, channelLive: false }).stage).toBe(
      'onboarding'
    );
  });

  it('is churned once the subscription ends, whatever else is true', () => {
    expect(
      deriveLifecycle({ ...base, subscriptionStatus: 'expired' }).stage
    ).toBe('churned');
    expect(
      deriveLifecycle({
        ...base,
        subscriptionStatus: 'cancelled',
        onboardingCompleted: false,
      }).stage
    ).toBe('churned');
  });

  it('needs attention on a critical check or a failed payment', () => {
    expect(deriveLifecycle({ ...base, health: 'critical' }).stage).toBe(
      'attention'
    );
    expect(
      deriveLifecycle({ ...base, subscriptionStatus: 'past_due' }).stage
    ).toBe('attention');
  });

  it('an operator pin wins and says so', () => {
    const result = deriveLifecycle({ ...base, override: 'archived' });
    expect(result).toMatchObject({ stage: 'archived', pinned: true });
  });

  it('ignores a pin that is not a known stage', () => {
    expect(deriveLifecycle({ ...base, override: 'gibberish' }).pinned).toBe(
      false
    );
  });
});

describe('SLA clocks', () => {
  const target = DEFAULT_SETTINGS.sla.critical;

  it('computes due dates from the target', () => {
    const { firstResponseDueAt, resolutionDueAt } = dueDates(NOW, target);
    expect(firstResponseDueAt.getTime() - NOW.getTime()).toBe(
      target.firstResponseMinutes * MIN
    );
    expect(resolutionDueAt.getTime() - NOW.getTime()).toBe(
      target.resolutionMinutes * MIN
    );
  });

  it('runs, warns in the last 20%, then breaches', () => {
    const startedAt = NOW;
    const dueAt = new Date(NOW.getTime() + 100 * MIN);
    expect(
      clockFor({
        dueAt,
        stoppedAt: null,
        startedAt,
        now: new Date(NOW.getTime() + 10 * MIN),
      }).state
    ).toBe('running');
    expect(
      clockFor({
        dueAt,
        stoppedAt: null,
        startedAt,
        now: new Date(NOW.getTime() + 85 * MIN),
      }).state
    ).toBe('due_soon');
    expect(
      clockFor({
        dueAt,
        stoppedAt: null,
        startedAt,
        now: new Date(NOW.getTime() + 101 * MIN),
      }).state
    ).toBe('breached');
  });

  it('a stopped clock is met or missed, never running', () => {
    const dueAt = new Date(NOW.getTime() + 30 * MIN);
    expect(
      clockFor({
        dueAt,
        stoppedAt: new Date(NOW.getTime() + 20 * MIN),
        startedAt: NOW,
        now: NOW,
      }).state
    ).toBe('met');
    expect(
      clockFor({
        dueAt,
        stoppedAt: new Date(NOW.getTime() + 40 * MIN),
        startedAt: NOW,
        now: NOW,
      }).state
    ).toBe('breached');
  });

  it('switches from first response to resolution once answered', () => {
    const ticket = {
      status: 'in_progress',
      created_at: NOW,
      first_response_due_at: new Date(NOW.getTime() + 30 * MIN),
      first_responded_at: null as Date | null,
      resolution_due_at: new Date(NOW.getTime() + 240 * MIN),
      resolved_at: null,
    };
    expect(activeClock(ticket, NOW).kind).toBe('first_response');
    ticket.first_responded_at = new Date(NOW.getTime() + 5 * MIN);
    expect(activeClock(ticket, NOW).kind).toBe('resolution');
  });
});

describe('parseSettings', () => {
  it('falls back to defaults for missing and nonsense values', () => {
    const parsed = parseSettings([
      { key: 'healthStaleHours', value: -5 },
      { key: 'renewalWindowDays', value: 12 },
      { key: 'sla', value: { critical: { firstResponseMinutes: 0 } } },
    ]);
    expect(parsed.healthStaleHours).toBe(DEFAULT_SETTINGS.healthStaleHours);
    expect(parsed.renewalWindowDays).toBe(DEFAULT_SETTINGS.renewalWindowDays);
    expect(parsed.sla.critical).toEqual(DEFAULT_SETTINGS.sla.critical);
  });

  it('never lets a resolution target fall below the first-response target', () => {
    const parsed = parseSettings([
      {
        key: 'sla',
        value: { high: { firstResponseMinutes: 600, resolutionMinutes: 60 } },
      },
    ]);
    expect(parsed.sla.high.resolutionMinutes).toBeGreaterThanOrEqual(600);
  });

  it('keeps the critical delivery threshold at or above attention', () => {
    const parsed = parseSettings([
      { key: 'deliveryAttentionPct', value: 40 },
      { key: 'deliveryCriticalPct', value: 20 },
    ]);
    expect(parsed.deliveryCriticalPct).toBeGreaterThanOrEqual(40);
  });
});

describe('roles', () => {
  it('only Super Admin manages staff and settings', () => {
    for (const role of STAFF_ROLES) {
      expect(roleCan(role, 'staff.manage')).toBe(role === 'super_admin');
      expect(roleCan(role, 'settings.manage')).toBe(role === 'super_admin');
    }
  });

  it('L1 sees no money', () => {
    expect(roleCan('support_l1', 'billing.read')).toBe(false);
    expect(roleCan('support_l1', 'credits.adjust')).toBe(false);
  });

  it('only Super Admin and Billing move credits or edit prices', () => {
    for (const role of STAFF_ROLES) {
      const expected = role === 'super_admin' || role === 'billing';
      expect(roleCan(role, 'credits.adjust')).toBe(expected);
      expect(roleCan(role, 'billing.manage')).toBe(expected);
    }
  });

  it('the internal model mapping is Super Admin and L3 only', () => {
    const holders = STAFF_ROLES.filter((r) =>
      roleCan(r, 'catalog.read_mapping')
    );
    expect(holders.sort()).toEqual(['super_admin', 'support_l3']);
  });

  it('every role can read clients', () => {
    for (const role of STAFF_ROLES)
      expect(ROLE_CAPABILITIES[role].has('clients.read')).toBe(true);
  });
});
