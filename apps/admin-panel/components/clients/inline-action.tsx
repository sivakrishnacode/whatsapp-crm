'use client';

import { useActionState, type ReactNode } from 'react';

import { SubmitButton } from '@/components/ui/submit-button';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * A one-button form for a Server Action that needs only hidden fields —
 * "Assign to me", "Pin", "Done". The result shows inline next to the button,
 * so an error is never silently swallowed.
 */
export function InlineAction({
  action,
  fields,
  children,
  variant = 'secondary',
  pendingLabel,
  size = 'sm',
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  pendingLabel?: string;
  size?: 'sm' | 'md';
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton
        variant={variant}
        pendingLabel={pendingLabel}
        className={size === 'sm' ? '!px-2.5 !py-1 !text-xs' : ''}
      >
        {children}
      </SubmitButton>
      {state.error ? (
        <span role="status" className="text-bad-fg text-xs">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
