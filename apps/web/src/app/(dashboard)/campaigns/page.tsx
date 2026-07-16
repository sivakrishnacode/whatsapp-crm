'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  Calendar,
  Plus,
  MoreVertical,
  Trash2,
  Loader2,
  Play,
  Pause,
  Clock,
  Radio,
  Users,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import type { CampaignSchedule } from '@/types';

export default function CampaignSchedulesPage() {
  const router = useRouter();
  const canCreate = useCan('edit-settings');
  const [schedules, setSchedules] = useState<CampaignSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CampaignSchedule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    type: 'broadcast' as 'broadcast' | 'retargeting',
    broadcast_id: '',
    retargeting_config: '',
    schedule_type: 'one_time' as 'one_time' | 'recurring',
    scheduled_at: '',
    recurring_pattern: '',
    timezone: 'UTC',
  });
  const [creating, setCreating] = useState(false);

  async function fetchSchedules() {
    try {
      const supabase = createClient();
      const url = new URL('/api/campaigns/schedules', window.location.origin);
      if (statusFilter !== 'all') {
        url.searchParams.set('status', statusFilter);
      }
      if (typeFilter !== 'all') {
        url.searchParams.set('type', typeFilter);
      }
      
      const res = await fetch(url.toString());
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch schedules');
      setSchedules(data.schedules || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSchedules();
  }, [statusFilter, typeFilter]);

  async function handleCreate() {
    if (!formData.name.trim() || !formData.scheduled_at) {
      toast.error('Name and scheduled time are required');
      return;
    }

    setCreating(true);
    try {
      const payload = {
        ...formData,
        retargeting_config: formData.type === 'retargeting' 
          ? JSON.parse(formData.retargeting_config || '{}')
          : undefined,
      };

      const res = await fetch('/api/campaigns/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create schedule');

      toast.success('Campaign schedule created');
      setCreateOpen(false);
      setFormData({
        name: '',
        type: 'broadcast',
        broadcast_id: '',
        retargeting_config: '',
        schedule_type: 'one_time',
        scheduled_at: '',
        recurring_pattern: '',
        timezone: 'UTC',
      });
      fetchSchedules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create schedule');
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
        .from('campaign_schedules')
        .delete()
        .eq('id', deleteTarget.id);

      if (error) throw error;
      toast.success('Schedule deleted');
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
      fetchSchedules();
    } catch (err) {
      toast.error('Failed to delete schedule');
    } finally {
      setDeleting(false);
    }
  }

  async function toggleStatus(schedule: CampaignSchedule) {
    const newStatus = schedule.status === 'pending' ? 'running' : 'pending';
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('campaign_schedules')
        .update({ status: newStatus })
        .eq('id', schedule.id);

      if (error) throw error;
      toast.success(`Schedule ${newStatus === 'running' ? 'activated' : 'paused'}`);
      fetchSchedules();
    } catch (err) {
      toast.error('Failed to update schedule');
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Campaign Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Schedule broadcasts and retargeting campaigns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value || 'all')}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="broadcast">Broadcast</SelectItem>
              <SelectItem value="retargeting">Retargeting</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value || 'all')}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <GatedButton
            canAct={canCreate}
            gateReason="create campaign schedules"
            onClick={() => setCreateOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Schedule
          </GatedButton>
        </div>
      </div>

      {schedules.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Calendar className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No campaign schedules yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create your first schedule to automate campaigns.
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create campaign schedules"
            onClick={() => setCreateOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Schedule
          </GatedButton>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">Name</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">Type</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">Schedule</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  Runs
                </TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground hidden sm:table-cell">Next Run</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow
                  key={schedule.id}
                  className="border-border hover:bg-muted/50"
                >
                  <TableCell className="font-medium text-foreground">
                    {schedule.name}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    <div className="flex items-center gap-1.5">
                      {schedule.type === 'broadcast' ? (
                        <Radio className="h-4 w-4" />
                      ) : (
                        <Users className="h-4 w-4" />
                      )}
                      <span className="capitalize">{schedule.type}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      <span className="text-xs">
                        {schedule.schedule_type === 'recurring' ? 'Recurring' : 'One-time'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                    {schedule.run_count}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                        schedule.status === 'running'
                          ? 'border-green-500/20 bg-green-500/10 text-green-500'
                          : schedule.status === 'pending'
                          ? 'border-blue-500/20 bg-blue-500/10 text-blue-500'
                          : schedule.status === 'completed'
                          ? 'border-gray-500/20 bg-gray-500/10 text-gray-500'
                          : 'border-red-500/20 bg-red-500/10 text-red-500'
                      }`}
                    >
                      {schedule.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden sm:table-cell">
                    {schedule.next_run_at 
                      ? new Date(schedule.next_run_at).toLocaleString()
                      : '-'
                    }
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
                        <DropdownMenuItem onClick={() => toggleStatus(schedule)}>
                          {schedule.status === 'pending' ? (
                            <>
                              <Play className="h-4 w-4 mr-2" />
                              Activate
                            </>
                          ) : (
                            <>
                              <Pause className="h-4 w-4 mr-2" />
                              Pause
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setDeleteTarget(schedule);
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

      {/* Create Schedule Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Campaign Schedule</DialogTitle>
            <DialogDescription>
              Schedule a broadcast or retargeting campaign to run automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Campaign Name *</label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Weekly Newsletter"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Type *</label>
                <Select
                  value={formData.type}
                  onValueChange={(value) => 
                    setFormData({ ...formData, type: (value as 'broadcast' | 'retargeting') || 'broadcast' })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="broadcast">Broadcast</SelectItem>
                    <SelectItem value="retargeting">Retargeting</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {formData.type === 'broadcast' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Broadcast ID *</label>
                <Input
                  value={formData.broadcast_id}
                  onChange={(e) => setFormData({ ...formData, broadcast_id: e.target.value })}
                  placeholder="Select a broadcast"
                />
              </div>
            )}

            {formData.type === 'retargeting' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Retargeting Config (JSON) *</label>
                <Textarea
                  value={formData.retargeting_config}
                  onChange={(e) => setFormData({ ...formData, retargeting_config: e.target.value })}
                  placeholder='{"audience": "purchased_last_30d", "message": "Come back!"}'
                  rows={3}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Schedule Type *</label>
                <Select
                  value={formData.schedule_type}
                  onValueChange={(value) => 
                    setFormData({ ...formData, schedule_type: (value as 'one_time' | 'recurring') || 'one_time' })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-time</SelectItem>
                    <SelectItem value="recurring">Recurring</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Timezone</label>
                <Input
                  value={formData.timezone}
                  onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                  placeholder="UTC"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Scheduled At *</label>
              <Input
                type="datetime-local"
                value={formData.scheduled_at}
                onChange={(e) => setFormData({ ...formData, scheduled_at: e.target.value })}
              />
            </div>

            {formData.schedule_type === 'recurring' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Recurring Pattern (Cron) *</label>
                <Input
                  value={formData.recurring_pattern}
                  onChange={(e) => setFormData({ ...formData, recurring_pattern: e.target.value })}
                  placeholder="0 9 * * 1 (Every Monday at 9 AM)"
                />
                <p className="text-xs text-muted-foreground">
                  Use cron expression format (min hour day month weekday)
                </p>
              </div>
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
              Create Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Schedule</DialogTitle>
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
