'use client';

import { useFormStatus } from 'react-dom';

/**
 * A submit button that disables itself while its form is in flight.
 *
 * `useFormStatus` reads the state of the enclosing form, so this works for the
 * multi-button forms in this panel (quick actions) without any per-button state:
 * whichever button was pressed, all of them go quiet until the action resolves.
 */
export function SubmitButton({
  children,
  name,
  value,
  variant = 'primary',
  pendingLabel,
  className = '',
}: {
  children: React.ReactNode;
  name?: string;
  value?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  const styles = {
    primary: 'bg-series-1 text-white hover:opacity-90',
    secondary: 'border-ring border text-ink hover:bg-surface-2',
    danger: 'border-critical text-critical border hover:bg-surface-2',
  }[variant];

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 ${styles} ${className}`}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
