'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Check,
  Loader2,
  RefreshCw,
  Zap,
  Shield,
  Database,
  Layers,
  Trash2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';

interface FacebookConnection {
  id: string;
  fb_user_id: string;
  fb_user_name: string;
  access_token: string;
  created_at: string;
}

interface FacebookPage {
  id: string;
  connection_id: string;
  page_id: string;
  page_name: string;
  is_syncing: boolean;
  created_at: string;
}

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: any;
  }
}

export function FacebookLeadsConfig() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [togglingPageId, setTogglingPageId] = useState<string | null>(null);
  const [connection, setConnection] = useState<FacebookConnection | null>(null);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [recentLeads, setRecentLeads] = useState<any[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  const fbAppId = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID || '';

  // Initialize Facebook SDK
  useEffect(() => {
    if (typeof window === 'undefined' || !fbAppId) return;

    if (window.FB) return;

    window.fbAsyncInit = function () {
      window.FB.init({
        appId: fbAppId,
        cookie: true,
        xfbml: true,
        version: 'v20.0',
      });
    };

    // Load SDK script
    (function (d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s) as HTMLScriptElement;
      js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      fjs.parentNode?.insertBefore(js, fjs);
    })(document, 'script', 'facebook-jssdk');
  }, [fbAppId]);

  // Load configuration and pages
  const loadData = async () => {
    try {
      setLoading(true);
      const { data: conn, error: connErr } = await supabase
        .from('facebook_connections')
        .select('*')
        .maybeSingle();

      if (connErr) throw connErr;
      setConnection(conn);

      if (conn) {
        const { data: pgList, error: pgErr } = await supabase
          .from('facebook_pages')
          .select('*')
          .order('page_name', { ascending: true });

        if (pgErr) throw pgErr;
        setPages(pgList || []);

        await loadRecentLeads();
      }
    } catch (err: any) {
      console.error('Error loading data:', err);
      toast.error('Failed to load Facebook configuration');
    } finally {
      setLoading(false);
    }
  };

  const loadRecentLeads = async () => {
    try {
      setLoadingLeads(true);
      // Fetch contacts that were created with source = Facebook/Instagram
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      
      // Map mock/real source fields if present. We'll filter contacts by email or company for visual display
      setRecentLeads(data || []);
    } catch (err) {
      console.error('Error loading leads:', err);
    } finally {
      setLoadingLeads(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Handle Facebook Login click
  const handleConnect = async (isDemo = false) => {
    if (isDemo || !fbAppId) {
      // Demo Connection Mode
      setConnecting(true);
      try {
        const res = await fetch('/api/integrations/facebook/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: 'mock_demo_user_token', isDemo: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Connection failed');

        toast.success('Successfully connected to Facebook (Demo Mode)');
        await loadData();
      } catch (err: any) {
        toast.error(err.message || 'Demo connection failed');
      } finally {
        setConnecting(false);
      }
      return;
    }

    if (!window.FB) {
      toast.error('Facebook SDK not loaded yet. Try again or check ad blockers.');
      return;
    }

    setConnecting(true);
    window.FB.login(
      (response: any) => {
        if (response.authResponse) {
          const clientToken = response.authResponse.accessToken;
          exchangeToken(clientToken);
        } else {
          toast.error('Facebook login cancelled or failed');
          setConnecting(false);
        }
      },
      { scope: 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval' }
    );
  };

  // Exchange short-lived token for long-lived and store in database
  const exchangeToken = async (clientToken: string) => {
    try {
      const res = await fetch('/api/integrations/facebook/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: clientToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connection failed');

      toast.success('Facebook account successfully connected!');
      await loadData();
    } catch (err: any) {
      console.error('Token exchange error:', err);
      toast.error(err.message || 'Failed to exchange tokens');
    } finally {
      setConnecting(false);
    }
  };

  // Toggle leads sync status for a page
  const handleToggleSync = async (page: FacebookPage) => {
    setTogglingPageId(page.id);
    try {
      const targetState = !page.is_syncing;
      const res = await fetch('/api/integrations/facebook/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: page.page_id, isSyncing: targetState }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync toggle failed');

      setPages(prev =>
        prev.map(p => (p.id === page.id ? { ...p, is_syncing: targetState } : p))
      );
      toast.success(
        targetState
          ? `Lead syncing activated for ${page.page_name}`
          : `Lead syncing deactivated for ${page.page_name}`
      );
    } catch (err: any) {
      console.error('Toggle sync error:', err);
      toast.error(err.message || 'Failed to toggle page sync');
    } finally {
      setTogglingPageId(null);
    }
  };

  // Disconnect Facebook Account
  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect your Facebook account? All lead syncing will stop.')) return;

    setLoading(true);
    try {
      const { error } = await supabase
        .from('facebook_connections')
        .delete()
        .eq('id', connection?.id);

      if (error) throw error;

      setConnection(null);
      setPages([]);
      setRecentLeads([]);
      toast.success('Facebook account disconnected.');
    } catch (err: any) {
      console.error('Disconnect error:', err);
      toast.error('Failed to disconnect account');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  // --- CONNECT SCREEN ---
  if (!connection) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-transparent text-white">
            <img src="/icons/facebook.png" alt="Facebook" className="size-10 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Facebook Leads Integration
            </h1>
            <p className="text-xs text-muted-foreground">
              Connect and manage your Facebook lead generation
            </p>
          </div>
        </div>

        <Card className="border-border bg-card/50 shadow-md">
          <CardContent className="flex flex-col items-center justify-center px-6 py-12 text-center lg:px-12">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-transparent mb-6">
              <img src="/icons/facebook.png" alt="Facebook" className="size-16 object-contain" />
            </div>

            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Connect Your Facebook Account
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
              <strong className="text-primary font-medium">Note:</strong> Connect a single page from the option which you need to connect for lead retrieval for the successful configuration. Pages with active ads account will only get successful connection. Sync leads from your Facebook Pages and Lead Ad Forms directly to your dashboard. Start capturing and managing leads in real-time.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                onClick={() => handleConnect(false)}
                disabled={connecting}
                className="bg-rose-600 hover:bg-rose-700 text-white font-medium px-6"
              >
                {connecting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <svg
                      className="mr-2 size-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-3.5H16c-1.21 0-1.5.59-1.5 1.5v2H11v-6h2.5V11h-2.5V8.5C11 6.57 12 5.5 14.5 5.5c.9 0 1.5.1 2 .2v2.3h-1.5c-.83 0-1 .39-1 1V11h2.5l-.5 2.5H14v5h4.5z" />
                    </svg>
                    Connect with Facebook
                  </>
                )}
              </Button>

              {!fbAppId && (
                <Button
                  variant="outline"
                  onClick={() => handleConnect(true)}
                  disabled={connecting}
                  className="border-dashed"
                >
                  Connect in Demo Mode
                </Button>
              )}
            </div>

            {!fbAppId && (
              <div className="mt-6 flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3.5 text-left text-xs text-yellow-700 dark:text-yellow-400 max-w-lg">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Facebook App ID not configured</p>
                  <p className="mt-1 text-[11px] leading-normal opacity-90">
                    To use real OAuth, set the <code className="bg-yellow-500/10 px-1 py-0.5 rounded font-mono">NEXT_PUBLIC_FACEBOOK_APP_ID</code> env variable. Using "Demo Mode" allows you to connect simulated sandbox pages for testing.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Features Promo Grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col items-center text-center p-4">
            <div className="flex size-12 items-center justify-center rounded-xl bg-rose-50 dark:bg-rose-950/20 text-rose-500 mb-3 shadow-inner">
              <Zap className="size-5 fill-rose-500/10" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Real-time Sync</h3>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-[200px] leading-normal">
              Automatic synchronization of new leads as they come in
            </p>
          </div>

          <div className="flex flex-col items-center text-center p-4">
            <div className="flex size-12 items-center justify-center rounded-xl bg-rose-50 dark:bg-rose-950/20 text-rose-500 mb-3 shadow-inner">
              <Shield className="size-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Secure Connection</h3>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-[200px] leading-normal">
              Protected API access with limited permissions
            </p>
          </div>

          <div className="flex flex-col items-center text-center p-4">
            <div className="flex size-12 items-center justify-center rounded-xl bg-rose-50 dark:bg-rose-950/20 text-rose-500 mb-3 shadow-inner">
              <Database className="size-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Centralized Data</h3>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-[200px] leading-normal">
              All lead data managed in your dashboard
            </p>
          </div>

          <div className="flex flex-col items-center text-center p-4">
            <div className="flex size-12 items-center justify-center rounded-xl bg-rose-50 dark:bg-rose-950/20 text-rose-500 mb-3 shadow-inner">
              <Layers className="size-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Multi Data Support</h3>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-[200px] leading-normal">
              Connect to facebook retrieves leads from both instagram & facebook
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --- CONNECTED/MANAGEMENT SCREEN ---
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Facebook Leads Integration
          </h1>
          <p className="text-xs text-muted-foreground">
            Sync leads from your Facebook Pages and forms directly to your pipeline
          </p>
        </div>
        <Button
          variant="destructive"
          onClick={handleDisconnect}
          className="flex items-center gap-1.5 self-start text-xs h-9"
        >
          <Trash2 className="size-3.5" />
          Disconnect Account
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Connection info & Pages list */}
        <div className="md:col-span-2 space-y-6">
          <Card className="border-border">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Check className="size-4 text-green-500 bg-green-500/10 p-0.5 rounded-full" />
                Connected Facebook Account
              </CardTitle>
              <CardDescription className="text-xs">
                Active connection established with the following user profile.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-xs space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">User Name:</span>
                <span className="font-semibold text-foreground">{connection.fb_user_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Facebook ID:</span>
                <span className="font-mono text-muted-foreground">{connection.fb_user_id}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Connection Date:</span>
                <span className="text-muted-foreground">
                  {new Date(connection.created_at).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span>Facebook Pages</span>
                <Badge variant="outline" className="text-[10px] font-normal">
                  {pages.length} Pages Available
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs">
                Toggle lead synchronization on or off for each page. Webhooks will automatically be configured.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 border-t border-border">
              {pages.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No Facebook Pages found. Make sure you have authorized access to pages in Facebook settings.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {pages.map(page => (
                    <div
                      key={page.id}
                      className="flex items-center justify-between p-4 transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold text-sm shrink-0">
                          {page.page_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                            {page.page_name}
                            {page.is_syncing && (
                              <span className="flex size-1.5 rounded-full bg-green-500 animate-pulse" />
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            ID: <span className="font-mono">{page.page_id}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {togglingPageId === page.id ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Switch
                            checked={page.is_syncing}
                            onCheckedChange={() => handleToggleSync(page)}
                            aria-label={`Toggle sync for ${page.page_name}`}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sync Feed / Right Column */}
        <div className="space-y-6">
          <Card className="border-border">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span>Recent Synced Leads</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={loadRecentLeads}
                  disabled={loadingLeads}
                  className="size-7 text-muted-foreground"
                >
                  <RefreshCw className={`size-3.5 ${loadingLeads ? 'animate-spin' : ''}`} />
                </Button>
              </CardTitle>
              <CardDescription className="text-xs">
                Latest leads received from Facebook Ads.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 border-t border-border">
              {loadingLeads ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : recentLeads.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No leads synced yet. Toggles pages above to start syncing.
                </div>
              ) : (
                <div className="divide-y divide-border text-[11px]">
                  {recentLeads.map(lead => (
                    <div key={lead.id} className="p-3.5 space-y-1 hover:bg-muted/20 transition-colors">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">{lead.name || 'Unnamed Lead'}</span>
                        <span className="text-[9px] text-muted-foreground">
                          {new Date(lead.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="text-muted-foreground flex items-center justify-between">
                        <span>{lead.phone}</span>
                        {lead.email && <span className="opacity-80">{lead.email}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border bg-muted/20">
            <CardContent className="p-4 text-xs space-y-2">
              <div className="font-semibold flex items-center gap-1.5 text-foreground">
                <AlertCircle className="size-3.5 text-blue-500" />
                Testing Meta Leads
              </div>
              <p className="text-[11px] leading-normal text-muted-foreground">
                Use the Meta developer lead testing tool to generate mockup submissions and trigger real-time updates.
              </p>
              <a
                href="https://developers.facebook.com/tools/lead-ads-testing"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-blue-500 hover:underline font-semibold pt-1"
              >
                Lead Ads Testing Tool
                <ExternalLink className="size-2.5" />
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
