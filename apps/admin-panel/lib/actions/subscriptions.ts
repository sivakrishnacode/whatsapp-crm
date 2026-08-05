'use server';

import { refresh } from 'next/cache';

import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  FieldError,
  boolean,
  date,
  integer,
  oneOf,
  uuid,
} from '@/lib/actions/parse';

export type ActionState = { ok?: string; error?: string };

const STATUSES = [
  'active',
  'trial',
  'past_due',
  'cancelled',
  'expired',
] as const;
const CYCLES = ['monthly', 'yearly', 'none'] as const;
const METHODS = ['stripe', 'razorpay', 'manual'] as const;

const INTENTS = [
  'extend',
  'activate',
  'mark_past_due',
  'cancel_now',
  'toggle_cancel_at_period_end',
  'start_trial',
  'detach_gateway',
] as const;

/**
 * Subscription writes.
 *
 * Two notes on what these deliberately do *not* do:
 *
 *  - `manually_assigned_by` is left alone. It is a FK to `auth.users`, and the
 *    panel's administrator is an env credential, not a row in that table —
 *    there is no honest value to write. A change made here is therefore not
 *    attributable in the database; an audit table would be the fix.
 *  - Nothing is nulled implicitly. The api's own admin endpoint clears the
 *    Stripe/Razorpay ids on every manual plan assignment; doing that silently
 *    detaches a live gateway subscription that will keep billing the customer.
 *    Here it is an explicit `detach_gateway` action instead.
 */

async function loadSubscription(userId: string) {
  const existing = await prisma.user_subscriptions.findUnique({
    where: { user_id: userId },
    include: { subscription_plans: { select: { trial_days: true } } },
  });

  if (!existing) {
    throw new FieldError('This user has no subscription row to change.');
  }
  return existing;
}

export async function updateSubscription(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  try {
    const userId = uuid(formData, 'userId', 'User');
    const planId = uuid(formData, 'planId', 'Plan');
    const status = oneOf(formData, 'status', STATUSES, { label: 'Status' })!;
    const cycleField = oneOf(formData, 'billingCycle', CYCLES, {
      label: 'Billing cycle',
    })!;
    const method = oneOf(formData, 'paymentMethod', METHODS, {
      label: 'Payment method',
    })!;

    const billingCycle = cycleField === 'none' ? null : cycleField;
    const periodStart = date(formData, 'periodStart', 'Period start');
    const periodEnd = date(formData, 'periodEnd', 'Period end');
    const trialEndAt = date(formData, 'trialEndAt', 'Trial end');
    const cancelAtPeriodEnd = boolean(formData, 'cancelAtPeriodEnd');

    if (periodStart && periodEnd && periodEnd <= periodStart) {
      throw new FieldError('Period end must be after period start.');
    }

    const plan = await prisma.subscription_plans.findUnique({
      where: { id: planId },
      select: { display_name: true },
    });
    if (!plan) throw new FieldError('That plan no longer exists.');

    await prisma.user_subscriptions.update({
      where: { user_id: userId },
      data: {
        plan_id: planId,
        status,
        billing_cycle: billingCycle,
        payment_method: method,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        trial_end_at: trialEndAt,
        cancel_at_period_end: cancelAtPeriodEnd,
        updated_at: new Date(),
      },
    });

    refresh();
    return { ok: `Saved — now on ${plan.display_name}.` };
  } catch (error) {
    return toState(error);
  }
}

export async function quickSubscriptionAction(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  try {
    const userId = uuid(formData, 'userId', 'User');
    const intent = oneOf(formData, 'intent', INTENTS, { label: 'Action' })!;
    const existing = await loadSubscription(userId);
    const now = new Date();
    const message = await applyIntent(intent, formData, existing, now);

    refresh();
    return { ok: message };
  } catch (error) {
    return toState(error);
  }
}

type ExistingSubscription = Awaited<ReturnType<typeof loadSubscription>>;

async function applyIntent(
  intent: (typeof INTENTS)[number],
  formData: FormData,
  existing: ExistingSubscription,
  now: Date
): Promise<string> {
  const userId = existing.user_id;

  switch (intent) {
    case 'extend': {
      const days = integer(formData, 'extendDays', {
        label: 'Days',
        min: 1,
        max: 730,
      })!;
      // Extend from the later of "now" and the current end, so extending an
      // already-lapsed subscription gives a full window rather than a date
      // that is still in the past.
      const from =
        existing.current_period_end && existing.current_period_end > now
          ? existing.current_period_end
          : now;
      const periodEnd = new Date(from.getTime() + days * 86_400_000);

      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: {
          current_period_start: existing.current_period_start ?? now,
          current_period_end: periodEnd,
          status: 'active',
          updated_at: now,
        },
      });
      return `Extended by ${days} days.`;
    }

    case 'activate':
      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: { status: 'active', updated_at: now },
      });
      return 'Marked active.';

    case 'mark_past_due':
      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: { status: 'past_due', updated_at: now },
      });
      return 'Marked past due.';

    case 'cancel_now':
      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: {
          status: 'cancelled',
          cancel_at_period_end: false,
          updated_at: now,
        },
      });
      return 'Cancelled with immediate effect.';

    case 'toggle_cancel_at_period_end': {
      const next = !existing.cancel_at_period_end;
      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: { cancel_at_period_end: next, updated_at: now },
      });
      return next
        ? 'Will cancel at the end of the current period.'
        : 'Will renew at the end of the current period.';
    }

    case 'start_trial': {
      const days = existing.subscription_plans.trial_days ?? 14;
      const trialEnd = new Date(now.getTime() + days * 86_400_000);

      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: {
          status: 'trial',
          trial_start_at: now,
          trial_end_at: trialEnd,
          current_period_start: now,
          current_period_end: trialEnd,
          cancel_at_period_end: false,
          updated_at: now,
        },
      });
      return `Trial started — ${days} days.`;
    }

    case 'detach_gateway':
      await prisma.user_subscriptions.update({
        where: { user_id: userId },
        data: {
          stripe_subscription_id: null,
          razorpay_subscription_id: null,
          payment_method: 'manual',
          updated_at: now,
        },
      });
      return (
        'Gateway subscription detached. Cancel it at the provider too — ' +
        'it will keep charging otherwise.'
      );
  }
}

function toState(error: unknown): ActionState {
  if (error instanceof FieldError) return { error: error.message };
  console.error('[admin-panel] subscription write failed', error);
  return { error: 'Could not save that change. Check the logs.' };
}
