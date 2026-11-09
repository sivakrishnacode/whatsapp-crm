'use client';

import { useActionState } from 'react';

import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { setLifecycle } from '@/lib/actions/clients';
import type { ActionState } from '@/lib/actions/subscriptions';

const STAGES: { value: string; label: string }[] = [
  { value: 'lead', label: 'Lead' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'active', label: 'Active' },
  { value: 'attention', label: 'Attention' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'churned', label: 'Churned' },
  { value: 'archived', label: 'Archived' },
];

/**
 * Pin or clear the lifecycle stage. A reason is required both ways — the
 * transition log (client_lifecycle_events) is only useful if it says why.
 */
export function LifecycleForm({
  accountId,
  pinned,
  currentStage,
}: {
  accountId: string;
  pinned: boolean;
  currentStage: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    setLifecycle,
    {}
  );
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="accountId" value={accountId} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Stage">
          <Select name="stage" defaultValue={currentStage} className="w-auto">
            {pinned ? (
              <option value="">Clear the pin (derive from data)</option>
            ) : null}
            {STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="min-w-56 flex-1">
          <Field label="Reason">
            <Input
              name="reason"
              required
              maxLength={500}
              placeholder="Why — read by whoever looks next"
            />
          </Field>
        </div>
      </div>
      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton variant="secondary" pendingLabel="Saving…">
        {pinned ? 'Update pin' : 'Pin stage'}
      </SubmitButton>
    </form>
  );
}
