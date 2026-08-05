import type { ReactNode } from 'react';

/**
 * Form controls. Plain elements with shared classes rather than wrapped inputs —
 * every form in this panel is a native `<form>` posting to a Server Action, so
 * the controls need nothing that a `<input>` doesn't already do.
 */

const CONTROL =
  'border-ring bg-surface text-ink placeholder:text-muted w-full rounded-lg border px-3 py-2 text-sm';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-ink-2 mb-1.5 block text-xs font-medium">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-muted mt-1 block text-xs leading-relaxed">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Input(props: React.ComponentProps<'input'>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`${CONTROL} ${className}`} />;
}

export function Select(props: React.ComponentProps<'select'>) {
  const { className = '', children, ...rest } = props;
  return (
    <select {...rest} className={`${CONTROL} ${className}`}>
      {children}
    </select>
  );
}

export function Textarea(props: React.ComponentProps<'textarea'>) {
  const { className = '', ...rest } = props;
  return <textarea {...rest} className={`${CONTROL} ${className}`} />;
}

export function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="border-ring accent-series-1 mt-0.5 size-4 rounded border"
      />
      <span>
        <span className="text-ink-2 block text-xs font-medium">{label}</span>
        {hint ? (
          <span className="text-muted mt-0.5 block text-xs leading-relaxed">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

/** Action feedback. Both tones name what happened; neither relies on color. */
export function FormMessage({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;

  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
        error ? 'bg-surface-2 text-ink' : 'bg-surface-2 text-ink'
      }`}
    >
      <span
        aria-hidden
        className={`mt-1 size-1.5 shrink-0 rounded-full ${error ? 'bg-critical' : 'bg-good'}`}
      />
      <span>
        <strong className="font-semibold">
          {error ? 'Not saved' : 'Saved'}
        </strong>{' '}
        — {error ?? ok}
      </span>
    </p>
  );
}
