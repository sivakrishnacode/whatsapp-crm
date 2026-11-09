import { describe, expect, it } from 'vitest';

import {
  MIN_DELIVERY_SAMPLE,
  computeCompletion,
  evaluateHealth,
  overallHealth,
  type HealthCheck,
  type HealthEvidence,
  type HealthKey,
} from '@/lib/health/rules';

/**
 * The health contract from the C2.0 handoff, pinned:
 *   - unknown/stale evidence is never Healthy
 *   - completion is independent of runtime health
 *   - every check carries evidence and a timestamp field
 */

const NOW = new Date('2026-11-09T06:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = {
  staleHours: 24,
  lowCreditThreshold: 50,
  deliveryAttentionPct: 10,
  deliveryCriticalPct: 25,
};

function healthy(): HealthEvidence {
  return {
    accountId: '00000000-0000-0000-0000-000000000001',
    wa: {
      status: 'connected',
      phoneNumberId: '123',
      wabaId: '456',
      connectionMethod: 'embedded_signup',
      coexistence: false,
      connectedAt: new Date(NOW.getTime() - 30 * DAY),
      registeredAt: new Date(NOW.getTime() - 30 * DAY),
      subscribedAppsAt: new Date(NOW.getTime() - 30 * DAY),
      lastRegistrationError: null,
      tokenExpiresAt: null,
      limitsSyncedAt: new Date(NOW.getTime() - 2 * HOUR),
      tier: 'TIER_2K',
      quality: 'GREEN',
      updatedAt: new Date(NOW.getTime() - 2 * HOUR),
    },
    out7d: 200,
    failed7d: 4,
    topErrorCode: null,
    topErrorTitle: null,
    topErrorCount: 0,
    lastDeliveredAt: new Date(NOW.getTime() - HOUR),
    everDelivered: true,
    templates: {
      total: 5,
      approved: 5,
      rejected: 0,
      paused: 0,
      pending: 0,
      redQuality: 0,
      updatedAt: new Date(NOW.getTime() - 5 * DAY),
    },
    ig: null,
    web: null,
    webhooks: { active: 0, lastDeliveryAt: null },
    google: null,
    ecommerce: { total: 0, errored: 0, disconnected: 0, lastSyncAt: null },
    apiKeys: { active: 0, expiringSoon: 0, lastUsedAt: null },
    ai: {
      creditMode: 'platform',
      balance: 900,
      walletUpdatedAt: new Date(NOW.getTime() - HOUR),
      activeAgents: 1,
      autoReplyAgents: 1,
    },
    billing: {
      status: 'active',
      trialEndAt: null,
      periodEnd: new Date(NOW.getTime() + 20 * DAY),
      cancelAtPeriodEnd: false,
      updatedAt: new Date(NOW.getTime() - 10 * DAY),
    },
    setup: {
      onboardingCompletedAt: new Date(NOW.getTime() - 40 * DAY),
      members: 3,
      pendingInvites: 0,
    },
  };
}

function check(checks: HealthCheck[], key: HealthKey): HealthCheck {
  const found = checks.find((c) => c.key === key);
  if (!found) throw new Error(`no ${key} check`);
  return found;
}

describe('evaluateHealth', () => {
  it('grades a well-run workspace healthy', () => {
    const checks = evaluateHealth(healthy(), NOW, T);
    expect(overallHealth(checks)).toBe('healthy');
  });

  it('every check carries evidence text', () => {
    for (const c of evaluateHealth(healthy(), NOW, T)) {
      expect(c.evidence.length).toBeGreaterThan(5);
    }
  });

  it('treats stale quality evidence as unknown, never healthy', () => {
    const e = healthy();
    e.wa!.limitsSyncedAt = new Date(NOW.getTime() - 3 * DAY);
    const quality = check(evaluateHealth(e, NOW, T), 'wa_quality');
    expect(quality.state).toBe('unknown');
    expect(quality.evidence).toMatch(/stale/);
    // …and one unknown check keeps the whole account from reading healthy.
    expect(overallHealth(evaluateHealth(e, NOW, T))).toBe('unknown');
  });

  it('treats never-synced quality as unknown', () => {
    const e = healthy();
    e.wa!.limitsSyncedAt = null;
    expect(check(evaluateHealth(e, NOW, T), 'wa_quality').state).toBe(
      'unknown'
    );
  });

  it('maps RED quality to critical', () => {
    const e = healthy();
    e.wa!.quality = 'RED';
    expect(check(evaluateHealth(e, NOW, T), 'wa_quality').state).toBe(
      'critical'
    );
  });

  it('refuses to grade delivery on too small a sample', () => {
    const e = healthy();
    e.out7d = MIN_DELIVERY_SAMPLE - 1;
    e.failed7d = MIN_DELIVERY_SAMPLE - 1;
    expect(check(evaluateHealth(e, NOW, T), 'delivery').state).toBe('unknown');
  });

  it('grades delivery by failure rate and names the top Meta error', () => {
    const e = healthy();
    e.out7d = 339;
    e.failed7d = 102;
    e.topErrorCode = 131049;
    e.topErrorTitle = 'healthy ecosystem engagement';
    e.topErrorCount = 90;
    const delivery = check(evaluateHealth(e, NOW, T), 'delivery');
    expect(delivery.state).toBe('critical');
    expect(delivery.evidence).toContain('131049');
    expect(delivery.action).toMatch(/marketing/i);
  });

  it('attention between the two thresholds', () => {
    const e = healthy();
    e.out7d = 100;
    e.failed7d = 12;
    expect(check(evaluateHealth(e, NOW, T), 'delivery').state).toBe(
      'attention'
    );
  });

  it('a token with no expiry is healthy only when a recent delivery proves it', () => {
    const e = healthy();
    expect(check(evaluateHealth(e, NOW, T), 'wa_token').state).toBe('healthy');
    e.lastDeliveredAt = new Date(NOW.getTime() - 10 * DAY);
    expect(check(evaluateHealth(e, NOW, T), 'wa_token').state).toBe('unknown');
  });

  it('flags an expiring token', () => {
    const e = healthy();
    e.wa!.tokenExpiresAt = new Date(NOW.getTime() + 5 * DAY);
    expect(check(evaluateHealth(e, NOW, T), 'wa_token').state).toBe('critical');
    e.wa!.tokenExpiresAt = new Date(NOW.getTime() + 12 * DAY);
    expect(check(evaluateHealth(e, NOW, T), 'wa_token').state).toBe(
      'attention'
    );
  });

  it('a disconnected number is critical', () => {
    const e = healthy();
    e.wa!.status = 'disconnected';
    expect(check(evaluateHealth(e, NOW, T), 'wa_connection').state).toBe(
      'critical'
    );
  });

  it('webhooks without a recent success are unknown — failures are invisible to it', () => {
    const e = healthy();
    e.webhooks = { active: 2, lastDeliveryAt: null };
    const hooks = check(evaluateHealth(e, NOW, T), 'webhooks');
    expect(hooks.state).toBe('unknown');
    expect(hooks.evidence).toMatch(/cannot see/);
  });

  it('an empty wallet with auto-reply on is critical', () => {
    const e = healthy();
    e.ai.balance = 0;
    expect(check(evaluateHealth(e, NOW, T), 'ai_credits').state).toBe(
      'critical'
    );
    e.ai.autoReplyAgents = 0;
    expect(check(evaluateHealth(e, NOW, T), 'ai_credits').state).toBe(
      'attention'
    );
  });

  it('BYOK is never metered, so never low on credits', () => {
    const e = healthy();
    e.ai.creditMode = 'byok';
    e.ai.balance = 0;
    expect(check(evaluateHealth(e, NOW, T), 'ai_credits').state).toBe(
      'healthy'
    );
  });

  it('past_due is attention (still entitled), expired is critical', () => {
    const e = healthy();
    e.billing.status = 'past_due';
    expect(check(evaluateHealth(e, NOW, T), 'billing').state).toBe('attention');
    e.billing.status = 'expired';
    expect(check(evaluateHealth(e, NOW, T), 'billing').state).toBe('critical');
  });

  it('a workspace with nothing set up is not_configured, not healthy', () => {
    const e = healthy();
    e.wa = null;
    e.out7d = 0;
    e.failed7d = 0;
    e.templates = {
      total: 0,
      approved: 0,
      rejected: 0,
      paused: 0,
      pending: 0,
      redQuality: 0,
      updatedAt: null,
    };
    e.ai.activeAgents = 0;
    e.billing.status = null;
    const checks = evaluateHealth(e, NOW, T);
    expect(checks.every((c) => c.state === 'not_configured')).toBe(true);
    expect(overallHealth(checks)).toBe('not_configured');
  });
});

describe('computeCompletion', () => {
  it('is independent of runtime health', () => {
    const e = healthy();
    e.wa!.quality = 'RED';
    e.out7d = 100;
    e.failed7d = 90;
    expect(overallHealth(evaluateHealth(e, NOW, T))).toBe('critical');
    expect(computeCompletion(e).percent).toBe(100);
  });

  it('leaves untracked items out of the denominator', () => {
    const { items, percent } = computeCompletion(healthy());
    expect(items.find((i) => i.key === 'profile')?.done).toBeNull();
    expect(percent).toBe(100);
  });

  it('weights phone more than team', () => {
    const noPhone = healthy();
    noPhone.wa!.registeredAt = null;
    const noTeam = healthy();
    noTeam.setup.members = 1;
    expect(computeCompletion(noPhone).percent).toBeLessThan(
      computeCompletion(noTeam).percent
    );
  });
});
