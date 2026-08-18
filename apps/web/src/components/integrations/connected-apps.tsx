'use client';

/**
 * The Google integration on the Integrations page — one card, one setup.
 *
 * ONE CARD, NOT FOUR. Gmail, Calendar, Meet and Sheets all arrive
 * through a single Apps Script deployment the workspace's admin pastes
 * into script.google.com, so there is exactly one connected/not state and
 * one card. The predecessor was four cards over one `app_connections`
 * row, each asking a "scope granted?" question that incremental consent
 * made necessary; the bridge grants nothing incrementally, and this
 * section shrank to what its subject actually is.
 *
 * SETUP IS THREE STEPS, IN THIS DIALOG
 *   1. Generate the deploy-ready script (it already contains a fresh,
 *      random secret). 2. Deploy it as a Web app and paste the /exec URL
 *      back. 3. Test — the one thing the bridge does NOT change anything
 *      to prove. The API is the authority on every step; this component
 *      only talks to `/api/google-script/*`.
 *
 * ADMIN-GATED. The script can send mail as the workspace's Google
 * account, so generating or re-testing it is owner/admin work — the same
 * gate the API enforces with `@RequireRole('admin')`.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { GatedButton } from '@/components/ui/gated-button';
import {
  IntegrationCard,
  IntegrationGrid,
  IntegrationRow,
} from './integration-card';
import {
  googleConnectionFromSummary,
  type GoogleScriptConnection,
  type GoogleScriptSummary,
} from '@/lib/automations/connectors';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';

const GOOGLE_HUE = 'oklch(0.45 0.12 145)';

export function ConnectedApps() {
  const canEdit = useCan('edit-settings');
  const [connection, setConnection] = useState<GoogleScriptConnection | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/google-script', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { connection?: GoogleScriptSummary };
      setConnection(googleConnectionFromSummary(json.connection));
    } catch {
      // Leaves the section empty rather than breaking the whole page —
      // Shopify and Zapier below do not depend on this.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const status = connection?.status ?? 'not_configured';
  const cardStatus =
    status === 'connected'
      ? 'connected'
      : status === 'error'
        ? 'attention'
        : 'off';
  const statusLabel =
    status === 'connected'
      ? 'Connected'
      : status === 'error'
        ? 'Needs attention'
        : status === 'provisioned'
          ? 'Finish setup'
          : 'Not set up';

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-foreground text-sm font-semibold">Google</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          One setup for Gmail, Calendar, Meet and Sheets — the bridge runs in
          your own Google account, so nothing is pasted twice.
        </p>
      </div>

      <IntegrationGrid>
        <IntegrationCard
          icon={
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: GOOGLE_HUE }}
            >
              <Zap className="size-4 text-white" />
            </span>
          }
          name="Google Apps Script bridge"
          blurb="Send mail, create calendar events and append sheet rows from automations."
          status={cardStatus}
          statusLabel={statusLabel}
          footer={
            <button
              type="button"
              disabled={!canEdit}
              title={
                canEdit
                  ? undefined
                  : "Read-only — your role can't set up Google"
              }
              onClick={() => setSetupOpen(true)}
              className={cn(
                status === 'connected'
                  ? 'text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] transition-colors'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors',
                !canEdit && 'disabled:opacity-50'
              )}
            >
              {status === 'connected' ? 'Manage bridge' : 'Set up Google'}
            </button>
          }
        >
          {status === 'provisioned' && (
            <IntegrationRow
              label="Step 1 done — script generated"
              sublabel="Paste your deployment URL below to finish."
            />
          )}
          {(status === 'connected' || status === 'error') && (
            <IntegrationRow
              label={connection?.displayName ?? 'Deployed'}
              tone={status === 'error' ? 'attention' : 'default'}
              sublabel={
                status === 'error'
                  ? (connection?.lastError ?? 'Connection is failing.')
                  : connection?.lastTestedAt
                    ? `Last confirmed ${formatWhen(connection.lastTestedAt)}`
                    : 'Configured — not tested yet'
              }
            />
          )}
        </IntegrationCard>
      </IntegrationGrid>

      <GoogleBridgeDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        connection={connection}
        canEdit={canEdit}
        onChanged={() => void load()}
      />
    </section>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'recently';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The three-step setup dialog.
 *
 * Steps mirror the API surface 1:1: provision → url → test. An already
 * connected bridge skips straight to status, re-test and disconnect; the
 * one silent re-run trap is regenerating the script, which mints a NEW
 * secret and orphans whatever is deployed — warned here, as the API docs
 * demand.
 */
function GoogleBridgeDialog({
  open,
  onOpenChange,
  connection,
  canEdit,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: GoogleScriptConnection | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [script, setScript] = useState<string | null>(null);
  const [manifest, setManifest] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<
    'provision' | 'url' | 'test' | 'delete' | null
  >(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    detail: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const status = connection?.status ?? 'not_configured';
  const currentlyConnected = status === 'connected';

  const close = () => {
    setScript(null);
    setManifest('');
    setUrl('');
    setTestResult(null);
    setCopied(false);
    setBusy(null);
    onOpenChange(false);
  };

  const errorOf = (res: Response, data: { message?: string } | null): string =>
    data?.message ??
    (res.status === 401 || res.status === 403
      ? 'You need owner or admin to change the Google setup.'
      : 'Something went wrong — try again.');

  const provision = async () => {
    setBusy('provision');
    setTestResult(null);
    try {
      const res = await fetch('/api/google-script/provision', {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as {
        script?: string;
        manifest?: unknown;
        message?: string;
      } | null;
      if (!res.ok) throw new Error(errorOf(res, data));
      setScript(data?.script ?? null);
      setManifest(
        typeof data?.manifest === 'string'
          ? data.manifest
          : data?.manifest
            ? JSON.stringify(data.manifest, null, 2)
            : ''
      );
      toast.success('Script generated — paste it into Apps Script');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveUrl = async () => {
    setBusy('url');
    try {
      const res = await fetch('/api/google-script/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exec_url: url.trim() }),
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (!res.ok) throw new Error(errorOf(res, data));
      toast.success('Deployment URL saved');
      setUrl('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const res = await fetch('/api/google-script/test', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        detail?: string;
        message?: string;
      } | null;
      if (!res.ok) throw new Error(data?.message ?? 'Test failed');
      setTestResult({ ok: Boolean(data?.ok), detail: data?.detail ?? '' });
      if (data?.ok) toast.success('Bridge works');
      onChanged();
    } catch (err) {
      setTestResult({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (
      !confirm(
        'Disconnect the Google bridge? The deployed script keeps running in Google with its secret — ' +
          'this only revokes access from Converse360. To revoke fully, delete the deployment in Apps Script.'
      )
    ) {
      return;
    }
    setBusy('delete');
    try {
      const res = await fetch('/api/google-script', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not disconnect');
      toast.success('Disconnected');
      onChanged();
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the text and copy manually.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-md"
              style={{ background: GOOGLE_HUE }}
            >
              <Zap className="size-3.5 text-white" />
            </span>
            Google Apps Script bridge
          </DialogTitle>
          <DialogDescription>
            One deployment in your own Google account serves Gmail, Calendar,
            Meet and Sheets.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          {/* ---- Status ------------------------------------------ */}
          {currentlyConnected && (
            <div className="text-accent-green flex items-start gap-2 rounded-lg border border-green-500/25 bg-green-500/10 p-2.5 text-[11px]">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
              <span>
                One deployment working.{' '}
                {connection?.lastTestedAt
                  ? `Last confirmed ${formatWhen(connection.lastTestedAt)}.`
                  : 'Configured and ready.'}
              </span>
            </div>
          )}
          {status === 'error' && (
            <div className="text-accent-red flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-2.5 text-[11px]">
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {connection?.lastError ?? 'The last call to the bridge failed.'}
              </span>
            </div>
          )}

          {/* ---- Step 1: script ----------------------------------- */}
          <Step number={1} title="Get your deploy-ready script">
            <p className="text-muted-foreground text-xs">
              {script
                ? 'Paste this into script.google.com and copy it in full — the secret is only ever shown once.'
                : 'Converse360 mints a fresh, random secret and hands you the script with it already inside.'}
            </p>
            {!script ? (
              <GatedButton
                canAct={canEdit}
                gateReason="generate the Google script"
                disabled={busy !== null}
                onClick={() => void provision()}
                className="mt-2 h-8 gap-1.5 text-xs"
              >
                {busy === 'provision' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {busy === 'provision' ? 'Generating…' : 'Generate script'}
              </GatedButton>
            ) : (
              <>
                <div className="relative">
                  <Textarea
                    readOnly
                    value={script}
                    spellCheck={false}
                    rows={10}
                    className="font-mono text-[11px] leading-snug"
                  />
                  <button
                    type="button"
                    onClick={() => void copy(script)}
                    className="text-muted-foreground hover:text-foreground bg-background/90 absolute top-2 right-2 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors"
                  >
                    {copied ? (
                      <CheckCircle2 className="size-3" />
                    ) : (
                      <ClipboardCopy className="size-3" />
                    )}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="text-accent-amber flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    This file is a credential for your Google account. Never
                    share it. Generating again mints a NEW secret and orphans
                    any already-deployed script.
                  </span>
                </div>
                <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-[11px]">
                  <li>
                    Open{' '}
                    <a
                      href="https://script.google.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary inline-flex items-center gap-0.5 underline underline-offset-2"
                    >
                      script.google.com <ExternalLink className="size-2.5" />
                    </a>{' '}
                    → New project, and paste the code above over the
                    placeholder.
                  </li>
                  <li>
                    In Project Settings, show &lsquo;appsscript.json&rsquo; and
                    make it match (the scopes and web app settings this bridge
                    needs):
                  </li>
                </ol>
                <pre className="bg-muted/60 text-muted-foreground border-border max-h-40 overflow-auto rounded-lg border p-2.5 font-mono text-[10px] leading-snug">
                  {manifest}
                </pre>
                <ol
                  className="text-muted-foreground list-decimal space-y-1 pl-4 text-[11px]"
                  start={3}
                >
                  <li>
                    Run <code className="font-mono">authorizeOnce</code> in the
                    editor and approve the prompt.
                  </li>
                  <li>
                    Deploy → New deployment → <strong>Web app</strong>. Execute
                    as: <strong>Me</strong> &middot; Who has access:{' '}
                    <strong>Anyone</strong> (anything else returns a login page
                    to Converse360).
                  </li>
                  <li>
                    Copy the <code className="font-mono">/exec</code> URL into
                    Step 2 below.
                  </li>
                </ol>
              </>
            )}
          </Step>

          {/* ---- Step 2: exec URL --------------------------------- */}
          <Step
            number={2}
            title="Deploy and save your /exec URL"
            done={currentlyConnected}
          >
            <div className="flex items-center gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://script.google.com/macros/s/…/exec"
                spellCheck={false}
                className="h-9 flex-1 font-mono text-xs"
              />
              <GatedButton
                canAct={canEdit}
                gateReason="save the deployment URL"
                disabled={busy !== null || currentlyConnected}
                onClick={() => void saveUrl()}
                variant="outline"
                className="h-9 shrink-0 text-xs"
              >
                {busy === 'url' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  'Save URL'
                )}
              </GatedButton>
            </div>
            {currentlyConnected && (
              <p className="text-muted-foreground mt-1 text-[10.5px]">
                Deployment already saved
                {connection?.displayName ? ` (${connection.displayName})` : ''}.
                Regenerate only to rotate the secret.
              </p>
            )}
          </Step>

          {/* ---- Step 3: test -------------------------------------- */}
          <Step number={3} title="Test that it works">
            <div className="flex items-center gap-2">
              <GatedButton
                canAct={canEdit}
                gateReason="test the bridge"
                disabled={
                  busy !== null || (!currentlyConnected && status !== 'error')
                }
                onClick={() => void test()}
                variant="outline"
                className="h-8 gap-1.5 text-xs"
              >
                {busy === 'test' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                Test connection
              </GatedButton>
            </div>
            <p className="text-muted-foreground mt-1.5 text-[10.5px]">
              Runs the one bridge action that changes nothing — free/busy over
              the next 24 hours.
            </p>
            {testResult && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border p-2.5 text-[11px]',
                  testResult.ok
                    ? 'text-accent-green border-green-500/25 bg-green-500/10'
                    : 'text-accent-red border-red-500/25 bg-red-500/10'
                )}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span>
                  {testResult.detail ||
                    (testResult.ok ? 'Bridge works.' : 'Test failed.')}
                </span>
              </div>
            )}
          </Step>

          {/* ---- Danger zone --------------------------------------- */}
          {status !== 'not_configured' && (
            <div className="border-border flex items-center justify-between gap-3 rounded-lg border border-dashed p-2.5">
              <p className="text-muted-foreground text-[10.5px] leading-snug">
                Revokes access from Converse360 only — the script in Google
                keeps its secret.
              </p>
              <GatedButton
                canAct={canEdit}
                gateReason="disconnect Google"
                disabled={busy !== null}
                onClick={() => void disconnect()}
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 h-8 shrink-0 gap-1.5 text-xs"
              >
                {busy === 'delete' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Disconnect
              </GatedButton>
            </div>
          )}
        </div>

        <DialogFooter>
          <GatedButton
            canAct={canEdit}
            gateReason="do more Google setup"
            onClick={close}
            variant="outline"
            size="sm"
            className="text-xs"
          >
            Close
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One numbered row of the setup flow. */
function Step({
  number,
  title,
  children,
  done,
}: {
  number: number;
  title: string;
  children: ReactNode;
  done?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
            done
              ? 'text-accent-green bg-green-500/15'
              : 'text-muted-foreground border-border bg-muted/60'
          )}
        >
          {done ? <CheckCircle2 className="size-3" /> : number}
        </span>
        <h3 className="text-foreground text-[12.5px] font-semibold">{title}</h3>
      </div>
      <div className="pl-7">{children}</div>
    </div>
  );
}
