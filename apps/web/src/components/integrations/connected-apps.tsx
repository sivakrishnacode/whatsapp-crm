'use client';

/**
 * The connected-apps section of the Integrations page.
 *
 * ONE CARD PER APP, DRIVEN BY THE CATALOGUE
 *   Adding a connector on the server puts a card here with no web
 *   change. That is the same reason the automation step picker reads the
 *   catalogue rather than a local list: one authority, no drift.
 *
 * THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS
 *   Not connected, connected, and NEEDS RECONNECTING. The last is drawn
 *   distinctly from the first on purpose — an expired grant with live
 *   automations pointing at it is an incident, and showing it as a blank
 *   "Connect" invites somebody to conclude nothing was ever set up.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Loader2, Trash2 } from 'lucide-react';

import {
  IntegrationCard,
  IntegrationGrid,
  IntegrationRow,
} from './integration-card';
import {
  connectUrl,
  connectionsFor,
  type AppConnection,
  type CatalogApp,
} from '@/lib/automations/connectors';
import { AppIcon } from './app-icon';

export function ConnectedApps() {
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [connections, setConnections] = useState<AppConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [catalogRes, connectionsRes] = await Promise.all([
        fetch('/api/connections/catalog', { cache: 'no-store' }),
        fetch('/api/connections', { cache: 'no-store' }),
      ]);
      if (catalogRes.ok) {
        const json = (await catalogRes.json()) as { apps?: CatalogApp[] };
        setApps(json.apps ?? []);
      }
      if (connectionsRes.ok) {
        const json = (await connectionsRes.json()) as {
          connections?: AppConnection[];
        };
        setConnections(json.connections ?? []);
      }
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

  // The OAuth callback redirects back here with ?connected= or
  // ?connect_error=. Reporting it as a toast and then stripping the
  // query keeps a refresh from replaying a stale message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('connect_error');
    if (!connected && !error) return;

    if (connected) toast.success(`Connected ${connected}`);
    if (error) toast.error(error);

    params.delete('connected');
    params.delete('connect_error');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, []);

  const disconnect = async (connection: AppConnection, appName: string) => {
    if (
      !confirm(
        `Disconnect ${connection.displayName ?? appName}? Automations using it will stop working until you reconnect.`,
      )
    ) {
      return;
    }
    setDisconnecting(connection.id);
    try {
      const res = await fetch(`/api/connections/${connection.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Could not disconnect');
      toast.success('Disconnected');
      await load();
    } catch {
      toast.error('Could not disconnect. Try again.');
    } finally {
      setDisconnecting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (apps.length === 0) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-foreground text-sm font-semibold">Connected apps</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Sign in once and use these in automations — no API keys to paste.
        </p>
      </div>

      <IntegrationGrid>
        {apps.map((app) => {
          const forApp = connectionsFor(connections, app);
          const broken = forApp.filter((c) => c.status !== 'active');
          const connected = forApp.length > 0;

          return (
            <IntegrationCard
              key={app.app}
              icon={<AppIcon app={app} size={36} />}
              name={app.name}
              blurb={app.blurb}
              status={
                broken.length > 0 ? 'attention' : connected ? 'connected' : 'off'
              }
              statusLabel={
                broken.length > 0
                  ? 'Reconnect'
                  : connected
                    ? 'Connected'
                    : 'Not set up'
              }
              footer={
                connected ? (
                  // A text link once something IS connected: adding a
                  // second account is the rare case, and a full-width
                  // button for it competes with the disconnect control
                  // directly above it.
                  <a
                    href={connectUrl(app, '/integrations')}
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] transition-colors"
                  >
                    {broken.length > 0 ? 'Reconnect' : 'Add another account'}
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <a
                    href={connectUrl(app, '/integrations')}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors"
                  >
                    Connect
                    <ExternalLink className="size-3.5" />
                  </a>
                )
              }
            >
              {forApp.map((connection) => (
                <IntegrationRow
                  key={connection.id}
                  label={connection.displayName ?? connection.id}
                  tone="attention"
                  sublabel={
                    connection.status !== 'active'
                      ? (connection.lastError ?? 'Needs reconnecting')
                      : undefined
                  }
                  action={
                    <button
                      type="button"
                      aria-label={`Disconnect ${connection.displayName ?? app.name}`}
                      disabled={disconnecting === connection.id}
                      onClick={() => void disconnect(connection, app.name)}
                      className="text-muted-foreground/50 hover:text-destructive focus-visible:text-destructive group-hover/row:text-muted-foreground shrink-0 transition-colors disabled:opacity-50"
                    >
                      {disconnecting === connection.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                  }
                />
              ))}
            </IntegrationCard>
          );
        })}
      </IntegrationGrid>
    </section>
  );
}
