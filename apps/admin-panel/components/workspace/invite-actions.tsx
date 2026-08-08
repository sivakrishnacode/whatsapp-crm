'use client';

import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { revokeInvitation } from '@/lib/actions/workspaces';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Revoke one pending invitation.
 *
 * The row is deleted rather than flagged, because the invitation's authority IS
 * its `token_hash` row — deleting it is what makes the emailed link stop
 * working. Nothing is sent to whoever was invited.
 */
export function InviteActions({
  accountId,
  inviteId,
}: {
  accountId: string;
  inviteId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    revokeInvitation,
    {}
  );

  return (
    <form action={formAction} className="space-y-2 text-right">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <SubmitButton variant="danger" pendingLabel="…">
        Revoke
      </SubmitButton>
      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
