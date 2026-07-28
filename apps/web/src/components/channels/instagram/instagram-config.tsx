'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { InstagramIcon } from '@/components/channels/channel-icons';
import { useRefreshChannelStatus } from '@/hooks/use-channel-status';
import { cn } from '@/lib/utils';

/** Mirrors InstagramConnectionStatus on the API. */
interface InstagramStatus {
  connected: boolean;
  status: 'disconnected' | 'connected' | 'token_expired' | 'error';
  ig_user_id: string | null;
  ig_username: string | null;
  profile_picture_url: string | null;
  connected_at: string | null;
  token_expires_at: string | null;
  token_expires_in_days: number | null;
  subscribed_fields: string[];
  last_error: string | null;
  human_agent_enabled: boolean;
  setup: {
    redirect_uri: string | null;
    webhook_url: string | null;
    app_id: string | null;
  };
}

/**
 * Fields the API subscribes at connect time. Listed here so the UI can
 * show which ones are actually active rather than just "subscribed" —
 * a partial subscription is the difference between DMs working and
 * comments silently not.
 */
const EXPECTED_FIELDS = [
  { id: 'messages', label: 'Direct messages' },
  { id: 'messaging_postbacks', label: 'Button & ice-breaker taps' },
  { id: 'messaging_seen', label: 'Read receipts' },
  { id: 'message_reactions', label: 'Reactions' },
  { id: 'messaging_referral', label: 'ig.me link attribution' },
  { id: 'comments', label: 'Comments' },
  { id: 'live_comments', label: 'Live comments' },
  { id: 'mentions', label: 'Mentions' },
];

export function InstagramConfig() {
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'resubscribe' | 'disconnect' | null>(
    null,
  );
  const refreshRail = useRefreshChannelStatus();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/instagram/config', { cache: 'no-store' });
      setStatus(await res.json());
    } catch {
      toast.error('Could not load the Instagram connection status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback bounces back here with a result in the query
  // string. Surface it as a toast and strip the params so a refresh
  // doesn't replay the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('ig_error');
    const connected = params.get('ig_connected');
    if (!error && !connected) return;

    if (error) toast.error(error);
    if (connected) {
      const username = params.get('ig_username');
      toast.success(
        username ? `Connected @${username}` : 'Instagram connected',
      );
      void load();
      refreshRail();
    }

    window.history.replaceState({}, '', window.location.pathname);
  }, [load, refreshRail]);

  async function connect() {
    setBusy('connect');
    try {
      const res = await fetch('/api/instagram/connect/start');
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? 'Could not start the connection');
      }
      // Full navigation, not a popup: Instagram's consent dialog blocks
      // being framed, and a popup gets eaten by blockers on the first
      // click of a session.
      window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not connect');
      setBusy(null);
    }
  }

  async function resubscribe() {
    setBusy('resubscribe');
    try {
      const res = await fetch('/api/instagram/config/resubscribe', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Resubscribe failed');
      toast.success('Webhook subscription refreshed.');
      await load();
      refreshRail();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resubscribe failed');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        'Disconnect Instagram? Existing conversations are kept, but no new ' +
          'messages will arrive until you reconnect.',
      )
    ) {
      return;
    }
    setBusy('disconnect');
    try {
      const res = await fetch('/api/instagram/config', { method: 'DELETE' });
      if (!res.ok) throw new Error('Disconnect failed');
      toast.success('Instagram disconnected.');
      await load();
      refreshRail();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading Instagram settings…
      </div>
    );
  }

  if (!status?.ig_user_id) {
    return (
      <NotConnected
        onConnect={connect}
        busy={busy === 'connect'}
        setup={status?.setup}
      />
    );
  }

  const missingFields = EXPECTED_FIELDS.filter(
    (f) => !status.subscribed_fields.includes(f.id),
  );

  return (
    <div className="space-y-6">
      <AccountCard status={status} />

      {status.status === 'token_expired' && (
        <Banner tone="error" icon={AlertTriangle} title="Access expired">
          Instagram access has expired or was revoked. Reconnect the account to
          resume receiving messages.
          <div className="mt-3">
            <Button size="sm" onClick={connect} disabled={busy === 'connect'}>
              Reconnect
            </Button>
          </div>
        </Banner>
      )}

      {status.last_error && status.status !== 'token_expired' && (
        <Banner tone="error" icon={AlertTriangle} title="Last error">
          {status.last_error}
        </Banner>
      )}

      {/* The single most important thing on this page. An account with
          no webhook subscription looks perfectly healthy and receives
          nothing at all — there is no other symptom. */}
      {missingFields.length > 0 && (
        <Banner
          tone="warning"
          icon={AlertTriangle}
          title="Some events are not subscribed"
        >
          Instagram will not notify us about:{' '}
          {missingFields.map((f) => f.label).join(', ')}. Until this is fixed
          those events silently never arrive.
          <div className="mt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={resubscribe}
              disabled={busy === 'resubscribe'}
            >
              {busy === 'resubscribe' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Re-subscribe
            </Button>
          </div>
        </Banner>
      )}

      <SubscribedEvents subscribed={status.subscribed_fields} />
      <MessagingWindowCard humanAgentEnabled={status.human_agent_enabled} />

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={resubscribe}
          disabled={busy === 'resubscribe'}
        >
          <RefreshCw className="size-4" />
          Refresh subscription
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={disconnect}
          disabled={busy === 'disconnect'}
          className="text-destructive hover:text-destructive"
        >
          <Unplug className="size-4" />
          Disconnect
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------

function NotConnected({
  onConnect,
  busy,
  setup,
}: {
  onConnect: () => void;
  busy: boolean;
  setup?: InstagramStatus['setup'];
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <InstagramIcon className="mx-auto size-10" />
      <h2 className="mt-4 text-lg font-semibold text-foreground">
        Connect Instagram
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Answer Instagram DMs and comments from the shared inbox, with the same
        automations, flows and AI assistant you already use for WhatsApp.
      </p>

      <Button className="mt-5" onClick={onConnect} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        Connect Instagram
      </Button>

      <div className="mx-auto mt-6 max-w-md space-y-2 text-left text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Before you connect</p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            The account must be a <strong>Professional</strong> account
            (Business or Creator).
          </li>
          <li>
            In the Instagram app, turn on{' '}
            <strong>
              Settings → Messages and story replies → Allow access to messages
            </strong>
            . Without it, no messages reach us and nothing reports an error.
          </li>
        </ul>
      </div>

      {setup && <MetaSetupValues setup={setup} />}
    </div>
  );
}

/**
 * The two URLs that must be registered in the Meta dashboard.
 *
 * Shown here because both failures are dead ends otherwise: an
 * unregistered redirect URI dumps the user on Instagram's own
 * "Invalid redirect_uri" page, and a wrong webhook URL gives Meta's
 * generic "couldn't be validated". Neither error names the value it
 * expected or which field it belongs in, and the two URLs differ only
 * in their path — so they are trivially swapped by mistake.
 */
function MetaSetupValues({ setup }: { setup: InstagramStatus['setup'] }) {
  return (
    <details className="mx-auto mt-6 max-w-md text-left">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
        Meta dashboard setup values
      </summary>
      <div className="mt-3 space-y-3">
        <CopyRow
          label="Webhooks → Callback URL"
          value={setup.webhook_url}
        />
        <CopyRow
          label="Business login settings → OAuth Redirect URI"
          value={setup.redirect_uri}
        />
        <CopyRow label="Instagram App ID" value={setup.app_id} />
        <p className="text-xs text-muted-foreground">
          Meta matches the redirect URI <strong>exactly</strong> — a trailing
          slash or <code>http</code> vs <code>https</code> is a mismatch.
        </p>
      </div>
    </details>
  );
}

function CopyRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <div>
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="mt-1 text-xs text-destructive">
          Not configured on the server.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-foreground">{label}</p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="mt-1 flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted"
      >
        <span className="min-w-0 flex-1 break-all">{value}</span>
        {copied ? (
          <CheckCircle2 className="size-3 shrink-0 text-emerald-600" />
        ) : (
          <Copy className="size-3 shrink-0" />
        )}
      </button>
    </div>
  );
}

function AccountCard({ status }: { status: InstagramStatus }) {
  const expiring =
    status.token_expires_in_days !== null && status.token_expires_in_days <= 10;

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
      {status.profile_picture_url ? (
        // Plain <img>, not next/image: the Instagram CDN host is not in
        // the next/image allowlist, and this is one small avatar on a
        // settings page — not worth a remote-pattern entry.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={status.profile_picture_url}
          alt=""
          className="size-12 rounded-full object-cover"
        />
      ) : (
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <InstagramIcon className="size-6" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold text-foreground">
            {status.ig_username ? `@${status.ig_username}` : status.ig_user_id}
          </p>
          {status.connected && (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          ID {status.ig_user_id}
          {status.connected_at &&
            ` · connected ${new Date(status.connected_at).toLocaleDateString()}`}
        </p>
        {status.token_expires_in_days !== null && (
          <p
            className={cn(
              'text-xs',
              expiring ? 'text-amber-600' : 'text-muted-foreground',
            )}
          >
            {status.token_expires_in_days < 0
              ? 'Access token expired'
              : `Access renews automatically · ${status.token_expires_in_days} days left`}
          </p>
        )}
      </div>

      {status.ig_username && (
        <a
          href={`https://instagram.com/${status.ig_username}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Open the Instagram profile"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </div>
  );
}

function SubscribedEvents({ subscribed }: { subscribed: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">
        Subscribed events
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        What Instagram will notify us about.
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {EXPECTED_FIELDS.map((field) => {
          const on = subscribed.includes(field.id);
          return (
            <li key={field.id} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 rounded-full',
                  on ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
              <span className={on ? 'text-foreground' : 'text-muted-foreground'}>
                {field.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Instagram's messaging rules are unlike WhatsApp's in a way that
 * generates support tickets, so they are stated plainly rather than
 * left for an agent to discover when a send fails.
 */
function MessagingWindowCard({
  humanAgentEnabled,
}: {
  humanAgentEnabled: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">
        Messaging rules
      </h3>
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="font-medium text-foreground">
            {humanAgentEnabled ? '7-day reply window' : '24-hour reply window'}
          </dt>
          <dd className="text-muted-foreground">
            {humanAgentEnabled
              ? 'Your app has Meta’s Human Agent permission, so agents can reply for up to 7 days after the customer’s last message.'
              : 'You can reply freely for 24 hours after each customer message. After that the thread closes until they write again.'}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">No broadcasts</dt>
          <dd className="text-muted-foreground">
            Instagram has no approved-template mechanism, so there is no
            compliant way to send bulk DMs. Instagram contacts are excluded
            from broadcast audiences automatically.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">No delivery receipts</dt>
          <dd className="text-muted-foreground">
            Instagram reports when a message is <em>read</em>, but never when
            it is delivered — so sent messages stay on one tick until the
            customer opens them.
          </dd>
        </div>
      </dl>
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
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
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
