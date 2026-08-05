'use client';

import { useActionState } from 'react';

import {
  Checkbox,
  Field,
  FieldGrid,
  FormMessage,
  Input,
  Textarea,
} from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { updatePlan } from '@/lib/actions/plans';
import type { ActionState } from '@/lib/actions/subscriptions';

export function PlanForm({
  planId,
  displayName,
  description,
  priceMonthly,
  priceYearly,
  trialDays,
  maxContacts,
  maxMessagesMonthly,
  maxBroadcastsMonthly,
  maxFlows,
  maxTeamMembers,
  maxStorageMb,
  isActive,
  activeSubscribers,
  currencyCode,
}: {
  planId: string;
  displayName: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  trialDays: number | null;
  maxContacts: number;
  maxMessagesMonthly: number;
  maxBroadcastsMonthly: number;
  maxFlows: number | null;
  maxTeamMembers: number;
  maxStorageMb: number;
  isActive: boolean;
  activeSubscribers: number;
  currencyCode: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updatePlan,
    {}
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="planId" value={planId} />

      {activeSubscribers > 0 ? (
        <p className="border-ring text-ink-2 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed">
          <span
            aria-hidden
            className="bg-warning mt-1 size-1.5 shrink-0 rounded-full"
          />
          <span>
            <strong className="text-ink font-semibold">
              {activeSubscribers} active subscription
              {activeSubscribers === 1 ? '' : 's'} on this plan.
            </strong>{' '}
            A price change applies to all of them at once — and because the plan
            table is the only record of price, it also changes every historical
            figure in this panel. It does not change anything at Stripe or
            Razorpay.
          </span>
        </p>
      ) : null}

      <FieldGrid>
        <Field label="Display name">
          <Input name="displayName" defaultValue={displayName} required />
        </Field>

        <Field
          label={`Monthly price (${currencyCode})`}
          hint="0 makes the plan free."
        >
          <Input
            type="number"
            name="priceMonthly"
            defaultValue={priceMonthly}
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field
          label={`Yearly price (${currencyCode})`}
          hint="The full annual charge, not the monthly share."
        >
          <Input
            type="number"
            name="priceYearly"
            defaultValue={priceYearly}
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field label="Trial days" hint="Empty for no trial.">
          <Input
            type="number"
            name="trialDays"
            defaultValue={trialDays ?? ''}
            min={0}
            max={365}
          />
        </Field>
      </FieldGrid>

      <Field label="Description">
        <Textarea
          name="description"
          defaultValue={description ?? ''}
          rows={2}
        />
      </Field>

      <div>
        <p className="text-ink-2 mb-3 text-xs font-semibold">
          Limits the CRM enforces
        </p>
        <FieldGrid>
          <Field label="Contacts" hint="0 means no contacts allowed.">
            <Input
              type="number"
              name="maxContacts"
              defaultValue={maxContacts}
              min={0}
              required
            />
          </Field>
          <Field label="Messages per month">
            <Input
              type="number"
              name="maxMessagesMonthly"
              defaultValue={maxMessagesMonthly}
              min={0}
              required
            />
          </Field>
          <Field label="Broadcasts per month">
            <Input
              type="number"
              name="maxBroadcastsMonthly"
              defaultValue={maxBroadcastsMonthly}
              min={0}
              required
            />
          </Field>
          <Field label="Flows" hint="Empty means unlimited.">
            <Input
              type="number"
              name="maxFlows"
              defaultValue={maxFlows ?? ''}
              min={0}
            />
          </Field>
          <Field label="Team members">
            <Input
              type="number"
              name="maxTeamMembers"
              defaultValue={maxTeamMembers}
              min={0}
              required
            />
          </Field>
          <Field label="Storage (MB)">
            <Input
              type="number"
              name="maxStorageMb"
              defaultValue={maxStorageMb}
              min={0}
              required
            />
          </Field>
        </FieldGrid>
      </div>

      <Checkbox
        name="isActive"
        label="Offered to new subscribers"
        defaultChecked={isActive}
        hint="Turning this off hides the plan from signup. Existing subscribers stay on it and keep being billed."
      />

      <FormMessage ok={state.ok} error={state.error} />

      <SubmitButton pendingLabel="Saving…">Save plan</SubmitButton>
    </form>
  );
}
