import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionWebhooksController } from './subscription-webhooks.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AiCreditsService } from '../../ai/credits/ai-credits.service';

/**
 * ⚠️ A CAPTURED PAYMENT MUST NEVER LAND `expired`.
 *
 * This handler used to run the same status maths as a plan CHANGE: grant a
 * trial if the workspace had not used one, otherwise carry the old window
 * forward and land `expired` if it had lapsed. For a plan change with no
 * money involved that is right. For a payment it was catastrophic, and in
 * exactly the case the /billing screen exists to serve: a lapsed customer
 * paying to get back in was set straight back to `expired` — by their own
 * successful payment. Worse, this webhook lands AFTER the browser's
 * confirm-payment, so it overwrote the `active` that had just let them in.
 * Pay, get in, get thrown out again.
 *
 * The other half: a first-time payer with no trial yet was marked `trial`
 * with a fresh 15-day window, so they were recorded as not-yet-paying and
 * never counted toward MRR.
 */

const WEBHOOK_SECRET = 'test_webhook_secret';

function makePrismaMock() {
  return {
    user_subscriptions: { findUnique: vi.fn(), upsert: vi.fn() },
    subscription_plans: { findUnique: vi.fn() },
    profile: { findUnique: vi.fn() },
    account_onboarding: { findUnique: vi.fn(), upsert: vi.fn() },
    ai_credit_orders: { findFirst: vi.fn() },
  };
}

/** Minimal express Response: only status().json() is used. */
function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** A signed raw-body request, the way Razorpay sends one. */
function makeReq(event: unknown) {
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody.toString('utf8'))
    .digest('hex');

  return {
    headers: { 'x-razorpay-signature': signature },
    rawBody,
  };
}

function capturedPayment(notes: Record<string, string>) {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_abc123',
          order_id: 'order_TQiCDAwBY8u63y',
          notes,
        },
      },
    },
  };
}

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

describe('SubscriptionWebhooksController — Razorpay payment captured', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let controller: SubscriptionWebhooksController;

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    prisma = makePrismaMock();
    prisma.subscription_plans.findUnique.mockResolvedValue({
      id: 'plan-starter',
      trial_days: 15,
    });
    prisma.profile.findUnique.mockResolvedValue({ accountId: 'acc-1' });
    // Not a credit top-up — this order is a plan payment.
    prisma.ai_credit_orders.findFirst.mockResolvedValue(null);

    controller = new SubscriptionWebhooksController(
      prisma as unknown as PrismaService,
      { creditOrder: vi.fn() } as unknown as AiCreditsService,
    );
  });

  async function deliver(notes: Record<string, string>) {
    const res = makeRes();
    await controller.handleRazorpayWebhook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq(capturedPayment(notes)) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    return prisma.user_subscriptions.upsert.mock.calls[0]?.[0] as
      | UpsertCall
      | undefined;
  }

  const NOTES = {
    userId: 'owner-1',
    planName: 'STARTER',
    billingCycle: 'monthly',
  };

  /**
   * The regression that matters: this is precisely the customer the locked
   * /billing screen sends to checkout.
   */
  it('lands active for a lapsed workspace paying to come back', async () => {
    prisma.user_subscriptions.findUnique.mockResolvedValue({
      trial_start_at: new Date('2026-08-03T00:00:00Z'),
      trial_end_at: new Date('2026-08-18T00:00:00Z'),
    });
    prisma.account_onboarding.findUnique.mockResolvedValue({
      trial_granted_at: new Date('2026-08-03T00:00:00Z'),
    });

    const call = await deliver(NOTES);

    expect(call?.update.status).toBe('active');
  });

  /** Paying does not buy a trial, whether or not one was ever used. */
  it('lands active for a first payment with no trial history', async () => {
    prisma.user_subscriptions.findUnique.mockResolvedValue(null);
    prisma.account_onboarding.findUnique.mockResolvedValue(null);

    const call = await deliver(NOTES);

    expect(call?.update.status).toBe('active');
    expect(call?.create.status).toBe('active');
  });

  /**
   * The trial columns are the record of the trial this workspace already
   * had. A payment is not a trial grant, so it must not rewrite them — and
   * must not latch `trial_granted_at` either.
   */
  it('leaves the trial columns and the 074 latch untouched', async () => {
    prisma.user_subscriptions.findUnique.mockResolvedValue({
      trial_start_at: new Date('2026-08-03T00:00:00Z'),
      trial_end_at: new Date('2026-08-18T00:00:00Z'),
    });
    prisma.account_onboarding.findUnique.mockResolvedValue({
      trial_granted_at: new Date('2026-08-03T00:00:00Z'),
    });

    const call = await deliver(NOTES);

    expect(call?.update).not.toHaveProperty('trial_start_at');
    expect(call?.update).not.toHaveProperty('trial_end_at');
    expect(prisma.account_onboarding.upsert).not.toHaveBeenCalled();
  });

  /** The paid period starts when the money arrives, not when a trial ends. */
  it('starts the billing period at the payment, not at a trial end', async () => {
    prisma.user_subscriptions.findUnique.mockResolvedValue({
      trial_start_at: new Date('2026-08-03T00:00:00Z'),
      trial_end_at: new Date('2027-01-01T00:00:00Z'),
    });
    prisma.account_onboarding.findUnique.mockResolvedValue({
      trial_granted_at: new Date('2026-08-03T00:00:00Z'),
    });

    const call = await deliver(NOTES);
    const start = call?.update.current_period_start as Date;

    expect(Math.abs(start.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('writes the subscription for the user named in the order notes', async () => {
    prisma.user_subscriptions.findUnique.mockResolvedValue(null);
    prisma.account_onboarding.findUnique.mockResolvedValue(null);

    const call = await deliver(NOTES);

    expect(call?.where).toEqual({ user_id: 'owner-1' });
  });

  /** The signature is the only thing authenticating a webhook. */
  it('refuses a body whose signature does not match', async () => {
    const res = makeRes();
    await controller.handleRazorpayWebhook(
      {
        headers: { 'x-razorpay-signature': 'deadbeef' },
        rawBody: Buffer.from(JSON.stringify(capturedPayment(NOTES)), 'utf8'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    expect(res.statusCode).toBe(400);
    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });
});
