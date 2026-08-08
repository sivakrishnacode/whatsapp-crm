'use client';

import { useActionState } from 'react';

import { FormMessage, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { memberAction } from '@/lib/actions/workspaces';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * The three things you can do to one member, in one form.
 *
 * Each button carries its own `intent` (a submit button's name/value is included
 * in the FormData), so all three share a single action, a single result message
 * and a single pending state — the same idiom as the subscription quick actions.
 *
 * The owner is rendered without any of them. Their role cannot be changed and
 * they cannot be removed: an account with no owner has nobody to bill and no row
 * for `accounts.owner_user_id` to point at. Ownership moves by promoting someone
 * else, which is the `Make owner` button on every other row.
 */
export function MemberActions({
  accountId,
  userId,
  role,
  isOwner,
  assignedDeals,
}: {
  accountId: string;
  userId: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  isOwner: boolean;
  assignedDeals: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    memberAction,
    {}
  );

  if (isOwner) {
    return (
      <p className="text-muted max-w-64 text-xs leading-relaxed">
        Owns this workspace. Promote another member to move ownership — the
        subscription follows the owner.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="userId" value={userId} />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select name="role" defaultValue={role} className="w-auto">
          <option value="admin">admin</option>
          <option value="agent">agent</option>
          <option value="viewer">viewer</option>
        </Select>

        <SubmitButton
          name="intent"
          value="set_role"
          variant="secondary"
          pendingLabel="…"
        >
          Apply
        </SubmitButton>

        <SubmitButton
          name="intent"
          value="transfer_ownership"
          variant="secondary"
          pendingLabel="…"
        >
          Make owner
        </SubmitButton>

        <SubmitButton
          name="intent"
          value="remove"
          variant="danger"
          pendingLabel="…"
        >
          Remove
        </SubmitButton>
      </div>

      {assignedDeals > 0 ? (
        <p className="text-muted text-right text-xs">
          {assignedDeals} deal{assignedDeals === 1 ? '' : 's'} assigned — those
          stay assigned to them after removal.
        </p>
      ) : null}

      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
