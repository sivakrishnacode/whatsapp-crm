'use client';

import { useState } from 'react';
import { Globe, Loader2, Power } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InstagramIcon, WhatsAppIcon } from '@/components/channels/channel-icons';
import { cn } from '@/lib/utils';
import type { AgentChannel, AgentStudio } from '@/lib/agents/types';

const CHANNELS: Array<{
  id: AgentChannel;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'whatsapp', label: 'WhatsApp', icon: WhatsAppIcon },
  { id: 'instagram', label: 'Instagram', icon: InstagramIcon },
  { id: 'web', label: 'Web chat', icon: Globe },
];

/**
 * ============================================================
 * Routing: which conversations reach this agent, and what it runs on.
 *
 * Three things live here because they are the three that decide whether
 * this agent is the one that answers, rather than how it answers:
 * whether it is on, which channels it covers, and which model it uses.
 * ============================================================
 */
export function AgentRouting({
  studio,
  canEdit,
  saving,
  onSave,
}: {
  studio: AgentStudio;
  canEdit: boolean;
  saving: boolean;
  onSave: (
    body: Record<string, unknown>,
    opts?: { successMessage?: string },
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState(studio.name ?? '');
  const [model, setModel] = useState(studio.model ?? '');
  const [dirty, setDirty] = useState(false);

  const channels = studio.channels ?? [];

  const toggleChannel = (channel: AgentChannel) => {
    const next = channels.includes(channel)
      ? channels.filter((c) => c !== channel)
      : [...channels, channel];
    void onSave(
      { channels: next },
      {
        successMessage:
          next.length === 0
            ? 'This agent now answers every channel.'
            : 'Channels saved.',
      },
    );
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Power className="size-4 text-primary" />
              Switched on
            </h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              An agent that is off does nothing at all — no drafts in the inbox,
              no replies to customers. Everything else here stays as you left
              it.
            </p>
          </div>
          <Switch
            checked={Boolean(studio.is_active)}
            disabled={!canEdit || saving}
            onCheckedChange={(next) =>
              void onSave(
                { is_active: next },
                { successMessage: next ? 'Agent switched on.' : 'Agent paused.' },
              )
            }
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-base font-semibold text-foreground">Channels</h2>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Which conversations this agent may answer. An inbound message goes to
          the first agent on your list whose channels cover it — so if two
          agents both cover WhatsApp, the one higher up answers.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {CHANNELS.map(({ id, label, icon: Icon }) => {
            const on = channels.includes(id);
            return (
              <button
                key={id}
                type="button"
                disabled={!canEdit || saving}
                onClick={() => toggleChannel(id)}
                aria-pressed={on}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-60',
                  on
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/40',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {channels.length === 0
            ? 'Nothing selected, so this agent answers every channel. That is what the agent you already had does, and it is usually what you want with one agent.'
            : `Only ${channels.length === 1 ? 'this channel' : 'these channels'}. Conversations on the others are left for another agent, or for a human.`}
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-base font-semibold text-foreground">Name and model</h2>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="routing-name">Name in your list</Label>
            <Input
              id="routing-name"
              value={name}
              maxLength={60}
              disabled={!canEdit}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Internal. Customers never see it — that is the agent name on the
              Persona tab.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="routing-model">Model</Label>
            <Input
              id="routing-model"
              value={studio.model_editable ? model : ''}
              placeholder={
                studio.model_editable
                  ? (studio.workspace_model ?? 'Workspace default')
                  : 'Built-in AI (chosen for you)'
              }
              disabled={!canEdit || !studio.model_editable}
              onChange={(e) => {
                setModel(e.target.value);
                setDirty(true);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {studio.model_editable
                ? 'Leave empty to follow the workspace default. The provider comes from the key stored for the workspace, so it is the same for every agent.'
                : 'While you are on built-in AI credits, the model is chosen for you — one shared key serves every workspace, so it runs on a tier that stays fast for everyone.'}
            </p>
          </div>
        </div>

        {dirty && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              disabled={!canEdit || saving}
              onClick={async () => {
                const ok = await onSave(
                  studio.model_editable
                    ? { name, model: model.trim() || null }
                    : { name },
                  { successMessage: 'Saved.' },
                );
                if (ok) setDirty(false);
              }}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
