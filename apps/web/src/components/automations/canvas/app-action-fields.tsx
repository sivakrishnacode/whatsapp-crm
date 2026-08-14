'use client';

/**
 * The form for an `app_action` step.
 *
 * ⚠️ EVERY FIELD BELOW IS RENDERED FROM `FieldSpec`, NOT HARD-CODED.
 *   One step type covers every connected app and every action, so there
 *   is no "Google Sheets form" to write — there is a renderer for each
 *   `FieldKind`, and the catalogue (fetched from the API) says which
 *   fields exist, what they are called and whether they are required.
 *   The API validates against the same specs, so a field cannot render
 *   here without being validated there.
 *
 *   The practical consequence: adding an action to a connector is a
 *   server-side change only. This file does not need to know about it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  connectUrl,
  connectionsFor,
  findAction,
  findApp,
  missingScopes,
  type AppConnection,
  type CatalogApp,
  type FieldSpec,
} from '@/lib/automations/connectors';
import type { TokenGroup } from '@/lib/automations/tokens';
import { FieldBlock, KeyValueTable, TokenInput } from './token-field';
import { useAutomationResources } from './resources';

const SELECT_CLASS =
  'border-border bg-muted text-foreground focus:border-primary h-8 w-full rounded-lg border px-2 py-1 text-sm focus:outline-none';

export interface AppActionFieldsProps {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  groups: TokenGroup[];
}

export function AppActionFields({
  config,
  onChange,
  groups,
}: AppActionFieldsProps) {
  const { apps, connections } = useAutomationResources();

  const app = findApp(apps, config.app as string | undefined);
  const action = findAction(app, config.action as string | undefined);
  // Memoised so the `?? {}` fallback does not mint a new object every
  // render, which would re-create setInput and re-fire the resource
  // loaders below on every keystroke.
  const input = useMemo(
    () => (config.input as Record<string, unknown> | undefined) ?? {},
    [config.input],
  );

  const available = connectionsFor(connections, app);
  const connection = available.find((c) => c.id === config.connection_id);
  const missing = missingScopes(connection, action);

  const setInput = useCallback(
    (key: string, value: unknown) => {
      onChange({ input: { ...input, [key]: value } });
    },
    [input, onChange],
  );

  if (!app) {
    // The catalogue has not arrived, or the app was withdrawn. Either
    // way the step is unusable and pretending otherwise would let
    // somebody "fix" it by filling in fields that go nowhere.
    return (
      <p className="text-muted-foreground text-xs">
        {apps.length === 0
          ? 'Loading connected apps…'
          : `This step uses "${String(config.app ?? 'an unknown app')}", which is no longer available. Delete the step or pick another app.`}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- Which account ---------------------------------------- */}
      <FieldBlock
        label={`${app.name} account`}
        hint={
          available.length === 0
            ? undefined
            : 'Which connected account this step acts as.'
        }
        group
      >
        {available.length === 0 ? (
          <div className="border-border bg-muted/40 space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-muted-foreground text-xs">
              No {app.name} account is connected yet.
            </p>
            <ConnectButton app={app} label={`Connect ${app.name}`} />
          </div>
        ) : (
          <div className="space-y-2">
            <select
              className={SELECT_CLASS}
              value={(config.connection_id as string) ?? ''}
              onChange={(e) => onChange({ connection_id: e.target.value })}
            >
              <option value="">Choose an account…</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName ?? c.id}
                  {c.status !== 'active' ? ' — needs reconnecting' : ''}
                </option>
              ))}
            </select>

            {/* A disconnected account is still LISTED (it is almost
                always the one they meant) but flagged here, because at
                run time it fails and the run stops. */}
            {connection && connection.status !== 'active' && (
              <Notice tone="warn">
                This account needs reconnecting before the automation can
                run. <ConnectButton app={app} label="Reconnect" inline />
              </Notice>
            )}

            {connection?.status === 'active' && missing.length > 0 && (
              <Notice tone="warn">
                This account has not granted {app.name} access.{' '}
                <ConnectButton
                  app={app}
                  label={`Approve ${app.name}`}
                  inline
                />
              </Notice>
            )}
          </div>
        )}
      </FieldBlock>

      {/* ---- Which action ----------------------------------------- */}
      <FieldBlock label="Action" group>
        <select
          className={SELECT_CLASS}
          value={(config.action as string) ?? ''}
          onChange={(e) =>
            // Inputs are CLEARED on an action change. Carrying them over
            // looks helpful and is not: field keys collide between
            // actions ("spreadsheet" means the same thing, "values" does
            // not), so a stale value silently posts the wrong data.
            onChange({ action: e.target.value, input: {} })
          }
        >
          <option value="">Choose an action…</option>
          {app.actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
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
          app={app}
          connection={connection}
          input={input}
        />
      ))}

      {action?.irreversible && (
        <Notice tone="info">
          This action really happens when the step runs — and when you use
          Test. There is no draft or preview mode for it.
        </Notice>
      )}
    </div>
  );
}

/** One field, chosen by its `kind`. */
function SpecField({
  spec,
  value,
  onChange,
  groups,
  app,
  connection,
  input,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  groups: TokenGroup[];
  app: CatalogApp;
  connection: AppConnection | undefined;
  input: Record<string, unknown>;
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

    case 'resource_select':
      return (
        <ResourceField
          spec={spec}
          value={value}
          onChange={onChange}
          app={app}
          connection={connection}
          input={input}
        />
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

    case 'number':
      // Not a TokenInput even though the API accepts a token here: a
      // number field with a token in it is nearly always a mistake, and
      // the API coerces "42" anyway if one does arrive from elsewhere.
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
      // `tokens: false` marks machine values — ids, enum-ish strings —
      // where a token would resolve to "" and fail obscurely. Those get
      // a plain input with no token picker, so the affordance is absent
      // rather than present-but-wrong.
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

/**
 * A dropdown whose options come from the provider — sheet tabs, calendars.
 *
 * Loads on demand rather than up front: the request costs a Google call
 * per field, and most of them depend on another field that is still
 * empty when the inspector opens.
 */
function ResourceField({
  spec,
  value,
  onChange,
  app,
  connection,
  input,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  app: CatalogApp;
  connection: AppConnection | undefined;
  input: Record<string, unknown>;
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The values this list depends on, as one string, so the effect below
  // reruns when a dependency CHANGES rather than on every keystroke of
  // any field.
  const dependencyKey = (spec.dependsOn ?? [])
    .map((key) => String(input[key] ?? ''))
    .join('|');

  const ready =
    Boolean(connection) &&
    connection?.status === 'active' &&
    (spec.dependsOn ?? []).every((key) => Boolean(input[key]));

  const load = useCallback(async () => {
    if (!ready || !connection) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/connections/${connection.id}/resources/${app.app}/${spec.resource}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
        },
      );
      const json = (await res.json()) as {
        options?: { value: string; label: string }[];
        message?: string;
      };
      if (!res.ok) throw new Error(json.message ?? 'Could not load the list');
      setOptions(json.options ?? []);
    } catch (err) {
      // Falls back to a free-text input below — a failed list must not
      // make the field unusable, especially when the value is already
      // known to the author.
      setError(err instanceof Error ? err.message : 'Could not load the list');
    } finally {
      setLoading(false);
    }
  }, [ready, connection, app.app, spec.resource, input]);

  useEffect(() => {
    void load();
    // `dependencyKey` rather than `input`: a new object identity on every
    // render would re-fetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, connection?.id, dependencyKey]);

  const label = spec.required ? `${spec.label} *` : spec.label;

  if (!ready) {
    return (
      <FieldBlock label={label} hint={spec.help} group>
        <p className="text-muted-foreground text-xs">
          {connection
            ? `Fill in ${(spec.dependsOn ?? []).join(' and ')} first.`
            : 'Choose an account first.'}
        </p>
      </FieldBlock>
    );
  }

  return (
    <FieldBlock
      label={label}
      hint={spec.help}
      group
      action={
        <button
          type="button"
          onClick={() => void load()}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Refresh
        </button>
      }
    >
      {error || options.length === 0 ? (
        <div className="space-y-1">
          <Input
            className="h-8 text-sm"
            value={String(value ?? '')}
            placeholder={spec.placeholder ?? 'Type the exact name'}
            onChange={(e) => onChange(e.target.value)}
          />
          <p className="text-muted-foreground text-[11px]">
            {error ?? 'Nothing to choose from — type the name instead.'}
          </p>
        </div>
      ) : (
        <select
          className={SELECT_CLASS}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {/* A saved value that is no longer in the list is preserved as
              its own option rather than silently reset to blank — same
              rule as the tag and template pickers. */}
          {Boolean(value) && !options.some((o) => o.value === value) && (
            <option value={String(value)}>{String(value)} (not found)</option>
          )}
        </select>
      )}
    </FieldBlock>
  );
}

function ConnectButton({
  app,
  label,
  inline,
}: {
  app: CatalogApp;
  label: string;
  inline?: boolean;
}) {
  // A full navigation, not fetch(): this is an OAuth redirect to Google
  // and back. `returnTo` brings them to the automations list afterwards.
  const href = connectUrl(app, '/automations');

  if (inline) {
    return (
      <a
        href={href}
        className="text-primary inline-flex items-center gap-1 underline underline-offset-2"
      >
        {label}
        <ExternalLink className="size-3" />
      </a>
    );
  }

  // A plain anchor, not a Button: this is a full navigation into
  // Google's consent screen, and this design system's Button has no
  // `asChild` escape hatch to render one.
  return (
    <a
      href={href}
      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors"
    >
      {label}
      <ExternalLink className="size-3.5" />
    </a>
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
          ? 'flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400'
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
