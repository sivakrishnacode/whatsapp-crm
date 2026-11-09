'use client';

import { useActionState } from 'react';

import {
  CATEGORY_LABEL,
  SEVERITY_STYLE,
  SOURCE_LABEL,
  TIER_LABEL,
} from '@/components/ops/badges';
import {
  Field,
  FieldGrid,
  FormMessage,
  Input,
  Select,
  Textarea,
} from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { createTicket } from '@/lib/actions/tickets';
import type { ActionState } from '@/lib/actions/subscriptions';
import {
  SEVERITIES,
  TICKET_CATEGORIES,
  TICKET_SOURCES,
  TICKET_TIERS,
} from '@/lib/sla';

export type TicketDefaults = {
  accountId: string;
  subject: string;
  description: string;
  category: string;
  severity: string;
  tier: string;
  source: string;
  requester: string;
  incident: string;
};

/**
 * New ticket. Everything is a plain field the server re-validates; the only
 * thing that is NOT taken from this form is the diagnostic snapshot of an
 * incident ticket, which the server re-reads at submission.
 */
export function TicketCreateForm({
  defaults,
  clients,
  staff,
  lockedClientName,
  canSelfAssign,
}: {
  defaults: TicketDefaults;
  /** Workspaces to choose from when the ticket did not arrive with one. */
  clients: { id: string; name: string }[];
  staff: { id: string; name: string }[];
  /** Set when the client came from the URL — shown, not editable. */
  lockedClientName: string | null;
  canSelfAssign: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createTicket,
    {}
  );

  return (
    <form action={formAction} className="space-y-5">
      {defaults.incident ? (
        <input type="hidden" name="incident" value={defaults.incident} />
      ) : null}

      {lockedClientName ? (
        <>
          <input type="hidden" name="accountId" value={defaults.accountId} />
          <Field label="Client">
            <Input value={lockedClientName} readOnly disabled />
          </Field>
        </>
      ) : (
        <Field
          label="Client"
          hint="Leave empty for an internal ticket that is not about one client."
        >
          <Select name="accountId" defaultValue={defaults.accountId}>
            <option value="">No client (internal)</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Subject">
        <Input
          name="subject"
          defaultValue={defaults.subject}
          maxLength={200}
          required
          placeholder="What is wrong, in one line"
        />
      </Field>

      <Field
        label="Description"
        hint="What the customer reported, what you have checked, and what is still unknown. Never paste a password, OTP or access token."
      >
        <Textarea
          name="description"
          defaultValue={defaults.description}
          rows={6}
          maxLength={8000}
        />
      </Field>

      <FieldGrid>
        <Field label="Category">
          <Select name="category" defaultValue={defaults.category}>
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABEL[value] ?? value}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Severity"
          hint="Sets the SLA targets. Critical: a customer cannot message at all."
        >
          <Select name="severity" defaultValue={defaults.severity}>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_STYLE[value].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Queue (tier)">
          <Select name="tier" defaultValue={defaults.tier}>
            {TICKET_TIERS.map((value) => (
              <option key={value} value={value}>
                {TIER_LABEL[value] ?? value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source">
          <Select name="source" defaultValue={defaults.source}>
            {TICKET_SOURCES.map((value) => (
              <option key={value} value={value}>
                {SOURCE_LABEL[value] ?? value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Requester" hint="Who raised it — a name, email or phone.">
          <Input
            name="requester"
            defaultValue={defaults.requester}
            maxLength={200}
          />
        </Field>
        <Field label="Assignee">
          <Select name="assignee" defaultValue="">
            <option value="">Unassigned</option>
            {canSelfAssign ? <option value="me">Me</option> : null}
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGrid>

      <FormMessage error={state.error} />

      <SubmitButton pendingLabel="Opening…">Open ticket</SubmitButton>
    </form>
  );
}
