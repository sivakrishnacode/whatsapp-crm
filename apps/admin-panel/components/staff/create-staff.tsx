'use client';

import { useActionState } from 'react';

import { SecretReveal } from '@/components/staff/secret-reveal';
import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { createStaff, type StaffActionState } from '@/lib/actions/staff';
import { ROLE_LABEL, STAFF_ROLES } from '@/lib/staff/roles';

/**
 * Add a staff member. No password field: one is generated and shown once,
 * because a typed one is how `Welcome123` reaches production.
 */
export function CreateStaff() {
  const [state, formAction] = useActionState<StaffActionState, FormData>(
    createStaff,
    {}
  );

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Work email">
            <Input
              type="email"
              name="email"
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              required
            />
          </Field>
          <Field label="Full name">
            <Input name="fullName" autoComplete="off" maxLength={80} required />
          </Field>
        </div>
        <Field
          label="Role"
          hint="What each role can do is in the matrix below. Start narrow — a role can be widened later in one click."
        >
          <Select name="role" defaultValue="support_l1">
            {STAFF_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </Select>
        </Field>
        <FormMessage ok={state.ok} error={state.error} />
        <SubmitButton pendingLabel="Creating…">
          Create staff account
        </SubmitButton>
      </form>
      {state.secret ? (
        <SecretReveal secret={state.secret} owner={state.secretFor} />
      ) : null}
    </div>
  );
}
