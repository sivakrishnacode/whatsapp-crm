'use client';

/**
 * The automation editor.
 *
 * Replaces the stacked-card builder that lived here: a canvas with a
 * docked inspector, in parity with the flows editor. The step forms and
 * resource pickers moved to `canvas/step-fields.tsx` — this file is the
 * shell (name, active switch, save) and the state that both the canvas
 * and the inspector read.
 *
 * The exported names (`AutomationBuilder`, `BuilderInitial`,
 * `BuilderStep`, `fromServerSteps`, `ServerStepNode`) are unchanged, so
 * the `/automations/new` and `/automations/[id]/edit` pages keep working
 * without knowing the editor was rewritten.
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { STEP_META } from '@/lib/automations/step-meta';
import {
  toApiSteps,
  type BuilderStep,
} from '@/lib/automations/graph';
import { runDiagnostics } from '@/lib/automations/diagnostics';
import type { AutomationTriggerType } from '@/types';
import { AutomationCanvas } from './canvas/automation-canvas';
import { DiagnosticsPanel } from './canvas/diagnostics-panel';
import {
  AutomationResourcesProvider,
  useAutomationResources,
} from './canvas/resources';

export type { BuilderStep } from '@/lib/automations/graph';
export {
  fromServerSteps,
  toApiSteps,
  type ServerStepNode,
} from '@/lib/automations/graph';

export interface BuilderInitial {
  id?: string;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  /**
   * Channel restriction. Empty = run on all channels, which is both the
   * default and what every automation predating the column does.
   */
  channels: string[];
  is_active: boolean;
  steps: BuilderStep[];
}

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  // The resources provider wraps the HEADER as well as the canvas: the
  // checks panel needs segments, flows and other automations to tell a
  // filter segment from a static one, or an inactive flow from a live
  // one.
  return (
    <AutomationResourcesProvider currentAutomationId={initial.id}>
      <BuilderShell initial={initial} />
    </AutomationResourcesProvider>
  );
}

function BuilderShell({ initial }: { initial: BuilderInitial }) {
  const router = useRouter();
  const isEditing = Boolean(initial.id);
  const [state, setState] = useState<BuilderInitial>(initial);
  const [saving, setSaving] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { segments, flows, automations, apps, connections } =
    useAutomationResources();

  const patch = useCallback(
    <K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) => {
      setState((s) => ({ ...s, [key]: value }));
    },
    [],
  );

  const setSteps = useCallback(
    (updater: (steps: BuilderStep[]) => BuilderStep[]) => {
      setState((s) => ({ ...s, steps: updater(s.steps) }));
    },
    [],
  );

  const diagnostics = useMemo(
    () =>
      runDiagnostics({
        steps: state.steps,
        triggerType: state.trigger_type,
        triggerConfig: state.trigger_config,
        channels: state.channels,
        isActive: state.is_active,
        segments,
        flows,
        automations,
        apps,
        connections,
        currentAutomationId: initial.id,
      }),
    [state, segments, flows, automations, apps, connections, initial.id],
  );

  async function save() {
    setSaving(true);
    try {
      const payload = {
        name: state.name || 'Untitled automation',
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        channels: state.channels,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      };

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/automations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server refuses to ACTIVATE a broken automation and returns
        // every issue. Surface the first concretely rather than making
        // someone open DevTools for the array.
        const first: { path?: string; message?: string } | undefined =
          body?.issues?.[0];
        toast.error(first?.message ?? body?.error ?? 'Save failed', {
          description: first?.path ? `at ${first.path}` : undefined,
        });
        return;
      }
      toast.success(isEditing ? 'Automation saved' : 'Automation created');
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-background fixed inset-0 flex flex-col">
      <header className="border-border bg-card/80 flex flex-shrink-0 items-center gap-2 border-b px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md transition-colors"
          aria-label="Back to automations"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patch('name', e.target.value)}
          placeholder="Untitled automation"
          aria-label="Automation name"
          className="text-foreground placeholder:text-muted-foreground focus:bg-muted min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold focus:outline-none sm:text-base"
        />

        {/* Sits before the save button because that is what it is
            about: activating a broken automation is refused server-side,
            and every OTHER problem here fails silently at run time. */}
        <DiagnosticsPanel
          diagnostics={diagnostics}
          onSelectStep={setSelectedKey}
        />


        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="hidden sm:inline">Active</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patch('is_active', Boolean(v))}
            aria-label="Active"
          />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? 'Save' : 'Save draft'}
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        <AutomationCanvas
            steps={state.steps}
            setSteps={setSteps}
            triggerType={state.trigger_type}
            triggerConfig={state.trigger_config}
            channels={state.channels}
            currentAutomationId={initial.id}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onTriggerTypeChange={(t) => {
              // An Instagram- or web-only trigger locks the automation to
              // that channel, so the author does not have to know to set
              // it separately.
              const lock = TRIGGER_CHANNEL_LOCK[t];
              patch('trigger_type', t);
              if (lock) patch('channels', [lock]);
              // A channel-less trigger hides the picker, so any scope left
              // over from the previous trigger would sit there unseen and
              // silently stop the automation firing. Clearing it is what
              // makes hiding the picker safe.
              else if (CHANNELLESS_TRIGGERS.has(t)) patch('channels', []);
            }}
            onTriggerConfigChange={(c) => patch('trigger_config', c)}
          onChannelsChange={(c) => patch('channels', c)}
        />
      </div>
    </div>
  );
}

/**
 * Triggers that only make sense on one channel.
 *
 * Mirrors TRIGGER_CHANNEL_LOCK in
 * apps/api/src/automations/automation.types.ts. `form_submitted` and the
 * appointment triggers are deliberately absent: a hosted submission or a
 * booking made on a public page has no channel, so locking them to one
 * would mean they never fire.
 */
const TRIGGER_CHANNEL_LOCK: Partial<Record<AutomationTriggerType, string>> = {
  instagram_comment: 'instagram',
  instagram_story_reply: 'instagram',
  web_chat_started: 'web',
};

/**
 * Triggers whose event carries no channel, so a channel scope can only
 * silence them.
 *
 * Mirrors `channelless` on TRIGGER_OPTIONS in canvas/trigger-inspector.tsx,
 * which hides the picker; this clears whatever the picker left behind.
 * Neither `FormSubmitService.fanOut` nor `BookingService.fanOut` sets
 * `context.channel`, so the dispatcher's `toChannel(undefined)` resolves
 * these to DEFAULT_CHANNEL — any explicit scope that is not WhatsApp
 * therefore matches nothing, permanently and with nothing logged.
 */
const CHANNELLESS_TRIGGERS = new Set<AutomationTriggerType>([
  'form_submitted',
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
]);

export { STEP_META };
