'use client';

import { useActionState } from 'react';

import { Field, FieldGrid, FormMessage, Input } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { updateWorkspace } from '@/lib/actions/workspaces';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * The three workspace settings support actually gets asked to change.
 *
 * `defaultCountry` looks cosmetic and is not: it is the country assumed for any
 * phone number entered without a code, on every contact write path in the api.
 * A workspace created with the wrong one saves contacts that can never be
 * messaged, and it is invisible from inside the product.
 *
 * Nothing here can delete a workspace. That would cascade through contacts,
 * conversations, messages, broadcasts, flows and the WhatsApp connection, and it
 * is not a thing to have one click away from a support screen.
 */
export function WorkspaceForm({
  accountId,
  name,
  defaultCountry,
  defaultCurrency,
}: {
  accountId: string;
  name: string;
  defaultCountry: string;
  defaultCurrency: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateWorkspace,
    {}
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="accountId" value={accountId} />

      <FieldGrid>
        <Field
          label="Workspace name"
          hint="What the team sees in the CRM header."
        >
          <Input name="name" defaultValue={name} maxLength={120} required />
        </Field>

        <Field
          label="Default country"
          hint="ISO 3166-1 alpha-2. Assumed for phone numbers typed without a country code."
        >
          <Input
            name="defaultCountry"
            defaultValue={defaultCountry}
            maxLength={2}
            className="w-24 uppercase"
            spellCheck={false}
            required
          />
        </Field>

        <Field
          label="Default currency"
          hint="ISO 4217. Used for product prices and deal values in this workspace."
        >
          <Input
            name="defaultCurrency"
            defaultValue={defaultCurrency}
            maxLength={3}
            className="w-24 uppercase"
            spellCheck={false}
            required
          />
        </Field>
      </FieldGrid>

      <FormMessage ok={state.ok} error={state.error} />

      <SubmitButton pendingLabel="Saving…">Save workspace</SubmitButton>
    </form>
  );
}
