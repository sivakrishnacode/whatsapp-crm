'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  ShoppingBag,
  Plus,
  MoreVertical,
  Trash2,
  Loader2,
  RefreshCw,
  Store,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import type { EcommerceIntegration } from '@/types';
import { CatalogueTab } from '@/components/whatsapp-shop/catalogue-tab';
import { OrdersTab } from '@/components/whatsapp-shop/orders-tab';

export default function EcommerceIntegrationsPage() {
  const canCreate = useCan('edit-settings');
  const [activeTab, setActiveTab] = useState<'integrations' | 'catalogue' | 'orders'>('catalogue');
  const [integrations, setIntegrations] = useState<EcommerceIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EcommerceIntegration | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    platform: 'shopify' as 'shopify' | 'woocommerce',
    store_url: '',
    api_key: '',
    api_secret: '',
    access_token: '',
  });
  const [creating, setCreating] = useState(false);

  async function fetchIntegrations() {
    try {
      const res = await fetch('/api/ecommerce/integrations');
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch integrations');
      setIntegrations(data.integrations || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchIntegrations();
  }, []);

  async function handleCreate() {
    if (!formData.platform || !formData.store_url) {
      toast.error('Platform and store URL are required');
      return;
    }

    // Require API credentials for Shopify
    if (formData.platform === 'shopify') {
      if (formData.access_token) {
        // Using access token
        if (formData.access_token === 'temp') {
          toast.error('Please enter Admin API Access Token');
          return;
        }
      } else {
        // Using basic auth
        if (!formData.api_key || !formData.api_secret) {
          toast.error('Please enter API Key and API Password for Shopify');
          return;
        }
      }
    }
    
    // Require API credentials for WooCommerce
    if (formData.platform === 'woocommerce' && (!formData.api_key || !formData.api_secret)) {
      toast.error('Please enter Consumer Key and Consumer Secret for WooCommerce');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/ecommerce/integrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create integration');

      toast.success('Integration created successfully!');
      setCreateOpen(false);
      setFormData({
        platform: 'shopify',
        store_url: '',
        api_key: '',
        api_secret: '',
        access_token: '',
      });
      fetchIntegrations();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create integration');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('ecommerce_integrations')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Integration deleted');
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
      fetchIntegrations();
    } catch (err) {
      toast.error('Failed to delete integration');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSync(id: string) {
    setSyncing(id);
    try {
      const res = await fetch(`/api/ecommerce/sync/${id}`, {
        method: 'POST',
      });
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      toast.success(`Synced ${data.products_synced || 0} products and ${data.orders_synced || 0} orders`);
      fetchIntegrations();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(null);
    }
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case 'connected':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'disconnected':
        return <XCircle className="h-4 w-4 text-gray-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">WhatsApp Shop & Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your native WhatsApp product catalogs and customer shopping carts in one unified dashboard.
          </p>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="flex border-b border-border space-x-1">
        <button
          onClick={() => setActiveTab('catalogue')}
          className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'catalogue'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          WhatsApp Catalogue
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'orders'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          WhatsApp Orders
        </button>
        <button
          onClick={() => setActiveTab('integrations')}
          className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'integrations'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          E-commerce Integrations
        </button>
      </div>

      {activeTab === 'catalogue' && <CatalogueTab />}

      {activeTab === 'orders' && <OrdersTab />}

      {activeTab === 'integrations' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-foreground">External Store Connections</h2>
              <p className="text-sm text-muted-foreground">
                Connect external Shopify or WooCommerce stores to sync products and send order notifications.
              </p>
            </div>
            <GatedButton
              canAct={canCreate}
              gateReason="create e-commerce integrations"
              onClick={() => setCreateOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              New Integration
            </GatedButton>
          </div>

          {integrations.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
              <ShoppingBag className="mb-3 h-10 w-10 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No e-commerce integrations yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Connect your Shopify or WooCommerce store to enable product sync and order notifications.
              </p>
              <GatedButton
                canAct={canCreate}
                gateReason="create e-commerce integrations"
                onClick={() => setCreateOpen(true)}
                className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" />
                New Integration
              </GatedButton>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => (
            <Card key={integration.id} className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      {integration.platform === 'shopify' ? (
                        <img 
                          src="/ecom-logo/svg/shopify_logo_darkbg.svg" 
                          alt="Shopify" 
                          className="h-5 w-5"
                        />
                      ) : (
                        <Store className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <CardTitle className="text-base capitalize">{integration.platform}</CardTitle>
                      <CardDescription className="text-xs">
                        {integration.store_url}
                      </CardDescription>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleSync(integration.id)}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Sync Now
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleDelete(integration.id)}
                        className="text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Status</span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                      integration.status === 'connected'
                        ? 'border-green-500/20 bg-green-500/10 text-green-500'
                        : integration.status === 'error'
                        ? 'border-red-500/20 bg-red-500/10 text-red-500'
                        : 'border-gray-500/20 bg-gray-500/10 text-gray-500'
                    }`}
                  >
                    {getStatusIcon(integration.status)}
                    <span className="ml-1 capitalize">{integration.status}</span>
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Last Sync</span>
                  <span className="text-xs text-foreground">
                    {integration.last_sync_at
                      ? new Date(integration.last_sync_at).toLocaleString()
                      : 'Never'
                    }
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      </div>
      )}

      {/* Create Integration Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add E-commerce Integration</DialogTitle>
            <DialogDescription>
              Connect your Shopify or WooCommerce store to enable product sync and order notifications.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform *</label>
              <Select
                value={formData.platform}
                onValueChange={(value) => 
                  setFormData({ ...formData, platform: (value as 'shopify' | 'woocommerce') || 'shopify' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shopify">Shopify</SelectItem>
                  <SelectItem value="woocommerce">WooCommerce</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Store URL *</label>
              <Input
                value={formData.store_url}
                onChange={(e) => setFormData({ ...formData, store_url: e.target.value })}
                placeholder="https://yourstore.myshopify.com"
              />
              <p className="text-xs text-muted-foreground">
                {formData.platform === 'shopify' 
                  ? 'Your Shopify store URL (e.g., https://yourstore.myshopify.com)'
                  : 'Your WooCommerce store URL (e.g., https://yourstore.com)'
                }
              </p>
            </div>

            {formData.platform === 'shopify' && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Authentication Method</label>
                  <Select value={formData.access_token ? 'token' : 'basic'} onValueChange={(value) => {
                    if (value === 'token') {
                      setFormData({ ...formData, access_token: 'temp', api_key: '', api_secret: '' });
                    } else {
                      setFormData({ ...formData, access_token: '', api_key: '', api_secret: '' });
                    }
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select authentication method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">API Key + Password</SelectItem>
                      <SelectItem value="token">Admin API Access Token</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.access_token ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Admin API Access Token</label>
                    <Input
                      type="password"
                      value={formData.access_token}
                      onChange={(e) => setFormData({ ...formData, access_token: e.target.value })}
                      placeholder="Your Shopify Admin API access token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Get this from Shopify admin &gt; Settings &gt; Apps and sales channels &gt; Develop apps &gt; Your app &gt; Admin API access token
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        value={formData.api_key}
                        onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                        placeholder="Your Shopify API key"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Password</label>
                      <Input
                        type="password"
                        value={formData.api_secret}
                        onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                        placeholder="Your Shopify API password"
                      />
                    </div>
                  </>
                )}
                <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  <p className="mb-2 font-medium">Need help setting up Shopify?</p>
                  <a
                    href="https://shopify.dev/docs/api/admin-rest/latest/resources"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    View Shopify API Documentation →
                  </a>
                </div>
              </>
            )}

            {formData.platform === 'woocommerce' && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Consumer Key</label>
                  <Input
                    value={formData.api_key}
                    onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                    placeholder="WooCommerce consumer key"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Consumer Secret</label>
                  <Input
                    type="password"
                    value={formData.api_secret}
                    onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                    placeholder="WooCommerce consumer secret"
                  />
                </div>
                <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  <p className="mb-2 font-medium">Need help setting up WooCommerce?</p>
                  <a
                    href="https://woocommerce.github.io/woocommerce-rest-api-docs/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    View WooCommerce API Documentation →
                  </a>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Integration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Integration</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the{' '}
              <span className="text-foreground font-medium capitalize">{deleteTarget?.platform}</span>{' '}
              integration for{' '}
              <span className="text-foreground font-medium">{deleteTarget?.store_url}</span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
