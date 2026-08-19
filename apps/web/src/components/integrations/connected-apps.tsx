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
 * SETUP IS A FOUR-STEP WIZARD, IN THIS DIALOG
 *   Generate the script → paste it into Apps Script → authorize and
 *   deploy → paste the /exec URL back and test. Two of those four happen
 *   inside Google, which is why the flow is a stepper rather than a form:
 *   see GoogleBridgeDialog. The API is the authority on every step; this
 *   component only talks to `/api/google-script/*`.
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
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
import { AppIcon } from './app-icon';
import {
  googleConnectionFromSummary,
  type GoogleScriptConnection,
  type GoogleScriptSummary,
} from '@/lib/automations/connectors';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';

const GOOGLE_HUE = 'oklch(0.45 0.12 145)';

/**
 * The Google mark, in the shape `AppIcon` takes.
 *
 * Through AppIcon rather than a bare <img> so this inherits the 404 →
 * monogram fallback: the file is referenced by path, and a rename that
 * silently 404s should degrade to a tinted "G" rather than a broken-image
 * glyph in the middle of a setup wizard.
 *
 * ONE ICON, NOT FOUR. The old connector had a card each for Gmail,
 * Calendar, Meet and Sheets and a product logo for each; those PNGs are
 * still in /public and are now unused here on purpose — one deployment
 * serves all four, so four logos would advertise four things to connect.
 */
const GOOGLE_APP = {
  name: 'Google',
  icon: '/icons/google.png',
  monogram: 'G',
  hue: GOOGLE_HUE,
};

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
      ? connection?.updateAvailable
        ? 'Update available'
        : 'Connected'
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
          icon={<AppIcon app={GOOGLE_APP} size={36} />}
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
/**
 * Setup, as a left-to-right stepper.
 *
 * ONE STEP ON SCREEN AT A TIME, AND THAT IS THE POINT.
 *   The first version stacked all three steps in a scrolling column, so
 *   the reader met the whole procedure at once — a wall containing a
 *   credential, a JSON manifest, a deploy dialog's settings and a URL
 *   field, with no signal about where they were in it. Setup here spans
 *   TWO applications: half of it happens in script.google.com, and a
 *   person who loses their place has to guess whether they already ran
 *   `authorizeOnce`. A rail across the top answers "where am I" before
 *   the content answers "what now".
 *
 * FOUR STEPS, NOT THREE, BECAUSE THE MIDDLE ONE WAS TWO JOBS
 *   Pasting the script and configuring the manifest happen in the editor;
 *   authorizing and deploying happen in a different dialog with two
 *   settings that must be exactly right. Splitting them means each panel
 *   is one screen of one application.
 *
 * NAVIGATION IS FREE, NOT GATED
 *   We cannot observe what somebody did in Google — whether they enabled
 *   the Calendar service, whether they clicked Deploy. Only steps 1 and 4
 *   have server-side truth. So the rail lets you move anywhere and marks
 *   done only what the API actually confirms; a wizard that refused to
 *   advance on a check it cannot perform would strand people who had in
 *   fact done the work.
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
  /** Which block was copied last, so two Copy buttons don't both tick. */
  const [copied, setCopied] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const status = connection?.status ?? 'not_configured';
  const currentlyConnected = status === 'connected';

  /**
   * Open where the work actually is: a connected workspace came here to
   * re-test or disconnect, not to read step one again.
   */
  useEffect(() => {
    if (open) setStep(currentlyConnected ? 3 : 0);
    // Only when the dialog opens — re-running on every status change would
    // yank the panel out from under someone mid-setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    setScript(null);
    setManifest('');
    setUrl('');
    setTestResult(null);
    setCopied(null);
    setBusy(null);
    setStep(0);
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
      toast.success('Script generated — copy it before you leave this step');
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
      toast.success('Deployment URL saved — now test it');
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

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error('Copy failed — select the text and copy manually.');
    }
  };

  /**
   * `done` is only ever set from something the server confirmed. Steps 2
   * and 3 happen inside Google, where we have no visibility, so they never
   * show a tick — claiming otherwise would be a guess presented as a fact.
   */
  /**
   * `external` marks the steps that happen in Google rather than here, and
   * the rail badges them with the Google mark. The words already say "In
   * Apps Script"; the logo makes the two-application split legible at a
   * glance, which is the rail's entire justification — somebody who looks
   * up mid-setup should see which window they were supposed to be in.
   */
  const steps = [
    { title: 'Get the script', hint: 'In Converse360', done: Boolean(script) },
    { title: 'Paste it in', hint: 'In Apps Script', external: true, done: false },
    {
      title: 'Authorize & deploy',
      hint: 'In Apps Script',
      external: true,
      done: false,
    },
    {
      title: 'Connect & test',
      hint: 'Back in Converse360',
      done: currentlyConnected && Boolean(connection?.lastTestedAt),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : close())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppIcon app={GOOGLE_APP} size={22} />
            Connect Google
          </DialogTitle>
          <DialogDescription>
            One deployment in your own Google account serves Gmail, Calendar,
            Meet and Sheets. Takes about five minutes.
          </DialogDescription>
        </DialogHeader>

        {/* ---- The rail ------------------------------------------- */}
        <StepRail steps={steps} current={step} onPick={setStep} />

        {/* ---- Standing status ------------------------------------ */}
        {currentlyConnected && (
          <div className="text-accent-green flex items-start gap-2 rounded-lg border border-green-500/25 bg-green-500/10 p-2.5 text-[11px]">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Connected.{' '}
              {connection?.lastTestedAt
                ? `Last confirmed working ${formatWhen(connection.lastTestedAt)}.`
                : 'Not tested yet — run the test on step 4.'}
            </span>
          </div>
        )}
        {status === 'error' && (
          <div className="text-accent-red flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-2.5 text-[11px]">
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {/*
                The timestamp is load-bearing. Without it a failure from
                hours ago reads as something that just happened, and a
                stale message at the top of a setup wizard sends people
                hunting for a problem they already fixed.
              */}
              <strong className="font-semibold">Last attempt failed</strong>
              {connection?.lastErrorAt
                ? ` ${formatWhen(connection.lastErrorAt)}`
                : ''}
              : {connection?.lastError ?? 'the call to the bridge did not work.'}
            </span>
          </div>
        )}

        {connection?.updateAvailable && status !== 'error' && (
          <div className="text-accent-amber flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {/*
                An OFFER, not a warning: everything already built keeps
                working, and only actions added since their script was
                generated are missing. It sits below the error banner
                because "a call is failing" is always more urgent, and it
                names the cost up front — regenerating mints a new secret,
                so this is a re-paste and a redeploy, not a click.
              */}
              <strong className="font-semibold">
                A newer script is available
              </strong>{' '}
              (yours is v{connection.scriptVersion}, current is v
              {connection.currentVersion}). New Google actions won&apos;t work
              until you regenerate on step 1 and redeploy. Everything you have
              already built keeps working either way.
            </span>
          </div>
        )}

        <div className="min-h-[290px]">
          {/* ================= STEP 1 — get the script ============== */}
          {step === 0 && (
            <Panel
              title="Get your deploy-ready script"
              lead="Converse360 writes the script for you and puts a fresh random secret inside it. That secret is how your Google account knows a request really came from us."
            >
              {!script ? (
                <>
                  <GatedButton
                    canAct={canEdit}
                    gateReason="generate the Google script"
                    disabled={busy !== null}
                    onClick={() => void provision()}
                    className="h-9 gap-1.5 text-xs"
                  >
                    {busy === 'provision' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Zap className="size-3.5" />
                    )}
                    {busy === 'provision'
                      ? 'Generating…'
                      : currentlyConnected
                        ? 'Generate a new script'
                        : 'Generate my script'}
                  </GatedButton>
                  {currentlyConnected && (
                    <Note tone="warn">
                      You are already connected. Generating again mints a{' '}
                      <strong>new secret</strong>, which stops the script you
                      have already deployed from working until you paste and
                      redeploy the new one.
                    </Note>
                  )}
                </>
              ) : (
                <>
                  <CodeBlock
                    value={script}
                    rows={11}
                    onCopy={() => void copy(script, 'script')}
                    copied={copied === 'script'}
                  />
                  <Note tone="warn">
                    This file is a credential for your Google account — anyone
                    with it and your deployment URL can send mail as you. Don&apos;t
                    paste it into a shared doc or a screenshot. It is shown
                    once; we store only an encrypted copy.
                  </Note>
                </>
              )}
            </Panel>
          )}

          {/* ================= STEP 2 — paste it in ================= */}
          {step === 1 && (
            <Panel
              title="Paste it into Apps Script"
              lead="Everything on this step happens in Google, in a new tab."
            >
              <ol className="text-muted-foreground list-decimal space-y-2 pl-4 text-[11.5px] leading-relaxed">
                <li>
                  Open{' '}
                  <a
                    href="https://script.google.com/home/projects/create"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary inline-flex items-center gap-0.5 underline underline-offset-2"
                  >
                    script.google.com <ExternalLink className="size-2.5" />
                  </a>{' '}
                  and start a <strong>New project</strong>.
                </li>
                <li>
                  Select everything in <code className="font-mono">Code.gs</code>{' '}
                  and paste your script over it. Save with{' '}
                  <kbd className="border-border bg-muted rounded border px-1">
                    Ctrl
                  </kbd>
                  +
                  <kbd className="border-border bg-muted rounded border px-1">
                    S
                  </kbd>
                  .
                </li>
                <li>
                  In the left sidebar, next to <strong>Services</strong>, click{' '}
                  <strong>+</strong> and add <strong>Calendar API</strong>.
                  <Note tone="warn">
                    Not optional. Without it every calendar call fails with
                    &ldquo;Calendar is not defined&rdquo;, and the built-in
                    CalendarApp cannot attach a Meet link.
                  </Note>
                </li>
                <li>
                  Open <strong>Project Settings</strong> (the gear), tick{' '}
                  <strong>Show &ldquo;appsscript.json&rdquo;</strong>, then
                  replace that file with this:
                </li>
              </ol>
              <CodeBlock
                value={manifest || '(generate the script on step 1 first)'}
                rows={8}
                onCopy={() => manifest && void copy(manifest, 'manifest')}
                copied={copied === 'manifest'}
              />
              <p className="text-muted-foreground text-[10.5px] leading-relaxed">
                These are the exact permissions the bridge needs and nothing
                more: send-only Gmail, calendar events and free/busy, and
                spreadsheets. No Drive access, and nothing that can read your
                mail.
              </p>
            </Panel>
          )}

          {/* ================= STEP 3 — authorize & deploy ========== */}
          {step === 2 && (
            <Panel
              title="Authorize it, then deploy"
              lead="Still in Apps Script. Two settings on the deploy dialog have to be exactly right, and they are the most common thing to get wrong."
            >
              <ol className="text-muted-foreground list-decimal space-y-2 pl-4 text-[11.5px] leading-relaxed">
                <li>
                  Pick <code className="font-mono">authorizeOnce</code> in the
                  function dropdown and press <strong>Run</strong>. Approve the
                  prompt.
                  <Note>
                    Google will warn that the app isn&apos;t verified. This is
                    your own script in your own account —{' '}
                    <strong>Advanced → Go to…</strong> is the right answer, and
                    it only appears once.
                  </Note>
                </li>
                <li>
                  <strong>Deploy → New deployment</strong>, choose type{' '}
                  <strong>Web app</strong>, and set:
                </li>
              </ol>
              <div className="border-border overflow-hidden rounded-lg border text-[11.5px]">
                <div className="border-border flex items-center gap-3 border-b px-3 py-2">
                  <span className="text-muted-foreground w-32 shrink-0">
                    Execute as
                  </span>
                  <strong className="text-foreground">Me</strong>
                  <span className="text-muted-foreground ml-auto text-[10.5px]">
                    so it acts on your mailbox and calendar
                  </span>
                </div>
                <div className="flex items-center gap-3 px-3 py-2">
                  <span className="text-muted-foreground w-32 shrink-0">
                    Who has access
                  </span>
                  <strong className="text-foreground">Anyone</strong>
                  <span className="text-muted-foreground ml-auto text-[10.5px]">
                    our server has no Google login
                  </span>
                </div>
              </div>
              <Note tone="warn">
                &ldquo;Anyone with a Google account&rdquo; is a different
                setting and will not work — it returns a login page to
                Converse360 instead of a result. Your secret is what protects
                the URL.
              </Note>
              <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                Press <strong>Deploy</strong>, then copy the{' '}
                <strong>Web app URL</strong> — it ends in{' '}
                <code className="font-mono">/exec</code>.
              </p>
            </Panel>
          )}

          {/* ================= STEP 4 — connect & test ============== */}
          {step === 3 && (
            <Panel
              title="Paste the URL back, and test"
              lead="Back in Converse360. The test runs the one action that changes nothing — your free/busy for the next 24 hours."
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
                  disabled={busy !== null || url.trim() === ''}
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
                <p className="text-muted-foreground text-[10.5px]">
                  A deployment is already saved
                  {connection?.displayName
                    ? ` (…${connection.displayName})`
                    : ''}
                  . Paste a new URL only if you created a new deployment rather
                  than a new version of the old one.
                </p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <GatedButton
                  canAct={canEdit}
                  gateReason="test the bridge"
                  disabled={busy !== null || status === 'not_configured'}
                  onClick={() => void test()}
                  className="h-9 gap-1.5 text-xs"
                >
                  {busy === 'test' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3.5" />
                  )}
                  Test connection
                </GatedButton>
              </div>

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

              {status !== 'not_configured' && (
                <div className="border-border mt-1 flex items-center justify-between gap-3 rounded-lg border border-dashed p-2.5">
                  <p className="text-muted-foreground text-[10.5px] leading-snug">
                    Disconnecting revokes access from Converse360 only — the
                    script keeps running in Google with its secret. To revoke
                    fully, delete the deployment in Apps Script.
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
            </Panel>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <GatedButton
            canAct
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            variant="ghost"
            size="sm"
            className="gap-1 text-xs"
          >
            <ChevronLeft className="size-3.5" /> Back
          </GatedButton>
          <div className="flex items-center gap-2">
            <GatedButton
              canAct
              onClick={close}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              Close
            </GatedButton>
            {step < 3 && (
              <GatedButton
                canAct
                onClick={() => setStep((s) => Math.min(3, s + 1))}
                size="sm"
                className="gap-1 text-xs"
              >
                Next <ChevronRight className="size-3.5" />
              </GatedButton>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The horizontal rail.
 *
 * Every step is clickable: see the navigation note on the dialog — we
 * cannot verify the two middle steps, so refusing to move would strand
 * anyone who had already done them. The connector line is drawn behind
 * the circles rather than between them, so it does not reflow when a
 * label wraps.
 */
function StepRail({
  steps,
  current,
  onPick,
}: {
  steps: {
    title: string;
    hint: string;
    done: boolean;
    external?: boolean;
  }[];
  current: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="flex items-start gap-1">
      {steps.map((s, i) => {
        const active = i === current;
        return (
          <button
            key={s.title}
            type="button"
            onClick={() => onPick(i)}
            className="group flex flex-1 flex-col items-start gap-1.5 text-left"
          >
            <div className="flex w-full items-center gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : s.done
                      ? 'text-accent-green bg-green-500/15'
                      : 'text-muted-foreground bg-muted/70 group-hover:bg-muted'
                )}
              >
                {s.done && !active ? <Check className="size-3" /> : i + 1}
              </span>
              {i < steps.length - 1 && (
                <span
                  className={cn(
                    'h-px flex-1 transition-colors',
                    i < current ? 'bg-primary/40' : 'bg-border'
                  )}
                />
              )}
            </div>
            <div className="pr-2">
              <p
                className={cn(
                  'text-[11.5px] font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {s.title}
              </p>
              <p className="text-muted-foreground/70 flex items-center gap-1 text-[10px]">
                {s.external && <AppIcon app={GOOGLE_APP} size={11} />}
                {s.hint}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** One step's body: a heading, a sentence of why, then the doing. */
function Panel({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-foreground text-[13px] font-semibold">{title}</h3>
        <p className="text-muted-foreground mt-0.5 text-[11.5px] leading-relaxed">
          {lead}
        </p>
      </div>
      {children}
    </div>
  );
}

/** Read-only code with a copy button that confirms itself. */
function CodeBlock({
  value,
  rows,
  onCopy,
  copied,
}: {
  value: string;
  rows: number;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="relative">
      <Textarea
        readOnly
        value={value}
        spellCheck={false}
        rows={rows}
        className="font-mono text-[11px] leading-snug"
      />
      <button
        type="button"
        onClick={onCopy}
        className="text-muted-foreground hover:text-foreground bg-background/90 border-border absolute top-2 right-2 flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors"
      >
        {copied ? (
          <CheckCircle2 className="size-3" />
        ) : (
          <ClipboardCopy className="size-3" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** An aside inside a step. `warn` for the things that cost an hour. */
function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'mt-1.5 flex items-start gap-2 rounded-lg border p-2.5 text-[11px] leading-relaxed',
        tone === 'warn'
          ? 'text-accent-amber border-amber-500/25 bg-amber-500/10'
          : 'text-muted-foreground border-border bg-muted/40'
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
