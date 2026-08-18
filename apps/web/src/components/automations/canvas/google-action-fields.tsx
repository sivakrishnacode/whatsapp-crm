'use client';

/**
 * The form for a `google_action` step.
 *
 * Simpler than the old `AppActionFields`: no OAuth connection picker,
 * no scope checks. The bridge is workspace-wide — one deployment serves
 * all Google services — so the only question is "which action" and "what
 * input". Whether the bridge is set up at all is checked by diagnostics
 * and shown as a banner here.
 *
 * ⚠️ EVERY FIELD IS RENDERED FROM `FieldSpec`, NOT HARD-CODED.
 *   See app-action-fields.tsx for the design rationale. The same
 *   `SpecField` pattern applies: the catalogue says what exists, the
 *   editor renders it, the API validates against the same specs.
 */

import { useCallback, useMemo } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  findGoogleAction,
  type FieldSpec,
  type GoogleScriptAction,
  type GoogleServiceLabels,
} from '@/lib/automations/connectors';
import type { TokenGroup } from '@/lib/automations/tokens';
import { FieldBlock, KeyValueTable, TokenInput } from './token-field';
import { useAutomationResources } from './resources';

const SELECT_CLASS =
  'border-border bg-muted text-foreground focus:border-primary h-8 w-full rounded-lg border px-2 py-1 text-sm focus:outline-none';

export interface GoogleActionFieldsProps {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  groups: TokenGroup[];
}

export function GoogleActionFields({
  config,
  onChange,
  groups,
}: GoogleActionFieldsProps) {
  const { googleActions, googleServiceLabels, googleConnection } =
    useAutomationResources();

  const action = findGoogleAction(
    googleActions,
    config.action as string | undefined
  );
  const input = useMemo(
    () => (config.input as Record<string, unknown> | undefined) ?? {},
    [config.input]
  );

  const setInput = useCallback(
    (key: string, value: unknown) => {
      onChange({ input: { ...input, [key]: value } });
    },
    [input, onChange]
  );

  // Bridge not set up — show a prominent notice.
  const notConfigured =
    !googleConnection ||
    googleConnection.status === 'not_configured' ||
    googleConnection.status === 'provisioned';

  if (googleActions.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">Loading Google actions…</p>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- Bridge status ---------------------------------------- */}
      {notConfigured && (
        <Notice tone="warn">
          Google is not connected yet.{' '}
          <a
            href="/integrations"
            className="text-primary inline-flex items-center gap-1 underline underline-offset-2"
          >
            Set it up in Integrations
            <ExternalLink className="size-3" />
          </a>
        </Notice>
      )}

      {googleConnection?.status === 'error' && (
        <Notice tone="warn">
          Google connection has an error:{' '}
          {googleConnection.lastError ?? 'Unknown error'}.{' '}
          <a
            href="/integrations"
            className="text-primary inline-flex items-center gap-1 underline underline-offset-2"
          >
            Check Integrations
            <ExternalLink className="size-3" />
          </a>
        </Notice>
      )}

      {/* ---- Which action ----------------------------------------- */}
      <FieldBlock label="Action" group>
        <select
          className={SELECT_CLASS}
          value={(config.action as string) ?? ''}
          onChange={(e) =>
            // Inputs are CLEARED on an action change. Same rationale as
            // app-action-fields: field keys collide between actions.
            onChange({ action: e.target.value, input: {} })
          }
        >
          <option value="">Choose an action…</option>
          {groupActions(googleActions, googleServiceLabels).map((group) => (
            <optgroup key={group.service} label={group.label}>
              {group.actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {action && (
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            {action.description}
          </p>
        )}
      </FieldBlock>

      {/* ---- The action's own fields ------------------------------- */}
      {action?.inputs.map((spec) => (
        <SpecField
          key={spec.key}
          spec={spec}
          value={input[spec.key]}
          onChange={(value) => setInput(spec.key, value)}
          groups={groups}
        />
      ))}

      {action?.irreversible && (
        <Notice tone="info">
          This action really happens when the step runs — and when you use Test.
          There is no draft or preview mode for it.
        </Notice>
      )}
    </div>
  );
}

/** Group actions by service for the optgroup dropdown. */
function groupActions(
  actions: GoogleScriptAction[],
  labels: GoogleServiceLabels
): { service: string; label: string; actions: GoogleScriptAction[] }[] {
  const groups = new Map<string, GoogleScriptAction[]>();
  for (const action of actions) {
    const list = groups.get(action.service) ?? [];
    list.push(action);
    groups.set(action.service, list);
  }
  return Array.from(groups.entries()).map(([service, acts]) => ({
    service,
    label: labels[service] ?? service,
    actions: acts,
  }));
}

/** One field, chosen by its `kind`. */
function SpecField({
  spec,
  value,
  onChange,
  groups,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  groups: TokenGroup[];
}) {
  const label = spec.required ? `${spec.label} *` : spec.label;

  switch (spec.kind) {
    case 'boolean':
      return (
        <FieldBlock label={label} hint={spec.help} group>
          <Switch
            checked={Boolean(value ?? spec.default)}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </FieldBlock>
      );

    case 'select':
      return (
        <FieldBlock label={label} hint={spec.help} group>
          <select
            className={SELECT_CLASS}
            value={String(value ?? spec.default ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {!spec.required && <option value="">—</option>}
            {spec.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldBlock>
      );

    case 'key_values':
      return (
        <KeyValueTable
          label={label}
          hint={spec.help}
          rows={(value as Record<string, unknown>) ?? {}}
          onChange={(next) => onChange(next)}
          groups={groups}
          keyPlaceholder="column"
          valuePlaceholder="{{ contact.name }}"
          addLabel="Add value"
        />
      );

    case 'value_list':
      return (
        <ValueListField
          label={label}
          hint={spec.help}
          values={(value as string[] | undefined) ?? []}
          onChange={onChange}
          groups={groups}
          tokens={spec.tokens ?? false}
        />
      );

    case 'number':
      return (
        <FieldBlock label={label} hint={spec.help} group>
          <Input
            type="number"
            className="h-8 text-sm"
            value={String(value ?? spec.default ?? '')}
            placeholder={spec.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </FieldBlock>
      );

    case 'email_list':
    case 'long_text':
    case 'text':
    default: {
      if (!spec.tokens) {
        return (
          <FieldBlock label={label} hint={spec.help} group>
            <Input
              className="h-8 text-sm"
              value={String(value ?? '')}
              placeholder={spec.placeholder}
              onChange={(e) => onChange(e.target.value)}
            />
          </FieldBlock>
        );
      }
      return (
        <TokenInput
          label={label}
          hint={spec.help}
          value={String(value ?? '')}
          placeholder={spec.placeholder}
          onChange={(next) => onChange(next)}
          groups={groups}
          multiline={spec.kind === 'long_text'}
          rows={spec.kind === 'long_text' ? 6 : undefined}
        />
      );
    }
  }
}

/** A list of strings — e.g. sheet row values. */
function ValueListField({
  label,
  hint,
  values,
  onChange,
  groups,
  tokens,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: unknown) => void;
  groups: TokenGroup[];
  tokens: boolean;
}) {
  const update = (index: number, value: string) => {
    const next = [...values];
    next[index] = value;
    onChange(next);
  };
  const add = () => onChange([...values, '']);
  const remove = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <FieldBlock label={label} hint={hint} group>
      <div className="space-y-1.5">
        {values.map((v, i) =>
          tokens ? (
            <div key={i} className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <TokenInput
                  label=""
                  value={v}
                  placeholder={`Value ${i + 1}`}
                  onChange={(next) => update(i, next)}
                  groups={groups}
                />
              </div>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive shrink-0 text-xs"
              >
                ×
              </button>
            </div>
          ) : (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                className="h-8 text-sm"
                value={v}
                placeholder={`Value ${i + 1}`}
                onChange={(e) => update(i, e.target.value)}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive shrink-0 text-xs"
              >
                ×
              </button>
            </div>
          )
        )}
        <button
          type="button"
          onClick={add}
          className="text-primary text-xs hover:underline"
        >
          + Add value
        </button>
      </div>
    </FieldBlock>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'warn' | 'info';
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        tone === 'warn'
          ? 'text-accent-amber flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px]'
          : 'text-muted-foreground border-border bg-muted/40 flex items-start gap-2 rounded-lg border p-2.5 text-[11px]'
      }
    >
      {tone === 'warn' && (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span>{children}</span>
    </div>
  );
}
