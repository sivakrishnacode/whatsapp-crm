'use client';

import { useActionState } from 'react';

import { Field, FormMessage, Input } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { login, type LoginState } from '@/lib/actions/auth';

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Field label="Username">
        <Input
          name="username"
          autoComplete="username"
          autoFocus
          required
          spellCheck={false}
        />
      </Field>

      <Field label="Password">
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          required
        />
      </Field>

      {state.error ? <FormMessage error={state.error} /> : null}

      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
