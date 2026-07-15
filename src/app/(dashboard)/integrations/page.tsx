'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  ArrowRight,
  ExternalLink,
  HelpCircle,
  Workflow,
  Plus,
  RefreshCw,
  Trash2,
  Store,
  ShoppingBag,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import type { EcommerceIntegration } from '@/types';

export default function IntegrationsPage() {
  const supabase = createClient();
  const canCreate = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [fbConnected, setFbConnected] = useState(false);
  const [fbName, setFbName] = useState<string | null>(null);
  const [zapierCount, setZapierCount] = useState(0);

  // E-commerce state
  const [integrations, setIntegrations] = useState<EcommerceIntegration[]>([]);
  const [activePlatform, setActivePlatform] = useState<'shopify' | 'woocommerce' | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    store_url: '',
    api_key: '',
    api_secret: '',
    access_token: '',
  });

  const fetchStatuses = async () => {
    try {
      setLoading(true);
      // Check Facebook connection
      const { data: fb } = await supabase
        .from('facebook_connections')
        .select('fb_user_name')
        .maybeSingle();

      if (fb) {
        setFbConnected(true);
        setFbName(fb.fb_user_name);
      } else {
        setFbConnected(false);
        setFbName(null);
      }

      // Fetch E-commerce integrations
      const res = await fetch('/api/ecommerce/integrations');
      const data = await res.json();
      if (res.ok) {
        setIntegrations(data.integrations || []);
      }

      // Check Zapier connections
      const zapierRes = await fetch('/api/integrations/zapier');
      const zapierData = await zapierRes.json();
      if (zapierRes.ok) {
        setZapierCount((zapierData.endpoints || []).length);
      }
    } catch (err) {
      console.error('Error fetching integration statuses:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
  }, [supabase]);

  // Handle Sync Action
  const handleSync = async (id: string) => {
    setSyncing(id);
    try {
      const res = await fetch(`/api/ecommerce/sync/${id}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');

      toast.success(`Synced ${data.products_synced || 0} products and ${data.orders_synced || 0} orders`);
    } catch (err: any) {
      toast.error(err.message || 'Sync failed');
    } finally {
      await fetchStatuses();
      setSyncing(null);
    }
  };

  // Handle Delete/Disconnect Action
  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this integration? This action cannot be undone.')) return;
    setDeleting(id);
    try {
      const { error } = await supabase
        .from('ecommerce_integrations')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Integration deleted successfully');
      await fetchStatuses();
    } catch (err: any) {
      toast.error('Failed to delete integration');
    } finally {
      setDeleting(null);
    }
  };

  // Handle Create Integration
  const handleCreate = async () => {
    if (!activePlatform || !formData.store_url) {
      toast.error('Store URL is required');
      return;
    }

    if (activePlatform === 'shopify') {
      if (formData.access_token) {
        if (formData.access_token === 'temp') {
          toast.error('Please enter Admin API Access Token');
          return;
        }
      } else {
        if (!formData.api_key || !formData.api_secret) {
          toast.error('Please enter API Key and API Password for Shopify');
          return;
        }
      }
    }

    if (activePlatform === 'woocommerce' && (!formData.api_key || !formData.api_secret)) {
      toast.error('Please enter Consumer Key and Consumer Secret for WooCommerce');
      return;
    }

    setCreating(true);
    try {
      const payload = {
        platform: activePlatform,
        ...formData,
      };

      const res = await fetch('/api/ecommerce/integrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create integration');

      toast.success('Integration connected successfully!');
      setFormData({
        store_url: '',
        api_key: '',
        api_secret: '',
        access_token: '',
      });
      setShowAddForm(false);
      await fetchStatuses();
    } catch (err: any) {
      toast.error(err.message || 'Failed to connect integration');
    } finally {
      setCreating(false);
    }
  };

  const getFriendlyErrorMessage = (errorStr: string) => {
    if (!errorStr) return '';
    if (errorStr.includes('Customer object') || errorStr.includes('PII') || errorStr.includes('personally identifiable information')) {
      return 'Shopify PII Permission Required: This app is not approved to access customer profiles (names, emails, phones). Please enable Customer read access under customer privacy permissions in your Shopify App Configuration.';
    }
    
    // Clean GraphQL error wrappers if present
    try {
      if (errorStr.startsWith('GraphQL errors:')) {
        const jsonStr = errorStr.replace('GraphQL errors:', '').trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed) && parsed[0]?.message) {
          return parsed[0].message;
        }
      }
    } catch {}
    
    return errorStr;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'connected':
        return (
          <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500 text-[10px] font-medium flex items-center gap-1">
            <CheckCircle className="size-3" />
            Connected
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-500 text-[10px] font-medium flex items-center gap-1">
            <AlertCircle className="size-3" />
            Error
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="border-gray-500/20 bg-gray-500/10 text-gray-500 text-[10px] font-medium flex items-center gap-1">
            <XCircle className="size-3" />
            Disconnected
          </Badge>
        );
    }
  };

  const shopifyConnected = integrations.some((i) => i.platform === 'shopify');
  const shopifyStores = integrations.filter((i) => i.platform === 'shopify');
  const shopifyHasError = shopifyStores.some((i) => i.status === 'error');
  const wooConnected = integrations.some((i) => i.platform === 'woocommerce');
  const wooStores = integrations.filter((i) => i.platform === 'woocommerce');
  const wooHasError = wooStores.some((i) => i.status === 'error');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <Workflow className="size-6 text-primary" />
          App Integrations
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your CRM with third-party tools to sync data and automate marketing pipelines
        </p>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="flex flex-wrap gap-6">
          <Card className="border-border bg-card/45 shadow-sm hover:shadow-md transition-shadow flex flex-col w-full max-w-[350px]">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div className="flex size-11 items-center justify-center rounded-xl bg-transparent">
                  <img src="/icons/facebook.png" alt="Facebook" className="size-11 object-contain" />
                </div>
                {fbConnected ? (
                  <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 text-[10px] font-medium flex items-center gap-1">
                    <CheckCircle className="size-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground text-[10px] font-medium flex items-center gap-1">
                    <XCircle className="size-3" />
                    Not Configured
                  </Badge>
                )}
              </div>
              <CardTitle className="text-base mt-4 font-semibold text-foreground flex items-center gap-2">
                Facebook Leads
                <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] py-0 px-1.5 h-4.5 font-semibold">
                  Beta
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs mt-1.5 leading-relaxed">
                Sync leads from Facebook & Instagram Ad Forms to CRM contacts & pipeline deals.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 py-0 pb-4">
              {fbName && (
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2.5 py-1.5 font-mono truncate">
                  User: {fbName}
                </div>
              )}
            </CardContent>
            <CardFooter className="pt-2 border-t border-border">
              <Link href="/integrations/facebook" className="w-full">
                <Button
                  variant={fbConnected ? "outline" : "default"}
                  className="w-full text-xs h-9 justify-between font-medium"
                >
                  {fbConnected ? 'Manage Integration' : 'Connect Account'}
                  <ArrowRight className="size-3.5" />
                </Button>
              </Link>
            </CardFooter>
          </Card>

          {/* Shopify Integration Card */}
          <Card className="border-border bg-card/45 shadow-sm hover:shadow-md transition-shadow flex flex-col w-full max-w-[350px]">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div className="flex size-11 items-center justify-center rounded-xl bg-transparent">
                  <img src="/icons/shopify.png" alt="Shopify" className="size-11 object-contain" />
                </div>
                {shopifyConnected ? (
                  shopifyHasError ? (
                    <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-500 text-[10px] font-medium flex items-center gap-1 animate-pulse">
                      <AlertCircle className="size-3" />
                      Sync Error ({shopifyStores.length})
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 text-[10px] font-medium flex items-center gap-1">
                      <CheckCircle className="size-3" />
                      Connected ({shopifyStores.length})
                    </Badge>
                  )
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground text-[10px] font-medium flex items-center gap-1">
                    <XCircle className="size-3" />
                    Not Configured
                  </Badge>
                )}
              </div>
              <CardTitle className="text-base mt-4 font-semibold text-foreground">Shopify Store</CardTitle>
              <CardDescription className="text-xs mt-1.5 leading-relaxed">
                Sync products, inventory, and track client orders automatically in real-time.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 py-0 pb-4">
              {shopifyConnected && (
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2.5 py-1.5 font-mono truncate">
                  {shopifyStores[0].store_url}
                </div>
              )}
            </CardContent>
            <CardFooter className="pt-2 border-t border-border">
              <Button
                variant={shopifyConnected ? "outline" : "default"}
                onClick={() => {
                  setActivePlatform('shopify');
                  setShowAddForm(!shopifyConnected);
                }}
                className="w-full text-xs h-9 justify-between font-medium"
              >
                {shopifyConnected ? 'Manage Integration' : 'Connect Account'}
                <ArrowRight className="size-3.5" />
              </Button>
            </CardFooter>
          </Card>

          {/* WooCommerce Integration Card */}
          <Card className="border-border bg-card/45 shadow-sm hover:shadow-md transition-shadow flex flex-col w-full max-w-[350px]">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div className="flex size-11 items-center justify-center rounded-xl bg-transparent">
                  <img src="/icons/woo.png" alt="WooCommerce" className="size-11 object-contain" />
                </div>
                {wooConnected ? (
                  wooHasError ? (
                    <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-500 text-[10px] font-medium flex items-center gap-1 animate-pulse">
                      <AlertCircle className="size-3" />
                      Sync Error ({wooStores.length})
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 text-[10px] font-medium flex items-center gap-1">
                      <CheckCircle className="size-3" />
                      Connected ({wooStores.length})
                    </Badge>
                  )
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground text-[10px] font-medium flex items-center gap-1">
                    <XCircle className="size-3" />
                    Not Configured
                  </Badge>
                )}
              </div>
              <CardTitle className="text-base mt-4 font-semibold text-foreground flex items-center gap-2">
                WooCommerce
                <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] py-0 px-1.5 h-4.5 font-semibold">
                  Beta
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs mt-1.5 leading-relaxed">
                Connect WooCommerce store to synchronize inventory and dispatch notifications.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 py-0 pb-4">
              {wooConnected && (
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2.5 py-1.5 font-mono truncate">
                  {wooStores[0].store_url}
                </div>
              )}
            </CardContent>
            <CardFooter className="pt-2 border-t border-border">
              <Button
                variant={wooConnected ? "outline" : "default"}
                onClick={() => {
                  setActivePlatform('woocommerce');
                  setShowAddForm(!wooConnected);
                }}
                className="w-full text-xs h-9 justify-between font-medium"
              >
                {wooConnected ? 'Manage Integration' : 'Connect Account'}
                <ArrowRight className="size-3.5" />
              </Button>
            </CardFooter>
          </Card>

          {/* Zapier Integration Card */}
          <Card className="border-border bg-card/45 shadow-sm hover:shadow-md transition-shadow flex flex-col w-full max-w-[350px]">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div className="flex size-11 items-center justify-center rounded-xl bg-transparent">
                  <img src="/icons/zapier.svg" alt="Zapier" className="size-11 object-contain" />
                </div>
                {zapierCount > 0 ? (
                  <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 text-[10px] font-medium flex items-center gap-1">
                    <CheckCircle className="size-3" />
                    Connected ({zapierCount})
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground text-[10px] font-medium flex items-center gap-1">
                    <XCircle className="size-3" />
                    Not Configured
                  </Badge>
                )}
              </div>
              <CardTitle className="text-base mt-4 font-semibold text-foreground">Zapier</CardTitle>
              <CardDescription className="text-xs mt-1.5 leading-relaxed">
                Trigger Zaps on new contacts, conversations, and messages to automate workflows across thousands of apps.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 py-0 pb-4">
              {zapierCount > 0 && (
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2.5 py-1.5 font-mono truncate">
                  {zapierCount} webhook{zapierCount === 1 ? '' : 's'} connected
                </div>
              )}
            </CardContent>
            <CardFooter className="pt-2 border-t border-border">
              <Link href="/integrations/zapier" className="w-full">
                <Button
                  variant={zapierCount > 0 ? "outline" : "default"}
                  className="w-full text-xs h-9 justify-between font-medium"
                >
                  {zapierCount > 0 ? 'Manage Integration' : 'Connect Zapier'}
                  <ArrowRight className="size-3.5" />
                </Button>
              </Link>
            </CardFooter>
          </Card>
        </div>
      )}

      {/* Docs / Help Section */}
      <Card className="border-border bg-muted/15">
        <CardContent className="p-5 flex flex-col sm:flex-row gap-4 items-start justify-between">
          <div className="space-y-1.5 max-w-xl">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
              <HelpCircle className="size-4 text-primary" />
              Need custom webhook or API access?
            </h3>
            <p className="text-xs text-muted-foreground leading-normal">
              You can issue API keys or configure incoming flow hooks to build custom integrations with CRM features in the API Settings.
            </p>
          </div>
          <Link href="/settings?tab=api" className="shrink-0 self-start sm:self-center">
            <Button variant="outline" size="sm" className="text-xs flex items-center gap-1.5">
              API Keys Config
              <ExternalLink className="size-3" />
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* E-commerce Connections management modal */}
      <Dialog open={!!activePlatform} onOpenChange={() => { setActivePlatform(null); setShowAddForm(false); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="capitalize flex items-center gap-2">
              {activePlatform === 'shopify' ? (
                <img src="/icons/shopify.png" alt="Shopify" className="size-6 object-contain" />
              ) : (
                <img src="/icons/woo.png" alt="WooCommerce" className="size-6 object-contain" />
              )}
              {activePlatform} Integrations
            </DialogTitle>
            <DialogDescription>
              Manage connected stores or add a new {activePlatform} connection.
            </DialogDescription>
          </DialogHeader>

          {activePlatform && (
            <div className="space-y-4 py-3">
              {/* Connection list (only shown if not in Add Form mode) */}
              {!showAddForm && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Connected Stores</h3>
                    <GatedButton
                      canAct={canCreate}
                      gateReason={`connect new ${activePlatform} store`}
                      size="sm"
                      onClick={() => setShowAddForm(true)}
                      className="text-xs flex items-center gap-1"
                    >
                      <Plus className="size-3.5" />
                      Add Store
                    </GatedButton>
                  </div>

                  {integrations.filter((i) => i.platform === activePlatform).length === 0 ? (
                    <div className="text-center p-8 border border-dashed rounded-lg text-xs text-muted-foreground">
                      No stores connected. Click "Add Store" to connect your shop.
                    </div>
                  ) : (
                    <div className="divide-y divide-border border rounded-lg overflow-hidden bg-card/30">
                      {integrations
                        .filter((i) => i.platform === activePlatform)
                        .map((store) => (
                          <div key={store.id} className="p-4 flex flex-col gap-3 text-xs">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div className="space-y-1">
                                <p className="font-semibold text-foreground">{store.store_url}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  Last Sync:{' '}
                                  {store.last_sync_at
                                    ? new Date(store.last_sync_at).toLocaleString()
                                    : 'Never'}
                                </p>
                              </div>
                              <div className="flex items-center gap-3">
                                {getStatusBadge(store.status)}
                                
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={syncing === store.id}
                                  onClick={() => handleSync(store.id)}
                                  className="h-8 text-[11px]"
                                >
                                  {syncing === store.id ? (
                                    <Loader2 className="size-3.5 animate-spin mr-1" />
                                  ) : (
                                    <RefreshCw className="size-3.5 mr-1" />
                                  )}
                                  Sync
                                </Button>

                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={deleting === store.id}
                                  onClick={() => handleDelete(store.id)}
                                  className="h-8 text-[11px] p-2"
                                >
                                  {deleting === store.id ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-3.5" />
                                  )}
                                </Button>
                              </div>
                            </div>
                            
                            {store.sync_error && (
                              <div className="mt-1.5 p-3 bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 rounded-lg flex gap-2 items-start">
                                <AlertCircle className="size-4 shrink-0 mt-0.5 text-red-500" />
                                <div className="space-y-1">
                                  <p className="font-semibold">Sync Error</p>
                                  <p className="text-[11px] leading-relaxed opacity-90 break-words max-w-full">
                                    {getFriendlyErrorMessage(store.sync_error)}
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* Add Store Form */}
              {showAddForm && (
                <div className="space-y-4 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Connect New Store</h3>
                    {integrations.filter((i) => i.platform === activePlatform).length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowAddForm(false)}
                        className="text-xs"
                      >
                        Back to List
                      </Button>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Store URL *</label>
                      <Input
                        value={formData.store_url}
                        onChange={(e) => setFormData({ ...formData, store_url: e.target.value })}
                        placeholder={
                          activePlatform === 'shopify'
                            ? 'https://yourstore.myshopify.com'
                            : 'https://yourstore.com'
                        }
                        className="h-9 text-xs"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        {activePlatform === 'shopify'
                          ? 'Shopify URL (e.g., https://mystore.myshopify.com)'
                          : 'WooCommerce Store root URL (e.g., https://mystore.com)'}
                      </p>
                    </div>

                    {activePlatform === 'shopify' && (
                      <>
                        <div className="space-y-1">
                          <label className="text-xs font-medium">Authentication Method</label>
                          <Select
                            value={formData.access_token ? 'token' : 'basic'}
                            onValueChange={(value) => {
                              if (value === 'token') {
                                setFormData({ ...formData, access_token: 'temp', api_key: '', api_secret: '' });
                              } else {
                                setFormData({ ...formData, access_token: '', api_key: '', api_secret: '' });
                              }
                            }}
                          >
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue placeholder="Select auth method" />
                            </SelectTrigger>
                            <SelectContent className="text-xs">
                              <SelectItem value="basic">API Key + Password</SelectItem>
                              <SelectItem value="token">Admin API Access Token</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {formData.access_token ? (
                          <div className="space-y-1">
                            <label className="text-xs font-medium">Admin API Access Token</label>
                            <Input
                              type="password"
                              value={formData.access_token}
                              onChange={(e) => setFormData({ ...formData, access_token: e.target.value })}
                              placeholder="shpat_..."
                              className="h-9 text-xs"
                            />
                          </div>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                              <label className="text-xs font-medium">API Key</label>
                              <Input
                                value={formData.api_key}
                                onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                                placeholder="API Key"
                                className="h-9 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium">API Password</label>
                              <Input
                                type="password"
                                value={formData.api_secret}
                                onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                                placeholder="API Password"
                                className="h-9 text-xs"
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {activePlatform === 'woocommerce' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium">Consumer Key</label>
                          <Input
                            value={formData.api_key}
                            onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                            placeholder="ck_..."
                            className="h-9 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium">Consumer Secret</label>
                          <Input
                            type="password"
                            value={formData.api_secret}
                            onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                            placeholder="cs_..."
                            className="h-9 text-xs"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (showAddForm && integrations.filter((i) => i.platform === activePlatform).length > 0) {
                  setShowAddForm(false);
                } else {
                  setActivePlatform(null);
                  setShowAddForm(false);
                }
              }}
              disabled={creating}
              className="text-xs"
            >
              Cancel
            </Button>
            {showAddForm && (
              <Button onClick={handleCreate} disabled={creating} size="sm" className="text-xs">
                {creating && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                Connect Store
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
