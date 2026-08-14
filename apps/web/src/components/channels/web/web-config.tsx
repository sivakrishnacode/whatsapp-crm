'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  Power,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRefreshChannelStatus } from '@/hooks/use-channel-status';
import { cn } from '@/lib/utils';

/** Mirrors `WebConnectionStatus` on the API. */
interface WebStatus {
  connected: boolean;
  status: 'disconnected' | 'connected' | 'disabled';
  widget_key: string;
  allowed_origins: string[];
  installed_at: string | null;
  last_seen_at: string | null;
  appearance: Record<string, unknown>;
  business_hours: unknown | null;
  ai_enabled: boolean;
  show_branding: boolean;
  locale: string;
  last_error: string | null;
  setup: {
    loader_url: string;
    snippet: string;
  };
}

/**
 * Web channel settings — the domain allowlist, the install snippet, and
 * key rotation.
 *
 * WHY THIS PAGE HAS NO "CONNECT" BUTTON
 *   WhatsApp and Instagram both start with an OAuth handshake, so their
 *   settings pages open on a connect screen. There is no third party to
 *   authorise here: the config row is created the moment this page is
 *   first opened, and the channel becomes *connected* when the API
 *   observes a real widget load from an allowed origin. So the setup
 *   sequence is "add a domain, paste the snippet, wait for the first
 *   load" — and this page's job is to make where you are in that
 *   sequence obvious.
 */
export function WebConfig() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    'origins' | 'rotate-key' | 'rotate-secret' | 'toggle' | null
  >(null);
  const refreshRail = useRefreshChannelStatus();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/web/config', { cache: 'no-store' });
      if (!res.ok) throw new Error('Request failed');
      setStatus(await res.json());
    } catch {
      toast.error('Could not load the web widget settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      const res = await fetch('/api/web/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `Could not ${label}`);
      }
      setStatus(await res.json());
      refreshRail();
    },
    [refreshRail],
  );

  async function saveOrigins(origins: string[]) {
    setBusy('origins');
    try {
      await patch({ allowed_origins: origins }, 'save the domain list');
      toast.success('Domains updated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  async function rotate(which: 'key' | 'secret') {
    const copy =
      which === 'key'
        ? 'Generate a new widget key? The widget will stop loading everywhere until you paste the new snippet on your site.'
        : 'Generate a new signing secret? Every visitor currently chatting will be disconnected. The installed snippet keeps working.';
    if (!window.confirm(copy)) return;

    setBusy(which === 'key' ? 'rotate-key' : 'rotate-secret');
    try {
      const res = await fetch(`/api/web/config/rotate-${which}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Rotation failed');
      setStatus(await res.json());
      refreshRail();
      toast.success(
        which === 'key'
          ? 'New widget key generated. Update the snippet on your site.'
          : 'New signing secret generated.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rotation failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    if (!status) return;
    const disabling = status.status !== 'disabled';
    if (
      disabling &&
      !window.confirm(
        'Turn the widget off? It stops appearing on your site immediately. ' +
          'Your settings and chat history are kept.',
      )
    ) {
      return;
    }

    setBusy('toggle');
    try {
      if (disabling) {
        const res = await fetch('/api/web/config', { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not turn the widget off');
        await load();
        refreshRail();
        toast.success('Web widget turned off.');
      } else {
        await patch({ status: 'connected' }, 'turn the widget on');
        toast.success('Web widget turned on.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading web widget settings…
      </div>
    );
  }

  if (!status) {
    return (
      <Banner tone="error" icon={AlertTriangle} title="Settings unavailable">
        Could not load the web widget settings. Reload the page to try again.
      </Banner>
    );
  }

  return (
    <div className="space-y-6">
      <SetupProgress status={status} />

      {status.last_error && (
        <Banner tone="error" icon={AlertTriangle} title="Last error">
          {status.last_error}
        </Banner>
      )}

      {status.status === 'disabled' && (
        <Banner tone="warning" icon={Power} title="Widget is turned off">
          The widget will not appear on your site. Your domains, appearance and
          chat history are unchanged.
          <div className="mt-3">
            <Button size="sm" onClick={toggleEnabled} disabled={busy === 'toggle'}>
              Turn it back on
            </Button>
          </div>
        </Banner>
      )}

      <OriginList
        origins={status.allowed_origins}
        onSave={saveOrigins}
        busy={busy === 'origins'}
      />

      <InstallSnippet snippet={status.setup.snippet} />

      <KeysCard
        widgetKey={status.widget_key}
        onRotate={rotate}
        busy={busy}
      />

      {status.status !== 'disabled' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleEnabled}
            disabled={busy === 'toggle'}
            className="text-destructive hover:text-destructive"
          >
            <Power className="size-4" />
            Turn widget off
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------

/**
 * Where the account is in the three-step setup.
 *
 * Worth its own component because "connected" here is not a thing the
 * user does — it is a thing we observe. Without a progress display, an
 * account that has pasted the snippet but never had a visitor looks
 * identical to one that has not pasted it at all.
 */
function SetupProgress({ status }: { status: WebStatus }) {
  const hasOrigins = status.allowed_origins.length > 0;
  const seen = status.installed_at !== null;

  const steps = [
    {
      label: 'Add your website domain',
      done: hasOrigins,
      detail: hasOrigins
        ? `${status.allowed_origins.length} domain${status.allowed_origins.length === 1 ? '' : 's'} allowed`
        : 'The widget will not load until at least one domain is allowed.',
    },
    {
      label: 'Paste the snippet on your site',
      done: seen,
      detail: seen
        ? 'Snippet detected.'
        : 'Copy the snippet below into your site’s HTML, before </body>.',
    },
    {
      label: 'First visitor load',
      done: seen,
      detail: seen
        ? status.last_seen_at
          ? `Last seen ${formatWhen(status.last_seen_at)}`
          : 'Seen.'
        : 'We mark the channel live once we see the widget load from an allowed domain.',
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Globe
          className={cn(
            'size-5',
            status.connected ? 'text-[#2D7FF9]' : 'text-muted-foreground',
          )}
        />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {status.connected ? 'Web widget is live' : 'Finish setup'}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.connected
              ? 'Visitors on your website can start a chat.'
              : 'Three steps, and the last one happens on its own.'}
          </p>
        </div>
      </div>

      <ol className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]',
                step.done
                  ? 'border-transparent bg-green-500/15 text-accent-green'
                  : 'border-border text-muted-foreground',
              )}
            >
              {step.done ? <CheckCircle2 className="size-3.5" /> : '•'}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'text-sm',
                  step.done ? 'text-foreground' : 'font-medium text-foreground',
                )}
              >
                {step.label}
              </p>
              <p className="text-xs text-muted-foreground">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The domain allowlist.
 *
 * The copy leans hard on "the widget will not load" because an empty
 * allowlist denies everything — the safe default, but a silent one. A
 * user who pastes the snippet first and sees nothing has no way to guess
 * that this list is why.
 */
function OriginList({
  origins,
  onSave,
  busy,
}: {
  origins: string[];
  onSave: (next: string[]) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');

  async function add() {
    const value = draft.trim();
    if (!value) return;
    if (origins.some((o) => o.replace(/^https?:\/\//, '') === value.replace(/^https?:\/\//, ''))) {
      toast.error('That domain is already allowed.');
      return;
    }
    await onSave([...origins, value]);
    setDraft('');
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-sm font-semibold text-foreground">Allowed domains</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Only these domains may load the widget. Subdomains are not included
        automatically — list each one you serve the widget from.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="example.com"
          disabled={busy}
        />
        <Button onClick={add} disabled={busy || !draft.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Add
        </Button>
      </div>

      {origins.length === 0 ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-accent-amber">
          No domains allowed yet, so the widget will not load anywhere.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {origins.map((origin) => (
            <li
              key={origin}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <code className="truncate text-xs text-foreground">{origin}</code>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onSave(origins.filter((o) => o !== origin))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InstallSnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Install snippet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Paste this into your site’s HTML, just before{' '}
            <code>&lt;/body&gt;</code>. It loads asynchronously and will not
            slow your pages down.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            toast.success('Snippet copied.');
            window.setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <pre className="mt-4 overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed text-foreground">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

/**
 * The two credentials, and what rotating each one breaks.
 *
 * The secret is deliberately not displayed — the API never returns it.
 * Showing a masked placeholder would only invite someone to ask where
 * the reveal button is.
 */
function KeysCard({
  widgetKey,
  onRotate,
  busy,
}: {
  widgetKey: string;
  onRotate: (which: 'key' | 'secret') => void;
  busy: 'origins' | 'rotate-key' | 'rotate-secret' | 'toggle' | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">Keys</p>
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <p className="text-xs font-medium text-foreground">Widget key</p>
          <p className="text-xs text-muted-foreground">
            Public — it appears in your page source. It identifies your account
            and grants nothing on its own.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 text-xs">
              {widgetKey}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(widgetKey);
                toast.success('Widget key copied.');
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-muted-foreground hover:text-destructive"
            onClick={() => onRotate('key')}
            disabled={busy === 'rotate-key'}
          >
            {busy === 'rotate-key' && <Loader2 className="size-4 animate-spin" />}
            Generate a new key
          </Button>
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-xs font-medium text-foreground">Signing secret</p>
          <p className="text-xs text-muted-foreground">
            Never leaves our servers. Signs visitor sessions and verifies
            logged-in visitors. Rotating it disconnects anyone currently
            chatting; the installed snippet keeps working.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-muted-foreground hover:text-destructive"
            onClick={() => onRotate('secret')}
            disabled={busy === 'rotate-secret'}
          >
            {busy === 'rotate-secret' && (
              <Loader2 className="size-4 animate-spin" />
            )}
            Generate a new secret
          </Button>
        </div>
      </div>
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: 'error' | 'warning';
  icon: typeof AlertTriangle;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 text-sm',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive-surface text-destructive'
          : 'border-amber-500/30 bg-amber-500/5 text-accent-amber',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <div className="mt-1 text-foreground/80">{children}</div>
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'recently'
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}
