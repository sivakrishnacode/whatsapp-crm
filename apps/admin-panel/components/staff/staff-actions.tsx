'use client';

import { useActionState } from 'react';

import { SecretReveal } from '@/components/staff/secret-reveal';
import { FormMessage, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { staffAction, type StaffActionState } from '@/lib/actions/staff';
import { ROLE_LABEL, STAFF_ROLES, type StaffRole } from '@/lib/staff/roles';

/**
 * Everything a Super Admin can do to one staff account, in one form. Each
 * button carries its own `intent`, so they share one action, one message and
 * one pending state — the same idiom as the workspace member actions.
 *
 * Every one of these signs the person out (their session_version moves), and
 * the button labels say so where it is not obvious.
 */
export function StaffActions({
  staffId,
  role,
  isActive,
  isSelf,
}: {
  staffId: string;
  role: StaffRole;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [state, formAction] = useActionState<StaffActionState, FormData>(
    staffAction,
    {}
  );

  return (
    <div className="space-y-2">
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="staffId" value={staffId} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isSelf ? (
            <span className="text-muted text-xs">
              This is you — another Super Admin changes your role.
            </span>
          ) : (
            <>
              <Select
                name="role"
                defaultValue={role}
                className="w-auto"
                aria-label="Role"
              >
                {STAFF_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABEL[value]}
                  </option>
                ))}
              </Select>
              <SubmitButton
                name="intent"
                value="set_role"
                variant="secondary"
                pendingLabel="…"
              >
                Change role
              </SubmitButton>
            </>
          )}
          <SubmitButton
            name="intent"
            value="reset_password"
            variant="secondary"
            pendingLabel="…"
          >
            Reset password
          </SubmitButton>
          <SubmitButton
            name="intent"
            value="revoke_sessions"
            variant="ghost"
            pendingLabel="…"
          >
            Sign out everywhere
          </SubmitButton>
          {isSelf ? null : isActive ? (
            <SubmitButton
              name="intent"
              value="deactivate"
              variant="danger"
              pendingLabel="…"
            >
              Deactivate
            </SubmitButton>
          ) : (
            <SubmitButton
              name="intent"
              value="reactivate"
              variant="secondary"
              pendingLabel="…"
            >
              Reactivate
            </SubmitButton>
          )}
        </div>
        <FormMessage ok={state.ok} error={state.error} />
      </form>
      {state.secret ? (
        <SecretReveal secret={state.secret} owner={state.secretFor} />
      ) : null}
    </div>
  );
}
