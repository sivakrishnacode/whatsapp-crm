'use client';

import { useActionState } from 'react';

import {
  Field,
  FieldGrid,
  FormMessage,
  Input,
  Select,
} from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { updateClientOwnership } from '@/lib/actions/clients';
import type { ActionState } from '@/lib/actions/subscriptions';

type StaffOption = { id: string; name: string; role: string };

/**
 * Who on our side looks after this client (C360-023). Only active staff are
 * offered; a manager who has since been deactivated still shows as the
 * current value so saving the form does not silently unassign them.
 */
export function OwnershipForm({
  accountId,
  staff,
  current,
}: {
  accountId: string;
  staff: StaffOption[];
  current: {
    accountManagerId: string | null;
    accountManagerName: string | null;
    backupManagerId: string | null;
    backupManagerName: string | null;
    supportLeadId: string | null;
    supportLeadName: string | null;
    serviceTier: string;
    tags: string[];
  };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateClientOwnership,
    {}
  );

  const options = (selectedId: string | null, selectedName: string | null) => (
    <>
      <option value="">Nobody</option>
      {selectedId && !staff.some((s) => s.id === selectedId) ? (
        <option value={selectedId}>
          {selectedName ?? 'Former staff'} (inactive)
        </option>
      ) : null}
      {staff.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} — {s.role}
        </option>
      ))}
    </>
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <FieldGrid>
        <Field label="Account manager">
          <Select
            name="accountManagerId"
            defaultValue={current.accountManagerId ?? ''}
          >
            {options(current.accountManagerId, current.accountManagerName)}
          </Select>
        </Field>
        <Field label="Backup manager">
          <Select
            name="backupManagerId"
            defaultValue={current.backupManagerId ?? ''}
          >
            {options(current.backupManagerId, current.backupManagerName)}
          </Select>
        </Field>
        <Field label="Support lead">
          <Select
            name="supportLeadId"
            defaultValue={current.supportLeadId ?? ''}
          >
            {options(current.supportLeadId, current.supportLeadName)}
          </Select>
        </Field>
        <Field label="Service tier">
          <Select name="serviceTier" defaultValue={current.serviceTier}>
            <option value="standard">Standard</option>
            <option value="priority">Priority</option>
            <option value="enterprise">Enterprise</option>
          </Select>
        </Field>
      </FieldGrid>
      <Field
        label="Tags"
        hint="Comma-separated, e.g. agency, high-volume, pilot. Up to 10."
      >
        <Input
          name="tags"
          defaultValue={current.tags.join(', ')}
          maxLength={400}
        />
      </Field>
      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton pendingLabel="Saving…">Save ownership</SubmitButton>
    </form>
  );
}
