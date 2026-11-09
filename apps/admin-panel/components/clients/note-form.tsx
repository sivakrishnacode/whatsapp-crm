'use client';

import { useActionState, useEffect, useRef } from 'react';

import { Checkbox, FormMessage, Textarea } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { addNote } from '@/lib/actions/clients';
import type { ActionState } from '@/lib/actions/subscriptions';

export function NoteForm({ accountId }: { accountId: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    addNote,
    {}
  );
  const form = useRef<HTMLFormElement>(null);

  // Clear the box once a note lands, so a second Save cannot post it twice.
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="space-y-3">
      <input type="hidden" name="accountId" value={accountId} />
      <label className="block">
        <span className="sr-only">Note</span>
        <Textarea
          name="body"
          rows={3}
          required
          maxLength={4000}
          placeholder="What happened, what was agreed, what to watch for…"
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox name="pinned" label="Pin to the top" />
        <SubmitButton pendingLabel="Saving…">Add note</SubmitButton>
      </div>
      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
