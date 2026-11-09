'use client';

import { useActionState, type ReactNode } from 'react';

import { FormMessage } from '@/components/ui/form';
import { updateTicket } from '@/lib/actions/tickets';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * One small form per control on the ticket page, all posting to
 * `updateTicket` with a different `intent`. Each keeps its own result
 * message, so "Assigned to Priya" appears under the assign control and not
 * beside an unrelated button.
 *
 * Fields are passed as children (server-rendered markup is fine inside a
 * client component), so each control stays declared where it is used.
 */
export function TicketActionForm({
  ticketId,
  intent,
  children,
  className = '',
}: {
  ticketId: string;
  intent: string;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateTicket,
    {}
  );

  return (
    <form action={formAction} className={`space-y-2 ${className}`}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="intent" value={intent} />
      {children}
      <FormMessage ok={state.ok} error={state.error} />
    </form>
  );
}
