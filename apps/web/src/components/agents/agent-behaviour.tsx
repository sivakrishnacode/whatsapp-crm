'use client';

import { useState } from 'react';
import { Loader2, PhoneCall, Power, Save, UserCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ChipInput } from './chip-input';
import type { AgentStudio } from '@/lib/agents/types';

interface Draft {
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_max_per_conversation: number;
  fallback_message: string;
  handoff_enabled: boolean;
  handoff_trigger_phrases: string[];
  handoff_message: string;
  test_mode: boolean;
  test_numbers: string[];
  system_prompt: string;
}

function toDraft(studio: AgentStudio): Draft {
  return {
    is_active: studio.is_active ?? false,
    auto_reply_enabled: studio.auto_reply_enabled ?? false,
    auto_reply_max_per_conversation: studio.auto_reply_max_per_conversation ?? 3,
    fallback_message: studio.fallback_message ?? '',
    handoff_enabled: studio.handoff_enabled ?? false,
    handoff_trigger_phrases: studio.handoff_trigger_phrases ?? [],
    handoff_message: studio.handoff_message ?? '',
    test_mode: studio.test_mode ?? false,
    test_numbers: studio.test_numbers ?? [],
    system_prompt: studio.system_prompt ?? '',
  };
}

/**
 * When the agent speaks, when it stops, and who it is allowed to speak to.
 *
 * The test-number allowlist is the honest form of "try before you go
 * live": with it on, the agent answers ONLY those numbers and every other
 * customer is left for a human. There is no message quota here — this is
 * bring-your-own-key, the provider bills the workspace directly, and a
 * cap we invented would be theatre.
 */
export function AgentBehaviour({
  studio,
  canEdit,
  saving,
  onSave,
}: {
  studio: AgentStudio;
  canEdit: boolean;
  saving: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(studio));
  const [dirty, setDirty] = useState(false);
  const [syncedFrom, setSyncedFrom] = useState(studio);

  // Adjust during render, not in an effect — see the note in
  // agent-persona.tsx. Unsaved edits always win over a refetch.
  if (studio !== syncedFrom) {
    setSyncedFrom(studio);
    if (!dirty) setDraft(toDraft(studio));
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    const ok = await onSave({
      is_active: draft.is_active,
      auto_reply_enabled: draft.auto_reply_enabled,
      auto_reply_max_per_conversation: draft.auto_reply_max_per_conversation,
      fallback_message: draft.fallback_message.trim() || null,
      handoff_enabled: draft.handoff_enabled,
      handoff_trigger_phrases: draft.handoff_trigger_phrases,
      handoff_message: draft.handoff_message.trim() || null,
      test_mode: draft.test_mode,
      test_numbers: draft.test_numbers,
      system_prompt: draft.system_prompt.trim() || null,
    });
    if (ok) setDirty(false);
  };

  const disabled = !canEdit || saving;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Power className="size-4 text-primary" /> Switches
          </CardTitle>
          <CardDescription>
            What the agent is allowed to do right now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            title="Agent enabled"
            hint="Master switch. Turns on “Draft with AI” in the inbox."
            checked={draft.is_active}
            onChange={(v) => set('is_active', v)}
            disabled={disabled}
          />

          <ToggleRow
            title="Answer inbound messages automatically"
            hint="Replies to new messages when no flow handles them and no agent is assigned. Hands off when it can’t help."
            checked={draft.auto_reply_enabled}
            onChange={(v) => set('auto_reply_enabled', v)}
            disabled={disabled || !draft.is_active}
          />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="max-replies">Max replies per conversation</Label>
              <p className="text-xs text-muted-foreground">
                After this many agent replies in one thread, it goes quiet and
                waits for a human.
              </p>
            </div>
            <Input
              id="max-replies"
              type="number"
              min={1}
              max={20}
              value={draft.auto_reply_max_per_conversation}
              onChange={(e) =>
                set(
                  'auto_reply_max_per_conversation',
                  Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                )
              }
              disabled={disabled || !draft.auto_reply_enabled}
              className="w-20"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PhoneCall className="size-4 text-primary" /> Try it on your own number first
          </CardTitle>
          <CardDescription>
            With this on, the agent answers only the numbers below. Everyone else
            is left for your team.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            title="Test mode"
            hint={
              draft.test_numbers.length === 0
                ? 'Add a number below first — with none listed, the agent would answer nobody.'
                : `Only ${draft.test_numbers.length} number(s) get automatic replies.`
            }
            checked={draft.test_mode}
            onChange={(v) => set('test_mode', v)}
            disabled={disabled || draft.test_numbers.length === 0}
          />

          <div className="space-y-1.5">
            <Label>Test numbers</Label>
            <ChipInput
              values={draft.test_numbers}
              onChange={(next) => {
                set('test_numbers', next);
                if (next.length === 0) set('test_mode', false);
              }}
              placeholder="+91 98765 43210"
              inputMode="tel"
              max={3}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Include the country code. Test mode is phone-based, so it silences
              the agent on Instagram DMs and the website widget too.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCircle2 className="size-4 text-primary" /> When it can’t help
          </CardTitle>
          <CardDescription>
            The two dead ends — a question it cannot answer, and a customer who
            wants a person.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fallback">Fallback message</Label>
            <Textarea
              id="fallback"
              value={draft.fallback_message}
              onChange={(e) => set('fallback_message', e.target.value)}
              placeholder="e.g. Let me check that and get back to you shortly."
              rows={2}
              disabled={disabled}
              maxLength={600}
            />
            <p className="text-xs text-muted-foreground">
              Used as the agent’s wording when it has no answer, and sent as-is if
              the AI provider itself fails. Leave blank to stay silent rather than
              apologise in a voice you didn’t choose.
            </p>
          </div>

          <ToggleRow
            title="Hand off to a human"
            hint="Stops the agent on that conversation so your team can take over."
            checked={draft.handoff_enabled}
            onChange={(v) => set('handoff_enabled', v)}
            disabled={disabled}
          />

          <div className="space-y-1.5">
            <Label>Phrases that always hand off</Label>
            <ChipInput
              values={draft.handoff_trigger_phrases}
              onChange={(next) => set('handoff_trigger_phrases', next)}
              placeholder="talk to a human"
              max={12}
              disabled={disabled || !draft.handoff_enabled}
            />
            <p className="text-xs text-muted-foreground">
              Matched anywhere in the message, ignoring case. These skip the model
              entirely — “talk to a human” shouldn’t depend on the AI agreeing.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handoff-message">Handoff message</Label>
            <Textarea
              id="handoff-message"
              value={draft.handoff_message}
              onChange={(e) => set('handoff_message', e.target.value)}
              placeholder="e.g. Putting you through to a colleague — they’ll reply here shortly."
              rows={2}
              disabled={disabled || !draft.handoff_enabled}
              maxLength={600}
            />
            <p className="text-xs text-muted-foreground">
              Sent to the customer as the agent steps back. Leave blank to hand
              off silently.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Extra instructions</CardTitle>
          <CardDescription>
            Anything the fields above don’t cover. Applied after the persona, so
            it can add to the rules but not override your ground rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="system-prompt"
            value={draft.system_prompt}
            onChange={(e) => set('system_prompt', e.target.value)}
            placeholder="e.g. If someone asks about wholesale, tell them to email trade@acme.com."
            rows={5}
            disabled={disabled}
            maxLength={8000}
            className="font-mono text-xs"
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        <Button onClick={save} disabled={disabled || !dirty}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save behaviour
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={title}
      />
    </div>
  );
}
