'use client';

import { useActionState, useEffect, useRef } from 'react';

import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { addTask } from '@/lib/actions/clients';
import type { ActionState } from '@/lib/actions/subscriptions';

export function TaskForm({
  accountId,
  staff,
  defaultAssigneeId,
}: {
  accountId: string;
  staff: { id: string; name: string }[];
  defaultAssigneeId: string | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    addTask,
    {}
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="space-y-3">
      <input type="hidden" name="accountId" value={accountId} />
      <Field label="Follow-up">
        <Input
          name="title"
          required
          maxLength={300}
          placeholder="Call the owner about the template rejections"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due">
          <Input type="date" name="dueOn" />
        </Field>
        <Field label="Assignee">
          <Select name="assigneeId" defaultValue={defaultAssigneeId ?? ''}>
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton variant="secondary" pendingLabel="Adding…">
        Add task
      </SubmitButton>
    </form>
  );
}
