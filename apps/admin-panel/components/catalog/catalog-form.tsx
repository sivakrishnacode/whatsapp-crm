'use client';

import { useActionState } from 'react';

import {
  Checkbox,
  Field,
  FieldGrid,
  FormMessage,
  Input,
  Select,
  Textarea,
} from '@/components/ui/form';
import { Callout } from '@/components/ui/page';
import { SubmitButton } from '@/components/ui/submit-button';
import { updateCatalogEntry } from '@/lib/actions/catalog';
import type { ActionState } from '@/lib/actions/subscriptions';

/**
 * Edit one Converse alias — the customer-facing label and the internal
 * mapping, in two clearly separated groups. Rendered only for `catalog.manage`;
 * the action checks again.
 */
export function CatalogForm({
  entry,
  plans,
}: {
  entry: {
    alias: string;
    name: string;
    tagline: string;
    description: string | null;
    isActive: boolean;
    plans: string[];
    provider: string | null;
    model: string | null;
    fallbackProvider: string | null;
    fallbackModel: string | null;
    maxOutputTokens: number | null;
    toolPolicy: string;
    promptVersion: string | null;
    notes: string | null;
  };
  plans: { name: string; displayName: string; isActive: boolean }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateCatalogEntry,
    {}
  );

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="alias" value={entry.alias} />

      <fieldset className="space-y-4">
        <legend className="text-ink mb-2 text-sm font-semibold">
          What customers see
        </legend>
        <FieldGrid>
          <Field label="Name">
            <Input
              name="name"
              defaultValue={entry.name}
              maxLength={40}
              required
            />
          </Field>
          <Field label="Tagline">
            <Input
              name="tagline"
              defaultValue={entry.tagline}
              maxLength={120}
              required
            />
          </Field>
        </FieldGrid>
        <Field label="Description">
          <Textarea
            name="description"
            defaultValue={entry.description ?? ''}
            maxLength={500}
            rows={2}
          />
        </Field>
        <FieldGrid>
          <Field
            label="Tool policy"
            hint="What the persona may do beyond answering: nothing, read our data, or take permissioned actions."
          >
            <Select name="toolPolicy" defaultValue={entry.toolPolicy}>
              <option value="none">Answers only</option>
              <option value="read_only">Read-only tools</option>
              <option value="permissioned">Permissioned actions</option>
            </Select>
          </Field>
          <div>
            <p className="text-ink-2 mb-1.5 text-xs font-medium">
              Offered on plans
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {plans.map((plan) => (
                <label
                  key={plan.name}
                  className="text-ink-2 flex items-center gap-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    name="plans"
                    value={plan.name}
                    defaultChecked={entry.plans.includes(plan.name)}
                    className="accent-primary size-4"
                  />
                  {plan.displayName}
                  {plan.isActive ? null : (
                    <span className="text-muted text-xs">(not offered)</span>
                  )}
                </label>
              ))}
            </div>
            <p className="text-muted mt-1 text-xs">None ticked = every plan.</p>
          </div>
        </FieldGrid>
      </fieldset>

      <fieldset className="border-line space-y-4 border-t pt-5">
        <legend className="text-ink mb-2 text-sm font-semibold">
          Internal mapping — staff only
        </legend>
        <Callout tone="warn">
          Never shown to customers or returned by a customer API. Not read by
          the agent runtime yet, so saving changes no live traffic.
        </Callout>
        <FieldGrid>
          <Field label="Provider">
            <Select name="provider" defaultValue={entry.provider ?? ''}>
              <option value="">Not mapped</option>
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </Field>
          <Field
            label="Model id"
            hint="Pinned version, exactly as the provider names it."
          >
            <Input
              name="model"
              defaultValue={entry.model ?? ''}
              placeholder="gemini-3.5-flash-lite"
              spellCheck={false}
              maxLength={100}
            />
          </Field>
          <Field label="Fallback provider">
            <Select
              name="fallbackProvider"
              defaultValue={entry.fallbackProvider ?? ''}
            >
              <option value="">No fallback</option>
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </Field>
          <Field label="Fallback model id">
            <Input
              name="fallbackModel"
              defaultValue={entry.fallbackModel ?? ''}
              spellCheck={false}
              maxLength={100}
            />
          </Field>
          <Field
            label="Max output tokens"
            hint="64–65,536. Leave empty for the provider default."
          >
            <Input
              type="number"
              name="maxOutputTokens"
              defaultValue={entry.maxOutputTokens ?? ''}
              min={64}
              max={65536}
              step={1}
            />
          </Field>
          <Field label="Prompt version">
            <Input
              name="promptVersion"
              defaultValue={entry.promptVersion ?? ''}
              placeholder="v1"
              maxLength={40}
            />
          </Field>
        </FieldGrid>
        <Field
          label="Notes"
          hint="Cost caps, tested languages, why this model — for the next person."
        >
          <Textarea
            name="notes"
            defaultValue={entry.notes ?? ''}
            maxLength={1000}
            rows={2}
          />
        </Field>
        <Checkbox
          name="isActive"
          label="Active"
          defaultChecked={entry.isActive}
          hint="Requires a mapping. An active alias with nothing behind it is refused."
        />
      </fieldset>

      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton pendingLabel="Saving…">Save alias</SubmitButton>
    </form>
  );
}
