import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { RazorpayController } from './razorpay.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';

/**
 * Three things are pinned here, and each one shipped broken:
 *
 *   1. The HMAC signature is the ONLY thing separating "I paid" from a
 *      claim any signed-in user can POST. Without it this endpoint is a
 *      free upgrade — and, now that the trial-ended screen routes here, a
 *      free unlock of a locked workspace.
 *   2. A payment must not grant a TRIAL. It used to write
 *      `status = 'trial'` plus a fresh 15-day window whenever the plan had
 *      trial_days, which every selectable plan does: the customer paid and
 *      was recorded as still trialling, then lapsed again a fortnight
 *      later, and migration 074's one-trial latch was bypassed entirely.
 *   3. The write must land on the OWNER's row. Entitlement resolves
 *      through `accounts.owner_user_id`, so a payment filed against the
 *      caller left the workspace locked and the money collected.
 */

const KEY_SECRET = 'test_secret_do_not_use';

function makePrismaMock() {
  return {
    account: { findUnique: vi.fn() },
    subscription_plans: { findUnique: vi.fn() },
    user_subscriptions: { upsert: vi.fn() },
  };
}

/** Razorpay signs `<order_id>|<payment_id>` with the key secret. */
function sign(orderId: string, paymentId: string, secret = KEY_SECRET): string {
  return createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

const ORDER = 'order_TQiCDAwBY8u63y';
const PAYMENT = 'pay_abc123';

/** The caller is the owner here; the wrong-row test overrides the account. */
const ACCOUNT: SupabaseAccountContext = {
  authType: 'supabase',
  userId: 'owner-1',
  accountId: 'acc-1',
  role: 'owner',
  account: { id: 'acc-1', name: 'Acme' },
};

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

describe('RazorpayController.confirmPayment', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let controller: RazorpayController;

  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;

    prisma = makePrismaMock();
    prisma.account.findUnique.mockResolvedValue({ ownerUserId: 'owner-1' });
    prisma.subscription_plans.findUnique.mockResolvedValue({
      id: 'plan-starter',
    });

    controller = new RazorpayController(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      planName: 'STARTER',
      billingCycle: 'monthly',
      razorpayOrderId: ORDER,
      razorpayPaymentId: PAYMENT,
      razorpaySignature: sign(ORDER, PAYMENT),
      ...overrides,
    };
  }

  it('refuses a signature it did not sign, and writes nothing', async () => {
    await expect(
      controller.confirmPayment(
        ACCOUNT,
        body({ razorpaySignature: 'a'.repeat(64) }),
      ),
    ).rejects.toThrow(HttpException);

    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });

  /**
   * The signature covers the order and payment ids, so swapping either one
   * after the fact has to fail — otherwise a ₹300 Starter payment could be
   * replayed against a Growth order.
   */
  it('refuses a signature minted for a different order', async () => {
    await expect(
      controller.confirmPayment(
        ACCOUNT,
        body({ razorpaySignature: sign('order_someone_else', PAYMENT) }),
      ),
    ).rejects.toThrow(HttpException);

    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });

  it('refuses a signature signed with the wrong secret', async () => {
    await expect(
      controller.confirmPayment(
        ACCOUNT,
        body({ razorpaySignature: sign(ORDER, PAYMENT, 'not_our_secret') }),
      ),
    ).rejects.toThrow(HttpException);

    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });

  it('refuses a missing signature rather than treating it as absent-and-fine', async () => {
    await expect(
      controller.confirmPayment(
        ACCOUNT,
        body({ razorpaySignature: undefined }),
      ),
    ).rejects.toThrow(/Missing required fields/);

    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });

  it('lands active on a verified payment', async () => {
    const result = await controller.confirmPayment(ACCOUNT, body());

    expect(result).toEqual({ success: true, planName: 'STARTER' });

    const call = prisma.user_subscriptions.upsert.mock
      .calls[0][0] as UpsertCall;
    expect(call.update.status).toBe('active');
    expect(call.update.payment_method).toBe('razorpay');
    expect(call.update.razorpay_subscription_id).toBe(ORDER);
  });

  /**
   * ⚠️ Paying must not buy a trial. The trial columns are the historical
   * record of the one trial this workspace already had (migration 074);
   * rewriting them here granted a second one and left a paying customer
   * recorded as `trial`, invisible to MRR.
   */
  it('never writes the trial columns when converting an existing row', async () => {
    await controller.confirmPayment(ACCOUNT, body());

    const call = prisma.user_subscriptions.upsert.mock
      .calls[0][0] as UpsertCall;
    expect(call.update).not.toHaveProperty('trial_start_at');
    expect(call.update).not.toHaveProperty('trial_end_at');
    expect(call.update.status).not.toBe('trial');
  });

  /** The billing period starts when it is paid for, not when a trial ends. */
  it('starts the paid period today', async () => {
    await controller.confirmPayment(ACCOUNT, body());

    const call = prisma.user_subscriptions.upsert.mock
      .calls[0][0] as UpsertCall;
    const start = call.update.current_period_start as Date;
    const end = call.update.current_period_end as Date;

    expect(Math.abs(start.getTime() - Date.now())).toBeLessThan(60_000);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('bills a year ahead on the yearly cycle', async () => {
    await controller.confirmPayment(ACCOUNT, body({ billingCycle: 'yearly' }));

    const call = prisma.user_subscriptions.upsert.mock
      .calls[0][0] as UpsertCall;
    const start = call.update.current_period_start as Date;
    const end = call.update.current_period_end as Date;

    const months =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth());
    expect(months).toBe(12);
  });

  /**
   * ⚠️ The row that IS the workspace's entitlement belongs to
   * `accounts.owner_user_id`. `RequireRole('owner')` should mean the caller
   * and the owner are the same person, but the write resolves the owner
   * itself so a stale profile role cannot misfile a payment.
   */
  it('writes the owner subscription, not the caller', async () => {
    prisma.account.findUnique.mockResolvedValue({ ownerUserId: 'owner-1' });

    await controller.confirmPayment({ ...ACCOUNT, userId: 'admin-7' }, body());

    const call = prisma.user_subscriptions.upsert.mock
      .calls[0][0] as UpsertCall;
    expect(call.where).toEqual({ user_id: 'owner-1' });
    expect(call.create.user_id).toBe('owner-1');
  });

  it('rejects a plan name that is not sold self-serve', async () => {
    await expect(
      controller.confirmPayment(ACCOUNT, body({ planName: 'ENTERPRISE' })),
    ).rejects.toThrow(/Invalid plan name/);

    expect(prisma.user_subscriptions.upsert).not.toHaveBeenCalled();
  });
});
