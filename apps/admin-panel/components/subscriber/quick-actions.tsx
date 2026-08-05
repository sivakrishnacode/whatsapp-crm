'use client';

import { useActionState } from 'react';

import { FormMessage, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  quickSubscriptionAction,
  type ActionState,
} from '@/lib/actions/subscriptions';

/**
 * One form, several submit buttons.
 *
 * Each button posts its own `intent` (a submit button's name/value is included
 * in the FormData), so all of these share a single action and a single result
 * message — and `useFormStatus` inside SubmitButton quiets every button while
 * any one of them is in flight.
 */
export function QuickActions({
  userId,
  cancelAtPeriodEnd,
  hasGateway,
  trialDays,
}: {
  userId: string;
  cancelAtPeriodEnd: boolean;
  hasGateway: boolean;
  trialDays: number | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    quickSubscriptionAction,
    {}
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="userId" value={userId} />

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-muted mb-1.5 block text-xs font-medium">
            Extend the period by
          </span>
          <Select name="extendDays" defaultValue="30" className="w-auto">
            <option value="7">7 days</option>
            <option value="15">15 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">365 days</option>
          </Select>
        </label>
        <SubmitButton name="intent" value="extend" pendingLabel="Working…">
          Extend
        </SubmitButton>
      </div>

      <div className="border-line flex flex-wrap gap-2 border-t pt-4">
        <SubmitButton name="intent" value="activate" variant="secondary">
          Mark active
        </SubmitButton>

        <SubmitButton name="intent" value="start_trial" variant="secondary">
          Start trial{trialDays ? ` (${trialDays}d)` : ''}
        </SubmitButton>

        <SubmitButton name="intent" value="mark_past_due" variant="secondary">
          Mark past due
        </SubmitButton>

        <SubmitButton
          name="intent"
          value="toggle_cancel_at_period_end"
          variant="secondary"
        >
          {cancelAtPeriodEnd ? 'Let it renew' : 'Cancel at period end'}
        </SubmitButton>

        <SubmitButton name="intent" value="cancel_now" variant="danger">
          Cancel now
        </SubmitButton>

        {hasGateway ? (
          <SubmitButton name="intent" value="detach_gateway" variant="danger">
            Detach gateway
          </SubmitButton>
        ) : null}
      </div>

      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
