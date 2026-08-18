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
    // The owner's profile, so a locked-out teammate can be told a name.
    profile: { findUnique: vi.fn() },
    account_onboarding: { findUnique: vi.fn(), upsert: vi.fn() },
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

/**
 * The upsert on this mock whose `update` half carries `key`.
 *
 * `account_onboarding` is upserted twice on the trial-granting path — once
 * to latch `trial_granted_at`, once to set `completed_at` — so indexing
 * call [0] would silently assert against whichever happens to run first.
 */
function upsertTouching(
  mock: { mock: { calls: unknown[][] } },
  key: string,
): UpsertCall | undefined {
  return mock.mock.calls
    .map((call) => call[0] as UpsertCall)
    .find((call) => key in call.update || key in call.create);
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
  prisma.profile.findUnique.mockResolvedValue({
    fullName: 'Owner Ola',
    email: 'owner@acme.test',
  });
  // The trial latch (migration 074). Read from the same row getState
  // already loads, so it mirrors whatever `onboarding` says.
  prisma.account_onboarding.findUnique.mockResolvedValue(
    onboarding
      ? { trial_granted_at: onboarding.trial_granted_at ?? null }
      : null,
  );
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
          subscription_plans: {
            name: 'STARTER',
            display_name: 'Starter',
            price_monthly: 300,
            price_yearly: 3000,
          },
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('done');
      expect(state.subscription).toEqual({
        planName: 'STARTER',
        planDisplayName: 'Starter',
        status: 'trial',
        trialEndsAt: '2026-09-01T00:00:00.000Z',
        // Major units — what the locked screen prints as the amount due.
        priceMonthly: 300,
        priceYearly: 3000,
        isEnquiryOnly: false,
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

    /**
     * ⚠️ THE REGRESSION THIS FILE EXISTS TO CATCH.
     *
     * A spent trial with nothing paid used to resolve to `plan`, where
     * every button offered a free trial the 074 latch would refuse to
     * grant. Pressing one returned `plan` again — a lockout with no exit
     * inside the product, since `/pricing` lives behind the same gate.
     */
    it('sends a lapsed account with a spent trial to the billing screen', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          goals: [],
          completed_at: new Date('2026-08-06T00:00:00Z'),
          trial_granted_at: new Date('2026-08-06T00:00:00Z'),
        },
        subscription: {
          status: 'expired',
          trial_end_at: new Date('2026-08-18T00:00:00Z'),
          subscription_plans: {
            name: 'STARTER',
            display_name: 'Starter',
            price_monthly: 300,
            price_yearly: 3000,
          },
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('billing');
      expect(state.trialAvailable).toBe(false);
      // The screen needs the amount and the plan to name in its headline.
      expect(state.subscription?.priceMonthly).toBe(300);
    });

    /**
     * `past_due` is dunning, not the end. `get_account_entitlement` grades
     * it `grace` and still allows writes, and the sweep sets it without a
     * human involved — so locking the product on it would take a paying
     * customer's inbox away over one late renewal webhook.
     */
    it('leaves a past_due account inside the product', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          goals: [],
          completed_at: new Date(),
          trial_granted_at: new Date('2026-01-01T00:00:00Z'),
        },
        subscription: {
          status: 'past_due',
          trial_end_at: new Date('2026-01-16T00:00:00Z'),
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('done');
    });

    /**
     * With no subscription row there is no plan to renew, so "pay to
     * continue" has nothing to name — picking one comes first.
     */
    it('sends an account with no subscription at all to the plan step', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          goals: [],
          completed_at: new Date(),
          trial_granted_at: new Date('2026-01-01T00:00:00Z'),
        },
        subscription: null,
      });

      const state = await service.getState('acc-1');

      expect(state.step).toBe('plan');
    });

    /**
     * Checkout is owner-only, and `user_subscriptions` is keyed by the
     * owner — a teammate's payment would land on a row nothing reads.
     */
    it('marks only the owner as the owner, and names them for everyone else', async () => {
      primeState(prisma, subscriptions, { ownerUserId: 'owner-1' });

      const asOwner = await service.getState('acc-1', 'owner-1');
      const asTeammate = await service.getState('acc-1', 'member-9');
      const asServer = await service.getState('acc-1');

      expect(asOwner.viewer.isOwner).toBe(true);
      expect(asTeammate.viewer.isOwner).toBe(false);
      // No viewer supplied: nobody is the owner, so no checkout is offered.
      expect(asServer.viewer.isOwner).toBe(false);
      expect(asTeammate.owner).toEqual({
        name: 'Owner Ola',
        email: 'owner@acme.test',
      });
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
        upsertTouching(prisma.account_onboarding.upsert, 'completed_at')?.update
          .completed_at,
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

    it('latches the trial so it can only ever be granted once', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions);

      await service.selectPlan('acc-1', 'STARTER');

      expect(
        upsertTouching(prisma.account_onboarding.upsert, 'trial_granted_at')
          ?.update.trial_granted_at,
      ).toBeInstanceOf(Date);
    });

    /**
     * The leak this closes: every call used to write trial_start_at = now,
     * so clicking between Starter, Growth and Enterprise handed out a fresh
     * fortnight each time.
     */
    it('does not restart the trial when switching plans mid-trial', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, {
        onboarding: {
          completed_at: new Date('2026-08-01T00:00:00Z'),
          trial_granted_at: new Date('2026-08-01T00:00:00Z'),
        },
        subscription: {
          status: 'trial',
          trial_start_at: new Date('2026-08-01T00:00:00Z'),
          trial_end_at: new Date('2100-01-01T00:00:00Z'),
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      await service.selectPlan('acc-1', 'STARTER');

      const { update } = upsertCall(prisma.user_subscriptions.upsert);
      expect(update.plan_id).toBe('plan-starter');
      expect(update.status).toBe('trial');
      // The clock is not touched at all — not extended, not reset.
      expect(update).not.toHaveProperty('trial_start_at');
      expect(update).not.toHaveProperty('trial_end_at');
      expect(update).not.toHaveProperty('current_period_end');
      expect(
        upsertTouching(prisma.account_onboarding.upsert, 'trial_granted_at'),
      ).toBeUndefined();
    });

    /**
     * ⚠️ This used to assert the opposite — that the write went through and
     * landed `expired`. That was the permanent lockout: the wizard read
     * `expired` as "not entitled", re-rendered the plan picker, and the
     * button the customer had just pressed was the only thing on screen.
     * Refusing sends them to `/billing`, which can actually take payment.
     */
    it('refuses a lapsed account whose one trial is already spent', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, {
        onboarding: {
          completed_at: new Date('2026-01-01T00:00:00Z'),
          trial_granted_at: new Date('2026-01-01T00:00:00Z'),
        },
        subscription: {
          status: 'expired',
          trial_start_at: new Date('2026-01-01T00:00:00Z'),
          trial_end_at: new Date('2026-01-16T00:00:00Z'),
          subscription_plans: { name: 'STARTER', display_name: 'Starter' },
        },
      });

      await expect(service.selectPlan('acc-1', 'STARTER')).rejects.toThrow(
        /free trial has ended/,
      );
      // Nothing written: a second press must not rewrite which plan an
      // unpaid account is recorded against.
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
    });

    /**
     * The other half of the same rule: a lapsed row with NO trial ever
     * granted is somebody an operator expired by hand, and they are still
     * owed the trial they never had. `plan` remains the right screen.
     */
    it('still starts the trial for a lapsed account that never had one', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, {
        onboarding: { completed_at: new Date('2026-01-01T00:00:00Z') },
        subscription: {
          status: 'expired',
          trial_start_at: null,
          trial_end_at: null,
          subscription_plans: { name: 'STARTER', display_name: 'Starter' },
        },
      });

      await service.selectPlan('acc-1', 'STARTER');

      expect(upsertCall(prisma.user_subscriptions.upsert).update.status).toBe(
        'trial',
      );
    });

    it('refuses to move an account that is already paying', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, {
        subscription: {
          status: 'active',
          trial_end_at: null,
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      await expect(service.selectPlan('acc-1', 'STARTER')).rejects.toThrow(
        /already has a paid plan/,
      );
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
    });

    /**
     * Writing 'manual' over a gateway-backed row is how a record comes to
     * claim nobody is charging a customer Razorpay charges every month.
     */
    it('leaves payment_method alone when a gateway subscription is attached', async () => {
      prisma.subscription_plans.findUnique.mockResolvedValue(STARTER);
      primeState(prisma, subscriptions, {
        subscription: {
          status: 'cancelled',
          trial_end_at: null,
          razorpay_subscription_id: 'sub_ABC',
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      await service.selectPlan('acc-1', 'STARTER');

      expect(
        upsertCall(prisma.user_subscriptions.upsert).update,
      ).not.toHaveProperty('payment_method');
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
        upsertTouching(prisma.account_onboarding.upsert, 'completed_at')?.update
          .completed_at,
      ).toBeInstanceOf(Date);
    });

    /**
     * The bug: /pricing exposes this endpoint to accounts that already have
     * a subscription, and the enquiry used to run the same upsert as the
     * wizard — so a paying Growth customer who asked a question about
     * Enterprise was moved onto a free Enterprise trial, and their MRR
     * silently became zero.
     */
    it('leaves a live subscription completely alone', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          completed_at: new Date('2026-08-01T00:00:00Z'),
          trial_granted_at: new Date('2026-08-01T00:00:00Z'),
        },
        subscription: {
          status: 'active',
          trial_end_at: null,
          subscription_plans: { name: 'GROWTH', display_name: 'Growth' },
        },
      });

      const state = await service.submitEnquiry('acc-1', 'user-9', enquiry);

      expect(prisma.plan_enquiries.create).toHaveBeenCalledTimes(1);
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
      expect(state.subscription?.planName).toBe('GROWTH');
    });

    it('leaves a running trial alone too', async () => {
      primeState(prisma, subscriptions, {
        onboarding: {
          completed_at: new Date('2026-08-01T00:00:00Z'),
          trial_granted_at: new Date('2026-08-01T00:00:00Z'),
        },
        subscription: {
          status: 'trial',
          trial_end_at: new Date('2100-01-01T00:00:00Z'),
          subscription_plans: { name: 'STARTER', display_name: 'Starter' },
        },
      });

      await service.submitEnquiry('acc-1', 'user-9', enquiry);

      expect(prisma.plan_enquiries.create).toHaveBeenCalledTimes(1);
      expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
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
