'use client';

import { useActionState } from 'react';

import { FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { memberAction } from '@/lib/actions/workspaces';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Add an existing login to this workspace.
 *
 * ⚠️ This is how a user ends up in TWO workspaces before self-serve creation
 * ships. Phase 1 keeps `idx_accounts_one_per_owner`, so nobody can create a
 * second workspace of their own — an operator attaching them to an existing one
 * is the only route, and therefore the only way to exercise the switcher.
 *
 * ⚠️ It does NOT create logins. Adding somebody who has never signed up would
 * mean minting an auth user from an admin panel with no email verification, no
 * password and no consent — an invite link is the product's answer to that, and
 * it already exists. The action says so explicitly rather than failing vaguely.
 *
 * `owner` is absent from the role list on purpose: there is exactly one owner
 * per workspace and billing resolves through it, so granting a second is a
 * transfer, which is its own button on the member row.
 */
export function AddMember({ accountId }: { accountId: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    memberAction,
    {}
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="accountId" value={accountId} />

      <div className="flex flex-wrap items-end gap-2">
        <Input
          name="email"
          type="email"
          required
          placeholder="teammate@example.com"
          className="min-w-56 flex-1"
          aria-label="Email of an existing login"
        />

        <Select name="role" defaultValue="agent" className="w-auto">
          <option value="admin">admin</option>
          <option value="agent">agent</option>
          <option value="viewer">viewer</option>
        </Select>

        <SubmitButton
          name="intent"
          value="add"
          variant="secondary"
          pendingLabel="Adding…"
        >
          Add to workspace
        </SubmitButton>
      </div>

      <p className="text-muted text-xs leading-relaxed">
        The person must already have a Converse360 login. They keep every other
        workspace they belong to and can switch between them without signing
        out.
      </p>

      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
