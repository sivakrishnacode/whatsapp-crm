'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Play,
  Plus,
  Plug,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useCan } from '@/hooks/use-can';
import type {
  ActionParameter,
  ActionParamLocation,
  AgentAction,
} from '@/lib/agents/types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const LOCATIONS: ActionParamLocation[] = ['query', 'body', 'path'];

interface Draft {
  id: string | null;
  name: string;
  intent: string;
  description: string;
  method: (typeof METHODS)[number];
  url: string;
  parameters: ActionParameter[];
  headers: Array<{ key: string; value: string }>;
  enabled: boolean;
  timeout_ms: number;
}

const emptyDraft = (): Draft => ({
  id: null,
  name: '',
  intent: '',
  description: '',
  method: 'GET',
  url: '',
  parameters: [],
  headers: [],
  enabled: true,
  timeout_ms: 8000,
});

/**
 * Custom API actions — your own endpoints, exposed to the agent as tools.
 *
 * The agent supplies parameter VALUES; everything else (endpoint, method,
 * headers) is what an admin configured here, so a prompt-injected "call
 * your action against evil.test" is not expressible. Header values are
 * encrypted server-side and never come back — this screen shows which
 * header NAMES are set, which is enough to know whether credentials are
 * configured without handing them to a browser.
 */
export function AgentActions({ onChanged }: { onChanged?: () => void }) {
  const canEdit = useCan('edit-settings');
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/actions', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { actions: AgentAction[] };
      setActions(data.actions);
    } catch {
      toast.error('Could not load actions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  const startEdit = (action: AgentAction) => {
    setDraft({
      id: action.id,
      name: action.name,
      intent: action.intent ?? '',
      description: action.description,
      method: action.method,
      url: action.url,
      parameters: action.parameters,
      // Values are never returned, so an edit starts with the header
      // fields blank and leaves the stored ones untouched unless the
      // admin types new ones.
      headers: [],
      enabled: action.enabled,
      timeout_ms: action.timeout_ms,
    });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const headers = draft.headers.filter((h) => h.key.trim() && h.value.trim());
      const body: Record<string, unknown> = {
        name: draft.name.trim().toLowerCase(),
        intent: draft.intent.trim() || null,
        description: draft.description.trim(),
        method: draft.method,
        url: draft.url.trim(),
        parameters: draft.parameters,
        enabled: draft.enabled,
        timeout_ms: draft.timeout_ms,
      };
      if (headers.length > 0) {
        body.headers = Object.fromEntries(headers.map((h) => [h.key.trim(), h.value]));
      }

      const res = await fetch(
        draft.id ? `/api/ai/actions/${draft.id}` : '/api/ai/actions',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not save the action.');
        return;
      }
      toast.success('Action saved.');
      setDraft(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (action: AgentAction) => {
    if (!window.confirm(`Delete “${action.name}”? The agent will stop calling it.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/actions/${action.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
      toast.success('Deleted.');
      await refresh();
    } catch {
      toast.error('Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (action: AgentAction, enabled: boolean) => {
    setActions((prev) =>
      prev.map((a) => (a.id === action.id ? { ...a, enabled } : a)),
    );
    const res = await fetch(`/api/ai/actions/${action.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      toast.error('Could not change that.');
      await refresh();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading actions…
      </div>
    );
  }

  if (draft) {
    return (
      <ActionEditor
        draft={draft}
        busy={busy}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={save}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Let the agent call your own APIs — check stock in your ERP, look up a
          booking, raise a ticket. It fills in the parameters you declare;
          the endpoint, method and credentials stay exactly as you set them here.
        </p>
        {canEdit && (
          <Button size="sm" onClick={() => setDraft(emptyDraft())}>
            <Plus className="size-4" />
            New action
          </Button>
        )}
      </div>

      {actions.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Plug className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">No actions yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Skills already give the agent access to your orders, catalogue and
            contacts. Actions are for everything that lives in a system we don’t
            host.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {actions.map((action) => (
            <li key={action.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {action.name}
                    </code>
                    <Badge variant="outline">{action.method}</Badge>
                    {action.intent && (
                      <Badge variant="secondary">{action.intent}</Badge>
                    )}
                    {action.header_names.length > 0 && (
                      <Badge variant="outline" className="gap-1">
                        <KeyRound className="size-3" />
                        {action.header_names.join(', ')}
                      </Badge>
                    )}
                  </div>

                  <p className="mt-1 text-sm text-foreground">{action.description}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {action.url}
                  </p>

                  {action.parameters.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Parameters:{' '}
                      {action.parameters
                        .map(
                          (p) =>
                            `${p.name}${p.required ? '*' : ''} (${p.type}, ${p.in})`,
                        )
                        .join(', ')}
                    </p>
                  )}

                  {action.last_error ? (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      Last call failed: {action.last_error}
                    </p>
                  ) : action.last_used_at ? (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-accent-green">
                      <CheckCircle2 className="size-3.5" />
                      Last call succeeded
                      {action.last_status ? ` (HTTP ${action.last_status})` : ''}
                    </p>
                  ) : null}
                </div>

                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={action.enabled}
                      onCheckedChange={(v) => void toggle(action, v)}
                      aria-label={`Enable ${action.name}`}
                    />
                    <Button variant="ghost" size="sm" onClick={() => startEdit(action)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(action)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${action.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </div>

              {canEdit && <ActionTester action={action} onRan={refresh} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Run the action once with values you type, and see exactly what came back. */
function ActionTester({
  action,
  onRan,
}: {
  action: AgentAction;
  onRan: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    status: number | null;
    duration_ms: number;
    result: string;
  } | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/ai/actions/${action.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: values }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Test failed.');
        return;
      }
      setResult(data);
      await onRan();
    } finally {
      setRunning(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 h-7 px-2 text-xs text-primary"
        onClick={() => setOpen(true)}
      >
        <Play className="size-3" />
        Test this action
      </Button>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">
          Test call — the agent would see exactly this result
        </p>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>

      {action.parameters.map((param) => (
        <div key={param.name} className="space-y-1">
          <Label htmlFor={`test-${action.id}-${param.name}`} className="text-xs">
            {param.name}
            {param.required && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            id={`test-${action.id}-${param.name}`}
            value={values[param.name] ?? ''}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [param.name]: e.target.value }))
            }
            placeholder={param.description || param.type}
            className="h-8 text-xs"
          />
        </div>
      ))}

      <Button size="sm" onClick={run} disabled={running}>
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        Run
      </Button>

      {result && (
        <div className="space-y-1">
          <p
            className={cn(
              'text-xs font-medium',
              result.ok
                ? 'text-accent-green'
                : 'text-destructive',
            )}
          >
            {result.ok ? 'Success' : 'Failed'}
            {result.status ? ` · HTTP ${result.status}` : ''} · {result.duration_ms}ms
          </p>
          <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground">
            {result.result}
          </pre>
        </div>
      )}
    </div>
  );
}

function ActionEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (next: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });

  const setParam = (index: number, patch: Partial<ActionParameter>) => {
    const next = [...draft.parameters];
    next[index] = { ...next[index], ...patch };
    set('parameters', next);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">
          {draft.id ? 'Edit action' : 'New action'}
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
          Cancel
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="action-name">Tool name</Label>
          <Input
            id="action-name"
            value={draft.name}
            onChange={(e) => set('name', e.target.value.toLowerCase())}
            placeholder="check_stock"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, numbers and underscores. This is the name the
            agent calls.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="action-intent">Group (optional)</Label>
          <Input
            id="action-intent"
            value={draft.intent}
            onChange={(e) => set('intent', e.target.value)}
            placeholder="Inventory"
          />
          <p className="text-xs text-muted-foreground">
            Only for organising this list.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="action-description">When should the agent call this?</Label>
        <Textarea
          id="action-description"
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
          rows={2}
          placeholder="Check live stock for a product SKU in the warehouse system."
        />
        <p className="text-xs text-muted-foreground">
          The agent reads this to decide. Be specific about what it returns and
          when it is the right call — this sentence does more work than anything
          else on this form.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="action-url">Endpoint</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={draft.method}
            onValueChange={(v) => set('method', v as Draft['method'])}
          >
            <SelectTrigger className="sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            id="action-url"
            value={draft.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://erp.example.com/stock/{sku}"
            className="font-mono"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Must be a public https endpoint. Use <code>{'{name}'}</code> for a path
          parameter. Private and internal addresses are refused.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Parameters</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              set('parameters', [
                ...draft.parameters,
                {
                  name: '',
                  type: 'string',
                  description: '',
                  required: false,
                  in: 'query',
                },
              ])
            }
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>

        {draft.parameters.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None — the agent calls the endpoint as-is.
          </p>
        ) : (
          <ul className="space-y-2">
            {draft.parameters.map((param, index) => (
              <li
                key={index}
                className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_7rem_7rem_auto]"
              >
                <Input
                  value={param.name}
                  onChange={(e) => setParam(index, { name: e.target.value })}
                  placeholder="sku"
                  className="font-mono text-xs"
                />
                <Select
                  value={param.type}
                  onValueChange={(v) =>
                    setParam(index, { type: v as ActionParameter['type'] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">string</SelectItem>
                    <SelectItem value="number">number</SelectItem>
                    <SelectItem value="boolean">boolean</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={param.in}
                  onValueChange={(v) =>
                    setParam(index, { in: v as ActionParamLocation })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATIONS.map((loc) => (
                      <SelectItem key={loc} value={loc}>
                        {loc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={param.required}
                      onChange={(e) =>
                        setParam(index, { required: e.target.checked })
                      }
                      className="size-3.5 accent-primary"
                    />
                    required
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      set(
                        'parameters',
                        draft.parameters.filter((_, i) => i !== index),
                      )
                    }
                    aria-label="Remove parameter"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <Input
                  value={param.description}
                  onChange={(e) => setParam(index, { description: e.target.value })}
                  placeholder="What this parameter means, in the agent's words"
                  className="text-xs sm:col-span-4"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Headers</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => set('headers', [...draft.headers, { key: '', value: '' }])}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
        {draft.headers.map((header, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={header.key}
              onChange={(e) => {
                const next = [...draft.headers];
                next[index] = { ...next[index], key: e.target.value };
                set('headers', next);
              }}
              placeholder="Authorization"
              className="font-mono text-xs"
            />
            <Input
              value={header.value}
              onChange={(e) => {
                const next = [...draft.headers];
                next[index] = { ...next[index], value: e.target.value };
                set('headers', next);
              }}
              placeholder="Bearer …"
              type="password"
              className="font-mono text-xs"
              autoComplete="off"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                set('headers', draft.headers.filter((_, i) => i !== index))
              }
              aria-label="Remove header"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Encrypted at rest and never shown again.
          {draft.id && ' Leave blank to keep the headers already saved.'}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save action
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
          Available to the agent
        </label>
      </div>
    </div>
  );
}
