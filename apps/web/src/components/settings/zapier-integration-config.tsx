'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Loader2,
  Plus,
  Trash2,
  Copy,
  Send,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Webhook,
} from 'lucide-react';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, type WebhookEvent } from '@/lib/webhooks/events';

interface ZapierEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

export function ZapierIntegrationConfig() {
  const [loading, setLoading] = useState(true);
  const [endpoints, setEndpoints] = useState<ZapierEndpoint[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<WebhookEvent[]>(['message.received']);

  const loadEndpoints = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/integrations/zapier');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load connections');
      setEndpoints(data.endpoints || []);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load Zapier connections');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEndpoints();
  }, []);

  const toggleEvent = (event: WebhookEvent, checked: boolean) => {
    setFormEvents((prev) =>
      checked ? [...prev, event] : prev.filter((e) => e !== event)
    );
  };

  const handleConnect = async () => {
    if (!formUrl.trim()) {
      toast.error('Paste your Zapier webhook URL first');
      return;
    }
    if (formEvents.length === 0) {
      toast.error('Pick at least one event to trigger this Zap on');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/integrations/zapier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: formUrl.trim(), events: formEvents }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect Zapier');

      toast.success('Zapier webhook connected!');
      setNewSecret(data.endpoint?.secret || null);
      setFormUrl('');
      setFormEvents(['message.received']);
      setShowAddForm(false);
      await loadEndpoints();
    } catch (err: any) {
      toast.error(err.message || 'Failed to connect Zapier');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (endpoint: ZapierEndpoint) => {
    setTogglingId(endpoint.id);
    try {
      const res = await fetch(`/api/integrations/zapier/${endpoint.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !endpoint.is_active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update connection');

      setEndpoints((prev) =>
        prev.map((e) => (e.id === endpoint.id ? { ...e, ...data.endpoint } : e))
      );
      toast.success(endpoint.is_active ? 'Zap paused' : 'Zap enabled');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update connection');
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (endpoint: ZapierEndpoint) => {
    setTestingId(endpoint.id);
    try {
      const res = await fetch(`/api/integrations/zapier/${endpoint.id}/test`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test delivery failed');
      toast.success('Test event sent — check your Zap history in Zapier');
    } catch (err: any) {
      toast.error(err.message || 'Test delivery failed');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (endpoint: ZapierEndpoint) => {
    if (!confirm('Disconnect this Zap? It will stop receiving CRM events.')) return;
    setDeletingId(endpoint.id);
    try {
      const res = await fetch(`/api/integrations/zapier/${endpoint.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to disconnect');

      setEndpoints((prev) => prev.filter((e) => e.id !== endpoint.id));
      toast.success('Zap disconnected');
    } catch (err: any) {
      toast.error(err.message || 'Failed to disconnect');
    } finally {
      setDeletingId(null);
    }
  };

  const copySecret = async () => {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      toast.success('Signing secret copied');
    } catch {
      toast.error('Copy failed — select and copy manually');
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-orange-500/10 text-orange-500">
          <Webhook className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Zapier Integration</h1>
          <p className="text-xs text-muted-foreground">
            Trigger Zaps whenever something happens in your CRM
          </p>
        </div>
      </div>

      {/* How it works */}
      <Card className="border-border bg-muted/15">
        <CardContent className="p-4 grid gap-4 sm:grid-cols-3 text-xs">
          <div className="space-y-1">
            <div className="font-semibold text-foreground">1. Create a Zap</div>
            <p className="text-muted-foreground leading-relaxed">
              In Zapier, start a Zap with the <strong>Webhooks by Zapier</strong> trigger, choose{' '}
              <strong>Catch Hook</strong>, and copy the custom webhook URL it gives you.
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-foreground">2. Paste it here</div>
            <p className="text-muted-foreground leading-relaxed">
              Add the URL below and pick which CRM events should trigger it.
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-foreground">3. Test & turn it on</div>
            <p className="text-muted-foreground leading-relaxed">
              Send a test event, confirm Zapier picked it up, then publish your Zap.
            </p>
          </div>
        </CardContent>
      </Card>

      {newSecret && (
        <Card className="border-amber-500/20 bg-amber-500/10">
          <CardContent className="p-4 space-y-2 text-xs">
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              Signing secret (shown once)
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Optional — use this to verify the <code className="bg-muted/50 px-1 rounded">X-Conceps-Signature</code>{' '}
              header in a &quot;Code by Zapier&quot; step. Zapier&apos;s Catch Hook trigger works fine without it.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={newSecret} className="font-mono text-xs h-8" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="sm" onClick={copySecret} className="h-8 text-xs shrink-0">
                <Copy className="size-3.5 mr-1" />
                Copy
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setNewSecret(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {endpoints.length === 0 && !showAddForm && (
        <Card className="border-border bg-card/50 shadow-md">
          <CardContent className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-500 mb-6">
              <Webhook className="size-8" />
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Connect your first Zap
            </h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
              No Zaps connected yet. Add a Zapier webhook URL to start sending CRM events
              to your Zaps.
            </p>
            <Button onClick={() => setShowAddForm(true)} className="mt-6">
              <Plus className="size-4 mr-1.5" />
              Add Zapier Webhook
            </Button>
          </CardContent>
        </Card>
      )}

      {endpoints.length > 0 && (
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <Card key={endpoint.id} className="border-border">
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-xs font-mono text-foreground truncate max-w-md">
                      {endpoint.url}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {endpoint.events.map((event) => (
                        <Badge key={event} variant="outline" className="text-[10px] font-normal">
                          {event}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {endpoint.is_active ? (
                      <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 text-[10px] font-medium flex items-center gap-1">
                        <CheckCircle className="size-3" />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-muted-foreground text-[10px] font-medium">
                        Paused
                      </Badge>
                    )}
                    {togglingId === endpoint.id ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={endpoint.is_active}
                        onCheckedChange={() => handleToggleActive(endpoint)}
                        aria-label="Toggle Zap"
                      />
                    )}
                  </div>
                </div>

                {endpoint.failure_count > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-[11px] text-red-600 dark:text-red-400">
                    <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                    <span>
                      {endpoint.failure_count} consecutive delivery failure
                      {endpoint.failure_count === 1 ? '' : 's'}. Check that the Zap is still
                      published and its Catch Hook URL hasn&apos;t changed.
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-[10px] text-muted-foreground">
                    Last delivery:{' '}
                    {endpoint.last_delivery_at
                      ? new Date(endpoint.last_delivery_at).toLocaleString()
                      : 'Never'}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={testingId === endpoint.id}
                      onClick={() => handleTest(endpoint)}
                      className="h-8 text-[11px]"
                    >
                      {testingId === endpoint.id ? (
                        <Loader2 className="size-3.5 animate-spin mr-1" />
                      ) : (
                        <Send className="size-3.5 mr-1" />
                      )}
                      Send Test
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={deletingId === endpoint.id}
                      onClick={() => handleDelete(endpoint)}
                      className="h-8 text-[11px] p-2"
                    >
                      {deletingId === endpoint.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {!showAddForm && (
            <Button variant="outline" onClick={() => setShowAddForm(true)} className="text-xs">
              <Plus className="size-3.5 mr-1.5" />
              Add Another Zap
            </Button>
          )}
        </div>
      )}

      {showAddForm && (
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Connect a Zapier Webhook</CardTitle>
            <CardDescription className="text-xs">
              Paste the Catch Hook URL from your Zap and choose which events should trigger it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Webhook URL *</Label>
              <Input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://hooks.zapier.com/hooks/catch/..."
                className="h-9 text-xs font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">Trigger events *</Label>
              <div className="space-y-2.5">
                {WEBHOOK_EVENTS.map((event) => (
                  <label key={event} className="flex items-start gap-2.5 cursor-pointer">
                    <Checkbox
                      checked={formEvents.includes(event)}
                      onCheckedChange={(checked) => toggleEvent(event, checked)}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-foreground font-mono">{event}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {WEBHOOK_EVENT_DESCRIPTIONS[event]}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button onClick={handleConnect} disabled={creating} size="sm" className="text-xs">
                {creating && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                Connect
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={creating}
                onClick={() => {
                  setShowAddForm(false);
                  setFormUrl('');
                  setFormEvents(['message.received']);
                }}
                className="text-xs"
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <a
        href="https://zapier.com/apps/webhook/integrations"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      >
        Learn more about Webhooks by Zapier
        <ExternalLink className="size-2.5" />
      </a>
    </div>
  );
}
