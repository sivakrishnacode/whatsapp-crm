'use server';

import { refresh } from 'next/cache';

import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  FieldError,
  boolean,
  decimal,
  integer,
  optionalText,
  text,
  uuid,
} from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Plan writes — where the subscription amounts are actually set.
 *
 * A price change here takes effect for every subscriber on the plan the moment
 * it is saved, including their next renewal, and it rewrites every derived
 * revenue figure in the panel (there is no price history to fall back on). The
 * form warns about that; this file just makes sure the numbers are sane.
 *
 * Gateway ids (`stripe_price_id_*`, `razorpay_plan_id`) are intentionally not
 * editable here: changing a price in this table does not change it at Stripe or
 * Razorpay, and letting someone repoint a plan at a different gateway price
 * from an admin form is how subscribers end up charged an amount nobody chose.
 */
export async function updatePlan(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  try {
    const planId = uuid(formData, 'planId', 'Plan');
    const displayName = text(formData, 'displayName', 'Display name');
    const description = optionalText(formData, 'description');
    const priceMonthly = decimal(formData, 'priceMonthly', {
      label: 'Monthly price',
    });
    const priceYearly = decimal(formData, 'priceYearly', {
      label: 'Yearly price',
    });
    const trialDays = integer(formData, 'trialDays', {
      label: 'Trial days',
      min: 0,
      max: 365,
      optional: true,
    });
    const maxContacts = integer(formData, 'maxContacts', {
      label: 'Contact limit',
    })!;
    const maxMessagesMonthly = integer(formData, 'maxMessagesMonthly', {
      label: 'Monthly message limit',
    })!;
    const maxBroadcastsMonthly = integer(formData, 'maxBroadcastsMonthly', {
      label: 'Monthly broadcast limit',
    })!;
    const maxFlows = integer(formData, 'maxFlows', {
      label: 'Flow limit',
      optional: true,
    });
    const maxTeamMembers = integer(formData, 'maxTeamMembers', {
      label: 'Team member limit',
    })!;
    const maxStorageMb = integer(formData, 'maxStorageMb', {
      label: 'Storage limit',
    })!;
    const isActive = boolean(formData, 'isActive');

    // A yearly price above 12× monthly means the annual plan costs more than
    // paying month to month, which is never intended and is invisible until a
    // customer complains.
    if (priceMonthly > 0 && priceYearly > priceMonthly * 12) {
      throw new FieldError(
        `Yearly price (${priceYearly}) is more than 12× the monthly price ` +
          `(${priceMonthly * 12}). Fix one of them.`
      );
    }

    const plan = await prisma.subscription_plans.findUnique({
      where: { id: planId },
      select: { name: true, _count: { select: { user_subscriptions: true } } },
    });
    if (!plan) throw new FieldError('That plan no longer exists.');

    await prisma.subscription_plans.update({
      where: { id: planId },
      data: {
        display_name: displayName,
        description,
        price_monthly: priceMonthly,
        price_yearly: priceYearly,
        trial_days: trialDays,
        max_contacts: maxContacts,
        max_messages_monthly: maxMessagesMonthly,
        max_broadcasts_monthly: maxBroadcastsMonthly,
        max_flows: maxFlows,
        max_team_members: maxTeamMembers,
        max_storage_mb: maxStorageMb,
        is_active: isActive,
        updated_at: new Date(),
      },
    });

    refresh();

    const affected = plan._count.user_subscriptions;
    const note = isActive
      ? ''
      : ' Hidden from new signups — existing subscribers stay on it.';

    return {
      ok:
        affected > 0
          ? `Saved ${plan.name}. ${affected} subscription${affected === 1 ? '' : 's'} now priced at the new amount.${note}`
          : `Saved ${plan.name}.${note}`,
    };
  } catch (error) {
    if (error instanceof FieldError) return { error: error.message };
    console.error('[admin-panel] plan write failed', error);
    return { error: 'Could not save the plan. Check the logs.' };
  }
}
