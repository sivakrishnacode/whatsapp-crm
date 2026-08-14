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
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Loader2,
  Trash2,
  XCircle,
} from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  connectUrl,
  connectionsFor,
  type AppConnection,
  type CatalogApp,
} from '@/lib/automations/connectors';

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

      <div className="flex flex-wrap gap-6">
        {apps.map((app) => {
          const forApp = connectionsFor(connections, app);
          const active = forApp.filter((c) => c.status === 'active');
          const broken = forApp.filter((c) => c.status !== 'active');

          return (
            <Card
              key={app.app}
              className="border-border bg-card/45 flex w-full max-w-[350px] flex-col shadow-sm transition-shadow hover:shadow-md"
            >
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <span
                    className="flex size-11 items-center justify-center rounded-xl text-xs font-bold"
                    style={{
                      background: `color-mix(in oklch, ${app.hue} 16%, transparent)`,
                      color: `color-mix(in oklch, ${app.hue}, var(--foreground) 22%)`,
                    }}
                    aria-hidden
                  >
                    {app.monogram}
                  </span>

                  {broken.length > 0 ? (
                    <Badge
                      variant="outline"
                      className="flex items-center gap-1 border-amber-500/20 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                    >
                      <AlertCircle className="size-3" />
                      Needs reconnecting
                    </Badge>
                  ) : active.length > 0 ? (
                    <Badge
                      variant="outline"
                      className="flex items-center gap-1 border-green-500/20 bg-green-500/10 text-[10px] font-medium text-green-600 dark:text-green-400"
                    >
                      <CheckCircle className="size-3" />
                      Connected
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-muted-foreground flex items-center gap-1 text-[10px] font-medium"
                    >
                      <XCircle className="size-3" />
                      Not Configured
                    </Badge>
                  )}
                </div>

                <CardTitle className="text-foreground mt-4 text-base font-semibold">
                  {app.name}
                </CardTitle>
                <CardDescription className="mt-1.5 text-xs leading-relaxed">
                  {app.blurb}
                </CardDescription>
              </CardHeader>

              <CardContent className="flex-1 space-y-2 py-0 pb-4">
                {forApp.map((connection) => (
                  <div
                    key={connection.id}
                    className="bg-muted/40 flex items-center justify-between gap-2 rounded px-2.5 py-1.5"
                  >
                    <span className="min-w-0">
                      <span className="text-foreground block truncate font-mono text-[11px]">
                        {connection.displayName ?? connection.id}
                      </span>
                      {connection.status !== 'active' && (
                        <span className="block text-[10px] text-amber-600 dark:text-amber-400">
                          {connection.lastError ?? 'Reconnect to keep using it'}
                        </span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 h-7 shrink-0 p-1.5"
                      aria-label={`Disconnect ${connection.displayName ?? app.name}`}
                      disabled={disconnecting === connection.id}
                      onClick={() => void disconnect(connection, app.name)}
                    >
                      {disconnecting === connection.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                ))}
              </CardContent>

              <CardFooter className="border-border border-t pt-2">
                {/* A full navigation, not fetch(): this leaves for
                    Google's consent screen and comes back. */}
                <a
                  href={connectUrl(app, '/integrations')}
                  className={
                    forApp.length > 0
                      ? 'border-border hover:bg-muted flex h-9 w-full items-center justify-between rounded-lg border px-3 text-xs font-medium transition-colors'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90 flex h-9 w-full items-center justify-between rounded-lg px-3 text-xs font-medium transition-colors'
                  }
                >
                  {broken.length > 0
                    ? 'Reconnect'
                    : forApp.length > 0
                      ? 'Connect another account'
                      : `Connect ${app.name}`}
                  <ExternalLink className="size-3.5" />
                </a>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
