import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SubscriptionService } from '../../subscription/services/subscription.service';

// The interesting behaviour here is the step machine and the fact that
// the subscription is written for the account OWNER, not the caller —
// both are easy to regress and neither is visible from the controller.

const STARTER = {
  id: 'plan-starter',
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
  is_active: true,
};

function makePrismaMock() {
  return {
    account: { findUnique: vi.fn(), update: vi.fn() },
    account_onboarding: { upsert: vi.fn() },
    subscription_plans: { findUnique: vi.fn() },
    user_subscriptions: { findUnique: vi.fn(), upsert: vi.fn() },
    plan_enquiries: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
}

/** The two halves of a Prisma upsert, as plain bags for assertions. */
interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/**
 * First argument of an upsert mock, typed.
 *
 * `vi.fn()` types its calls as `any[]`, which trips no-unsafe-assignment
 * the moment a test destructures one. Narrowing here keeps that cast in
 * a single place instead of at every assertion.
 */
function upsertCall(mock: { mock: { calls: unknown[][] } }): UpsertCall {
  return mock.mock.calls[0][0] as UpsertCall;
}

/** First argument of a `create` mock, typed. Same reasoning as above. */
function createCall(mock: { mock: { calls: unknown[][] } }): {
  data: Record<string, unknown>;
} {
  return mock.mock.calls[0][0] as { data: Record<string, unknown> };
}

/** The plan catalogue is SubscriptionService's job, not this service's. */
function makeSubscriptionsMock() {
  return { listSelectablePlans: vi.fn() };
}

/** Shape SubscriptionService.listSelectablePlans returns. */
function planView(overrides: Record<string, unknown> = {}) {
  return {
    name: 'STARTER',
    displayName: 'Starter',
    description: 'For growing businesses',
    priceMonthly: 300,
    priceYearly: 3000,
    trialDays: 15,
    features: ['1,000 contacts'],
    maxContacts: 1000,
    maxMessagesMonthly: 5000,
    maxBroadcastsMonthly: 25,
    maxFlows: 10,
    maxTeamMembers: 3,
    maxStorageMb: 1024,
    isEnquiryOnly: false,
    ...overrides,
  };
}

/** Shapes the reads getState() makes, so tests state only what differs. */
function primeState(
  prisma: ReturnType<typeof makePrismaMock>,
  subscriptions: ReturnType<typeof makeSubscriptionsMock>,
  {
    onboarding = null,
    subscription = null,
    name = 'Acme',
    ownerUserId = 'owner-1',
  }: {
    onboarding?: Record<string, unknown> | null;
    subscription?: Record<string, unknown> | null;
    name?: string;
    ownerUserId?: string;
  } = {},
) {
  prisma.account.findUnique.mockResolvedValue({
    name,
    ownerUserId,
    account_onboarding: onboarding,
  });
  prisma.user_subscriptions.findUnique.mockResolvedValue(subscription);
  subscriptions.listSelectablePlans.mockResolvedValue([planView()]);
}

describe('OnboardingService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let subscriptions: ReturnType<typeof makeSubscriptionsMock>;
  let service: OnboardingService;

  beforeEach(() => {
    prisma = makePrismaMock();
    subscriptions = makeSubscriptionsMock();
    service = new OnboardingService(
      prisma as unknown as PrismaService,
      subscriptions as unknown as SubscriptionService,
    );
  });

  describe('getState', () => {
    it('starts at the workspace step when nothing has been answered', async () => {
      primeState(prisma, subscriptions);

      const state = await service.getState('acc-1');

      expect(state.step).toBe('workspace');
      expect(state.workspace.name).toBe('Acme');
      expect(state.workspace.goals).toEqual([]);
    });

    it('moves to the plan step once the workspace is saved but unfinished', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          goals: ['broadcasts'],
          team_size: '2-5',
          completed_at: null,
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('plan');
    });

    it('is done when onboarding completed and the owner holds a trial', async () => {
      primeState(prisma, subscriptions, {
        onboarding: { goals: [], completed_at: new Date() },
        subscription: {
          status: 'trial',
          trial_end_at: new Date('2026-09-01T00:00:00Z'),
          subscription_plans: { name: 'STARTER', display_name: 'Starter' },
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('done');
      expect(state.subscription).toEqual({
        planName: 'STARTER',
        planDisplayName: 'Starter',
        status: 'trial',
        trialEndsAt: '2026-09-01T00:00:00.000Z',
      });
    });

    it('sends a completed account back to the plan step once cancelled', async () => {
      // There is no free tier to fall back to, so a cancelled account
      // has to choose again rather than keep its access.
      primeState(prisma, subscriptions, {
        onboarding: { goals: [], completed_at: new Date() },
        subscription: {
          status: 'cancelled',
          trial_end_at: null,
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('plan');
    });

    // The catalogue itself (which plans, in what order, FREE excluded)
    // is SubscriptionService's contract and is covered there. All this
    // service owes is passing it through untouched.
    it('surfaces the shared plan catalogue verbatim', async () => {
      primeState(prisma, subscriptions);
      subscriptions.listSelectablePlans.mockResolvedValue([
        planView(),
        planView({
          name: 'ENTERPRISE',
          displayName: 'Enterprise',
          isEnquiryOnly: true,
        }),
      ]);

      const state = await service.getState('acc-1');

      expect(state.plans.map((plan) => plan.name)).toEqual([
        'STARTER',
        'ENTERPRISE',
      ]);
      expect(state.plans.map((plan) => plan.isEnquiryOnly)).toEqual([
        false,
        true,
      ]);
    });
  });

  describe('saveWorkspace', () => {
    it('renames the account and stores the answers in one transaction', async () => {
      primeState(prisma, subscriptions);

      await service.saveWorkspace('acc-1', {
        workspaceName: '  Acme Retail  ',
        goals: ['broadcasts', 'flows'],
        teamSize: '2-5',
        referralSource: 'google',
      });

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { name: 'Acme Retail' },
      });
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });

    it('drops referral free-text when the source is not "other"', async () => {
      primeState(prisma, subscriptions);

      await service.saveWorkspace('acc-1', {
        workspaceName: 'Acme',
        goals: [],
        teamSize: '1',
        referralSource: 'google',
        referralOther: 'a friend told me',
      });

      expect(upsertCall(prisma.account_onboarding.upsert).create).toMatchObject(
        { referral_other: null },
      );
    });

    it('keeps referral free-text when the source is "other"', async () => {
      primeState(prisma, subscriptions);

      await service.saveWorkspace('acc-1', {
        workspaceName: 'Acme',
        goals: [],
        teamSize: '1',
        referralSource: 'other',
        referralOther: '  a podcast  ',
      });

      expect(upsertCall(prisma.account_onboarding.upsert).create).toMatchObject(
        { referral_other: 'a podcast' },
      );
    });

    it('rejects a whitespace-only workspace name', async () => {
      await expect(
        service.saveWorkspace('acc-1', {
          workspaceName: '   ',
          goals: [],
          teamSize: '1',
          referralSource: 'google',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not complete onboarding — the plan step still has to run', async () => {
      primeState(prisma, subscriptions);

      await service.saveWorkspace('acc-1', {
        workspaceName: 'Acme',
        goals: [],
        teamSize: '1',
        referralSource: 'google',
      });

      const upsertArg = upsertCall(prisma.account_onboarding.upsert);
      expect(upsertArg.create).not.toHaveProperty('completed_at');
      expect(upsertArg.update).not.toHaveProperty('completed_at');
    });
  });

  describe('selectPlan', () => {
    it('starts a trial for the account OWNER, not the caller', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, { ownerUserId: 'owner-1' });

      await service.selectPlan('acc-1', 'STARTER');

      expect(prisma.user_subscriptions.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user_id: 'owner-1' } }),
      );
      const { create } = upsertCall(prisma.user_subscriptions.upsert);
      expect(create.status).toBe('trial');
      expect(create.plan_id).toBe('plan-starter');
      expect(create.trial_end_at).toBeInstanceOf(Date);
    });

    it('marks onboarding complete', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions);

      await service.selectPlan('acc-1', 'STARTER');

      expect(
        upsertCall(prisma.account_onboarding.upsert).update.completed_at,
      ).toBeInstanceOf(Date);
    });

    it('accepts a lowercase plan name', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions);

      await service.selectPlan('acc-1', 'starter');

      expect(prisma.subscription_plans.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: 'STARTER' } }),
      );
    });

    it('refuses the retired free tier by name', async () => {
      await expect(service.selectPlan('acc-1', 'FREE')).rejects.toThrow(
        /no longer available/,
      );
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
    });

    it('refuses a plan that exists but has been deactivated', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue({
        ...STARTER,
        is_active: false,
      });

      await expect(service.selectPlan('acc-1', 'STARTER')).rejects.toThrow(
        /inactive plan/,
      );
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
    });

    it('activates immediately when the plan carries no trial', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue({
        ...STARTER,
        trial_days: null,
      });
      primeState(prisma, subscriptions);

      await service.selectPlan('acc-1', 'STARTER');

      const { create } = upsertCall(prisma.user_subscriptions.upsert);
      expect(create.status).toBe('active');
      expect(create.trial_end_at).toBeNull();
    });

    it('leaves gateway ids alone when re-running after a cancellation', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions);

      await service.selectPlan('acc-1', 'STARTER');

      const { update } = upsertCall(prisma.user_subscriptions.upsert);
      expect(update).not.toHaveProperty('razorpay_subscription_id');
      expect(update).not.toHaveProperty('stripe_subscription_id');
    });
  });

  describe('submitEnquiry', () => {
    const enquiry = {
      fullName: 'Ada Lovelace',
      workEmail: 'ada@example.com',
      phone: ' +919876543210 ',
      message: '  200 agents  ',
    };

    beforeEach(() => {
      prisma.subscription_plans.findUnique.mockResolvedValue({
        ...STARTER,
        id: 'plan-ent',
        name: 'ENTERPRISE',
      });
      primeState(prisma, subscriptions);
    });

    it('records the enquiry against the account and the caller', async () => {
      await service.submitEnquiry('acc-1', 'user-9', enquiry);

      expect(createCall(prisma.plan_enquiries.create).data).toMatchObject({
        account_id: 'acc-1',
        user_id: 'user-9',
        full_name: 'Ada Lovelace',
        phone: '+919876543210',
        message: '200 agents',
      });
    });

    it('provisions a trial so the hard gate does not lock them out while sales replies', async () => {
      await service.submitEnquiry('acc-1', 'user-9', enquiry);

      const { create } = upsertCall(prisma.user_subscriptions.upsert);
      expect(create.plan_id).toBe('plan-ent');
      expect(create.status).toBe('trial');
      expect(
        upsertCall(prisma.account_onboarding.upsert).update.completed_at,
      ).toBeInstanceOf(Date);
    });

    it('stores empty optional fields as null rather than blank strings', async () => {
      await service.submitEnquiry('acc-1', 'user-9', {
        fullName: 'Ada',
        workEmail: 'ada@example.com',
        phone: '   ',
        message: '',
      });

      expect(createCall(prisma.plan_enquiries.create).data).toMatchObject({
        phone: null,
        message: null,
        company_size: null,
      });
    });
  });
});
