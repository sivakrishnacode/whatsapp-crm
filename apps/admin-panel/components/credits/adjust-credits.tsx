'use client';

import { useActionState, useState } from 'react';

import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { adjustCredits } from '@/lib/actions/credits';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Manual credit top-up or clawback for one workspace.
 *
 * The projected balance updates as you type. Not decoration: the number that
 * matters is what the wallet will hold afterwards, and an operator who has to do
 * the arithmetic is the one who grants 25,000 instead of 2,500. The server is
 * still the authority — it applies `ADMIN_MAX_CREDIT_ADJUSTMENT` and, on a
 * deduction, takes only what is there and reports how much that was.
 *
 * The reason field is `required` here and required again on the server. A grant
 * with no explanation is indistinguishable from a mistake when someone reads the
 * ledger back months later.
 */
export function AdjustCredits({
  accountId,
  balance,
  creditMode,
  maxAdjustment,
}: {
  accountId: string;
  balance: number;
  creditMode: 'platform' | 'byok' | null;
  maxAdjustment: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    adjustCredits,
    {}
  );
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');

  const parsed = Number(amount);
  const valid = Number.isInteger(parsed) && parsed > 0;
  const projected = valid
    ? direction === 'add'
      ? balance + parsed
      : Math.max(balance - parsed, 0)
    : balance;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="accountId" value={accountId} />

      {creditMode === 'byok' ? (
        <p className="border-ring text-ink-2 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed">
          <span
            aria-hidden
            className="bg-warning mt-1 size-1.5 shrink-0 rounded-full"
          />
          <span>
            This workspace runs the agent on{' '}
            <strong className="text-ink font-semibold">
              its own provider key
            </strong>
            , so nothing is metered against credits. Anything added here sits
            unused until they switch to platform mode.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Direction">
          <Select
            name="direction"
            value={direction}
            onChange={(event) =>
              setDirection(event.target.value as 'add' | 'remove')
            }
            className="w-auto"
          >
            <option value="add">Add credits</option>
            <option value="remove">Deduct credits</option>
          </Select>
        </Field>

        <Field label="Credits" hint={`Up to ${maxAdjustment} per adjustment.`}>
          <Input
            type="number"
            name="amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            min={1}
            max={maxAdjustment}
            step={1}
            placeholder="250"
            required
            className="w-32"
          />
        </Field>

        <div className="pb-1">
          <p className="text-muted text-xs">Balance after</p>
          <p className="text-ink tabular mt-1 text-lg font-semibold">
            {projected.toLocaleString('en-IN')}
          </p>
        </div>
      </div>

      <Field
        label="Reason"
        hint="Stored on the ledger entry and in the audit log. Write it for whoever reads this in six months."
      >
        <Input
          name="note"
          placeholder="Goodwill after the 12 Aug outage"
          maxLength={200}
          required
        />
      </Field>

      <FormMessage ok={state.ok} error={state.error} />

      <SubmitButton
        variant={direction === 'add' ? 'primary' : 'danger'}
        pendingLabel="Working…"
      >
        {direction === 'add' ? 'Add credits' : 'Deduct credits'}
      </SubmitButton>
    </form>
  );
}
