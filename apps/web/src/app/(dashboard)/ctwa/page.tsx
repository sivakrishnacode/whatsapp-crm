'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Megaphone,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Loader2,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import type { CTWACampaign } from '@/types';

export default function CTWACampaignsPage() {
  const router = useRouter();
  const canCreate = useCan('edit-settings');
  const [campaigns, setCampaigns] = useState<CTWACampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CTWACampaign | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    meta_ad_id: '',
    meta_campaign_id: '',
    pre_filled_message: '',
    deep_link_url: '',
  });
  const [creating, setCreating] = useState(false);

  async function fetchCampaigns() {
    try {
      const supabase = createClient();
      const url = new URL('/api/ctwa/campaigns', window.location.origin);
      if (statusFilter !== 'all') {
        url.searchParams.set('status', statusFilter);
      }
      
      const res = await fetch(url.toString());
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch campaigns');
      setCampaigns(data.campaigns || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCampaigns();
  }, [statusFilter]);

  async function handleCreate() {
    if (!formData.name.trim()) {
      toast.error('Campaign name is required');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/ctwa/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create campaign');

      toast.success('Campaign created successfully');
      setCreateOpen(false);
      setFormData({
        name: '',
        meta_ad_id: '',
        meta_campaign_id: '',
        pre_filled_message: '',
        deep_link_url: '',
      });
      fetchCampaigns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create campaign');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('ctwa_campaigns')
        .delete()
        .eq('id', deleteTarget.id);

      if (error) throw error;
      toast.success('Campaign deleted');
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
      fetchCampaigns();
    } catch (err) {
      toast.error('Failed to delete campaign');
    } finally {
      setDeleting(false);
    }
  }

  function copyTrackingLink(campaign: CTWACampaign) {
    const baseUrl = window.location.origin;
    const trackingUrl = `${baseUrl}/ctwa/${campaign.id}`;
    navigator.clipboard.writeText(trackingUrl);
    toast.success('Tracking link copied');
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">CTWA Campaigns</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track Click-to-WhatsApp ad campaigns and conversions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value || 'all')}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <GatedButton
            canAct={canCreate}
            gateReason="create CTWA campaigns"
            onClick={() => setCreateOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Campaign
          </GatedButton>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Megaphone className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No CTWA campaigns yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create your first campaign to track WhatsApp ad performance.
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create CTWA campaigns"
            onClick={() => setCreateOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Campaign
          </GatedButton>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">Name</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">Meta Ad ID</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  Clicks
                </TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  Conversations
                </TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground hidden sm:table-cell">Created</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((campaign) => (
                <TableRow
                  key={campaign.id}
                  className="border-border hover:bg-muted/50"
                >
                  <TableCell className="font-medium text-foreground">
                    {campaign.name}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell font-mono text-xs">
                    {campaign.meta_ad_id || '-'}
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                    {campaign.click_count}
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                    {campaign.conversation_count}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                        campaign.status === 'active'
                          ? 'border-green-500/20 bg-green-500/10 text-green-500'
                          : campaign.status === 'paused'
                          ? 'border-yellow-500/20 bg-yellow-500/10 text-yellow-500'
                          : 'border-gray-500/20 bg-gray-500/10 text-gray-500'
                      }`}
                    >
                      {campaign.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden sm:table-cell">
                    {new Date(campaign.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                          />
                        }
                      >
                        <MoreVertical className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => copyTrackingLink(campaign)}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy Tracking Link
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <ExternalLink className="h-4 w-4 mr-2" />
                          View Analytics
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setDeleteTarget(campaign);
                            setDeleteConfirmOpen(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create Campaign Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create CTWA Campaign</DialogTitle>
            <DialogDescription>
              Set up a new Click-to-WhatsApp ad campaign to track conversions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Campaign Name *</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Summer Sale 2024"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Meta Ad ID</label>
              <Input
                value={formData.meta_ad_id}
                onChange={(e) => setFormData({ ...formData, meta_ad_id: e.target.value })}
                placeholder="1234567890123456"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Meta Campaign ID</label>
              <Input
                value={formData.meta_campaign_id}
                onChange={(e) => setFormData({ ...formData, meta_campaign_id: e.target.value })}
                placeholder="9876543210987654"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Pre-filled Message</label>
              <Input
                value={formData.pre_filled_message}
                onChange={(e) => setFormData({ ...formData, pre_filled_message: e.target.value })}
                placeholder="Hi, I'm interested in..."
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Deep Link URL</label>
              <Input
                value={formData.deep_link_url}
                onChange={(e) => setFormData({ ...formData, deep_link_url: e.target.value })}
                placeholder="https://yourstore.com/product"
              />
            </div>
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
              Create Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <span className="text-foreground font-medium">{deleteTarget?.name}</span>
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
              onClick={handleDelete}
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
