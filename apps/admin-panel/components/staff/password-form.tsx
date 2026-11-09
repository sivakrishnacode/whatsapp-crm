'use client';

import { useActionState } from 'react';

import { Field, FormMessage, Input } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { changeOwnPassword } from '@/lib/actions/staff';
import type { ActionState } from '@/lib/actions/subscriptions';

export function PasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    changeOwnPassword,
    {}
  );

  return (
    <form action={formAction} className="space-y-4">
      {/* Lets password managers file the new password under the right login. */}
      <Field label="Current password">
        <Input
          type="password"
          name="current"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field
        label="New password"
        hint={`At least ${minLength} characters. A passphrase of a few unrelated words is easier to type and harder to guess.`}
      >
        <Input
          type="password"
          name="next"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={200}
          required
        />
      </Field>
      <Field label="Confirm new password">
        <Input
          type="password"
          name="confirm"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={200}
          required
        />
      </Field>
      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
    </form>
  );
}
