'use client';

import { useActionState, useState } from 'react';

import {
  Checkbox,
  Field,
  FieldGrid,
  FormMessage,
  Input,
} from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { updateCreditPack } from '@/lib/actions/credits';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Editing one credit pack.
 *
 * The price is typed in MAJOR units (299, not 29900). `ai_credit_packs`
 * stores minor units and the server converts once — a form that made the
 * operator type paise is the shortest path to a 100× mistake.
 *
 * Per-credit rate is shown live because that is the number that has to make
 * sense across the ladder: a bigger pack must never cost more per credit than a
 * smaller one, and this is where you notice it.
 *
 * `currency` is not editable. It is per-row in the table but changing it would
 * reprice the pack by whatever the exchange rate happens to be, and selling in a
 * second currency is a decision about which customers see which packs, not a
 * text field.
 */
export function PackForm({
  packId,
  code,
  displayName,
  credits,
  priceMajor,
  currencyCode,
  badge,
  sortOrder,
  isActive,
  sold,
}: {
  packId: string;
  code: string;
  displayName: string;
  credits: number;
  priceMajor: number;
  currencyCode: string;
  badge: string | null;
  sortOrder: number;
  isActive: boolean;
  sold: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateCreditPack,
    {}
  );
  const [creditsValue, setCreditsValue] = useState(String(credits));
  const [priceValue, setPriceValue] = useState(String(priceMajor));

  const c = Number(creditsValue);
  const p = Number(priceValue);
  const rate = c > 0 && Number.isFinite(p) ? p / c : null;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="packId" value={packId} />

      <FieldGrid>
        <Field label="Display name" hint={`Sold as code "${code}".`}>
          <Input name="displayName" defaultValue={displayName} required />
        </Field>

        <Field label="Credits" hint="What the customer receives.">
          <Input
            type="number"
            name="credits"
            value={creditsValue}
            onChange={(event) => setCreditsValue(event.target.value)}
            min={1}
            step={1}
            required
          />
        </Field>

        <Field
          label={`Price (${currencyCode})`}
          hint={
            rate === null
              ? 'Stored as minor units — type whole currency here.'
              : `${rate.toFixed(3)} ${currencyCode} per credit.`
          }
        >
          <Input
            type="number"
            name="price"
            value={priceValue}
            onChange={(event) => setPriceValue(event.target.value)}
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field label="Badge" hint='Ribbon text, e.g. "Popular". Empty for none.'>
          <Input name="badge" defaultValue={badge ?? ''} maxLength={24} />
        </Field>

        <Field label="Sort order" hint="Lower shows first.">
          <Input
            type="number"
            name="sortOrder"
            defaultValue={sortOrder}
            min={0}
            max={9999}
            required
          />
        </Field>
      </FieldGrid>

      <Checkbox
        name="isActive"
        label="Offered to customers"
        defaultChecked={isActive}
        hint={
          sold > 0
            ? `${sold} pack(s) already sold. Turning this off hides it from the top-up page; past purchases keep the price they were charged.`
            : 'Turning this off hides it from the top-up page.'
        }
      />

      <FormMessage ok={state.ok} error={state.error} />

      <SubmitButton pendingLabel="Saving…">Save pack</SubmitButton>
    </form>
  );
}
