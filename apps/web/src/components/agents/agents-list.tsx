'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InstagramIcon, WhatsAppIcon } from '@/components/channels/channel-icons';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { useAgents } from '@/hooks/use-agents';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import type { AgentChannel, AgentSummary } from '@/lib/agents/types';

import { CreateAgentDialog } from './create-agent-dialog';

const CHANNEL_META: Record<
  AgentChannel,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  whatsapp: { label: 'WhatsApp', icon: WhatsAppIcon },
  instagram: { label: 'Instagram', icon: InstagramIcon },
  web: { label: 'Web chat', icon: Globe },
};

/**
 * ============================================================
 * The agent list.
 *
 * ⚠️ THE ORDER ON THIS SCREEN IS THE ROUTING ORDER, and that is the
 * whole reason it is a list rather than the card grid the automations
 * page uses. An inbound message goes to the FIRST active agent whose
 * channels cover it, so position is a setting, not a sort preference —
 * and a grid that reflows by column would show the same fact three
 * different ways at three window widths.
 * ============================================================
 */
export function AgentsList() {
  const router = useRouter();
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const {
    data,
    loading,
    busy,
    setActive,
    create,
    duplicate,
    remove,
    reorder,
  } = useAgents(accountId);

  const [creating, setCreating] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (loading || profileLoading || !data) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading your agents…
      </div>
    );
  }

  const { agents, limit, workspace } = data;
  const atLimit = limit.max !== null && limit.used >= limit.max;

  /** Move one agent up or down the routing order. */
  const move = (index: number, delta: number) => {
    const next = [...agents];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void reorder(next);
  };

  const onCreate = async (input: { name?: string; template_id?: string | null }) => {
    const agent = await create(input);
    if (agent) {
      setCreating(false);
      // Straight into the studio: a new agent is switched off and has
      // nothing written on it, so the list would only show a row that
      // needs opening anyway.
      router.push(`/agents/${agent.id}`);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            AI agents
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each agent answers the channels you give it. An inbound message goes
            to the first one on this list that covers its channel.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setProviderOpen(true)}>
            <KeyRound className="size-4" />
            Provider &amp; credits
          </Button>
          <Button
            onClick={() => setCreating(true)}
            disabled={!canEdit || atLimit}
            title={
              atLimit
                ? `Your plan includes ${limit.max} agent${limit.max === 1 ? '' : 's'}.`
                : undefined
            }
          >
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      </div>

      <UsageMeter used={limit.used} max={limit.max} />

      {!workspace.has_key && workspace.credit_mode === 'byok' && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-accent-amber">
          This workspace is set to use its own provider key, but no key is
          stored — so no agent can answer. Add one under Provider &amp; credits,
          or switch back to built-in credits.
        </p>
      )}

      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="size-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">No agents yet</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Start from a role — support, sales, bookings — or from a blank agent
            you write yourself. Nothing answers a customer until you switch it
            on.
          </p>
          <Button
            className="mt-4"
            onClick={() => setCreating(true)}
            disabled={!canEdit}
          >
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {agents.map((agent, index) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              index={index}
              total={agents.length}
              canEdit={canEdit}
              statsWindowDays={data.stats_window_days}
              onOpen={() => router.push(`/agents/${agent.id}`)}
              onToggle={(next) => void setActive(agent, next)}
              onDuplicate={() => void duplicate(agent)}
              onDelete={() => setPendingDelete(agent)}
              onMove={(delta) => move(index, delta)}
            />
          ))}
        </ul>
      )}

      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        templates={data.templates}
        busy={busy}
        onCreate={onCreate}
      />

      {/*
        A centred modal rather than a side drawer: this is a form you
        stop and fill in — two key fields and a mode choice — not a
        reference panel you consult while editing something else behind
        it. The drawer shape belongs to the studio's test chat, where
        seeing the form underneath IS the point.

        Capped at 3xl, the width AiConfig gives itself in Settings, so
        the same form is not two different shapes in two places. The body
        scrolls inside the modal rather than the modal growing past the
        viewport on a laptop.
      */}
      <Dialog open={providerOpen} onOpenChange={setProviderOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" />
              Provider &amp; credits
            </DialogTitle>
            <DialogDescription>
              What powers AI-drafted replies, the auto-reply agent and the test
              panel — one setting for the whole workspace, so changing it here
              changes it for every agent.
            </DialogDescription>
          </DialogHeader>
          <AiConfig hideHeading onSaved={() => undefined} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              This removes{' '}
              <span className="text-foreground">{pendingDelete?.name}</span> and
              its settings. Conversations it answered stay in your inbox, but
              they stop being attributed to it. Your knowledge base and actions
              are shared and are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                if (!pendingDelete) return;
                setDeleting(true);
                await remove(pendingDelete);
                setDeleting(false);
                setPendingDelete(null);
              }}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * "3 of 5 agents". Null max is unlimited, which is how the plans table
 * encodes Enterprise — printing "3 of null" is the bug this guards.
 */
function UsageMeter({ used, max }: { used: number; max: number | null }) {
  if (max === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {used} agent{used === 1 ? '' : 's'} · unlimited on your plan
      </p>
    );
  }

  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  const full = used >= max;

  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            full ? 'bg-accent-amber' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {used} of {max} agent{max === 1 ? '' : 's'} on your plan
        {full && ' — upgrade to add more'}
      </p>
    </div>
  );
}

function AgentRow({
  agent,
  index,
  total,
  canEdit,
  statsWindowDays,
  onOpen,
  onToggle,
  onDuplicate,
  onDelete,
  onMove,
}: {
  agent: AgentSummary;
  index: number;
  total: number;
  canEdit: boolean;
  statsWindowDays: number;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
}) {
  const status = rowStatus(agent);

  return (
    <li className="group rounded-xl border border-border bg-card transition-colors hover:border-primary/40">
      <div className="flex items-center gap-3 p-3">
        {/*
          The routing position, and the only way to change it. Arrows
          rather than drag-and-drop: this list is short by construction
          (a plan caps it), and arrows work with a keyboard and on a
          phone without a drag sensor.
        */}
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            disabled={!canEdit || index === 0}
            onClick={() => onMove(-1)}
            aria-label={`Move ${agent.name} up`}
          >
            <ArrowUp className="size-3.5" />
          </button>
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            disabled={!canEdit || index === total - 1}
            onClick={() => onMove(1)}
            aria-label={`Move ${agent.name} down`}
          >
            <ArrowDown className="size-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="size-4.5 text-primary" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium text-foreground">
                {agent.name}
              </span>
              <Badge
                variant={status.variant}
                className={cn('shrink-0', status.className)}
              >
                {status.label}
              </Badge>
              <ChannelChips channels={agent.channels} />
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{modelLabel(agent)}</span>
              <span className="hidden sm:inline">·</span>
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3" />
                {agent.stats.replies} repl{agent.stats.replies === 1 ? 'y' : 'ies'}
              </span>
              <span>{agent.stats.conversations} conversations</span>
              <span>{agent.stats.handoffs} handed over</span>
              <span className="hidden sm:inline">· last {statsWindowDays} days</span>
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={agent.is_active}
            onCheckedChange={onToggle}
            disabled={!canEdit}
            aria-label={`Switch ${agent.name} ${agent.is_active ? 'off' : 'on'}`}
          />
          <Button variant="ghost" size="sm" onClick={onOpen}>
            <Pencil className="size-4" />
            <span className="sr-only sm:not-sr-only">Edit</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More actions for ${agent.name}`}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
            >
              <MoreVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDuplicate} disabled={!canEdit}>
                <Copy className="size-4" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onDelete}
                disabled={!canEdit}
                className="text-accent-red"
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

/** Which channels this agent covers. Empty means every one of them. */
function ChannelChips({ channels }: { channels: AgentChannel[] }) {
  if (channels.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
        <Sparkles className="size-3" />
        Every channel
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      {channels.map((channel) => {
        const meta = CHANNEL_META[channel];
        const Icon = meta.icon;
        return (
          <span
            key={channel}
            title={meta.label}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            <Icon className="size-3" />
            {meta.label}
          </span>
        );
      })}
    </span>
  );
}

function modelLabel(agent: AgentSummary) {
  if (!agent.resolved_model) return 'Built-in AI · credits';
  return `${agent.resolved_provider} · ${agent.resolved_model}`;
}

/**
 * One honest word about what this agent is doing. Same precedence the
 * studio header uses — off beats drafts-only beats test mode — because
 * that is the order in which each fact stops a customer being answered.
 */
function rowStatus(agent: AgentSummary): {
  label: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  className?: string;
} {
  if (!agent.is_active) {
    return { label: 'Off', variant: 'secondary' };
  }
  if (!agent.auto_reply_enabled) {
    return { label: 'Drafts only', variant: 'outline' };
  }
  if (agent.test_mode) {
    return {
      label: 'Test mode',
      variant: 'outline',
      className: 'border-amber-500/40 text-accent-amber',
    };
  }
  return { label: 'Live', variant: 'default', className: 'bg-green-600 text-white' };
}
