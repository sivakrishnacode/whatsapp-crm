'use client';

import { useActionState } from 'react';

import {
  Checkbox,
  Field,
  FieldGrid,
  FormMessage,
  Input,
  Select,
} from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  updateSubscription,
  type ActionState,
} from '@/lib/actions/subscriptions';

export type PlanChoice = {
  id: string;
  displayName: string;
  /** Pre-formatted by the server — currency config is server-side only. */
  priceLabel: string;
};

export function SubscriptionForm({
  userId,
  planId,
  status,
  billingCycle,
  paymentMethod,
  periodStart,
  periodEnd,
  trialEndAt,
  cancelAtPeriodEnd,
  plans,
  gateway,
}: {
  userId: string;
  planId: string;
  status: string;
  billingCycle: string | null;
  paymentMethod: string | null;
  periodStart: string;
  periodEnd: string;
  trialEndAt: string;
  cancelAtPeriodEnd: boolean;
  plans: PlanChoice[];
  gateway: 'stripe' | 'razorpay' | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateSubscription,
    {}
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="userId" value={userId} />

      {gateway ? (
        <p className="border-ring text-ink-2 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed">
          <span
            aria-hidden
            className="bg-warning mt-1 size-1.5 shrink-0 rounded-full"
          />
          <span>
            <strong className="text-ink font-semibold">
              Live {gateway} subscription.
            </strong>{' '}
            Changes here only move the row in this database — {gateway} keeps
            charging on its own schedule and its next webhook can overwrite what
            you set. Change it at {gateway} too, or detach it below first.
          </span>
        </p>
      ) : null}

      <FieldGrid>
        <Field label="Plan">
          <Select name="planId" defaultValue={planId}>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.displayName} — {plan.priceLabel}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Status">
          <Select name="status" defaultValue={status}>
            <option value="active">Active</option>
            <option value="trial">Trial</option>
            <option value="past_due">Past due</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </Select>
        </Field>

        <Field
          label="Billing cycle"
          hint="Picks which of the plan's two prices this subscription is charged."
        >
          <Select name="billingCycle" defaultValue={billingCycle ?? 'none'}>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="none">None (free plan)</option>
          </Select>
        </Field>

        <Field
          label="Payment method"
          hint="How this subscription is actually paid for. Recorded, not enforced."
        >
          <Select name="paymentMethod" defaultValue={paymentMethod ?? 'manual'}>
            <option value="manual">Manual</option>
            <option value="razorpay">Razorpay</option>
            <option value="stripe">Stripe</option>
          </Select>
        </Field>

        <Field label="Current period starts">
          <Input type="date" name="periodStart" defaultValue={periodStart} />
        </Field>

        <Field
          label="Current period ends"
          hint="What the renewals and expected-collections figures read."
        >
          <Input type="date" name="periodEnd" defaultValue={periodEnd} />
        </Field>

        <Field label="Trial ends" hint="Leave empty if this is not a trial.">
          <Input type="date" name="trialEndAt" defaultValue={trialEndAt} />
        </Field>
      </FieldGrid>

      <Checkbox
        name="cancelAtPeriodEnd"
        label="Cancel at the end of the current period"
        defaultChecked={cancelAtPeriodEnd}
        hint="Stays active and billable until the period ends, then stops."
      />

      <FormMessage ok={state.ok} error={state.error} />

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save subscription</SubmitButton>
        <p className="text-muted text-xs">
          Takes effect immediately for this subscriber.
        </p>
      </div>
    </form>
  );
}
