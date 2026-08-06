'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Bot, Globe, Loader2, Save, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  LENGTH_LABELS,
  TONE_LABELS,
  type AgentStudio,
  type AgentTone,
  type ResponseLength,
} from '@/lib/agents/types';

interface Draft {
  agent_name: string;
  greeting_message: string;
  business_website: string;
  business_description: string;
  ground_rules: string;
  store_currency: string;
  tone: AgentTone;
  response_length: ResponseLength;
  tone_instructions: string;
}

function toDraft(studio: AgentStudio): Draft {
  return {
    agent_name: studio.agent_name ?? '',
    greeting_message: studio.greeting_message ?? '',
    business_website: studio.business_website ?? '',
    business_description: studio.business_description ?? '',
    ground_rules: studio.ground_rules ?? '',
    store_currency: studio.store_currency ?? '',
    tone: studio.tone ?? 'friendly',
    response_length: studio.response_length ?? 'medium',
    tone_instructions: studio.tone_instructions ?? '',
  };
}

/**
 * Who the agent is and how it sounds.
 *
 * These used to be one textarea (`system_prompt`). Split, because a
 * business's hard limits ("never promise same-day delivery") deserve to
 * outrank its description in the composed prompt, and one field cannot
 * express precedence. The old textarea is still saved and still honoured
 * — see the Behaviour tab for where it now lives.
 */
export function AgentPersona({
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
  const [drafting, setDrafting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [syncedFrom, setSyncedFrom] = useState(studio);

  // Adjust state during render (React's documented pattern for "a prop
  // changed and this state derives from it") rather than in an effect,
  // which would render the stale form once before correcting it. Never
  // over unsaved edits — a refetch must not eat what someone is typing.
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
      agent_name: draft.agent_name.trim() || null,
      greeting_message: draft.greeting_message.trim() || null,
      business_website: draft.business_website.trim() || null,
      business_description: draft.business_description.trim() || null,
      ground_rules: draft.ground_rules.trim() || null,
      store_currency: draft.store_currency.trim() || null,
      tone: draft.tone,
      response_length: draft.response_length,
      tone_instructions: draft.tone_instructions.trim() || null,
    });
    if (ok) setDirty(false);
  };

  /**
   * Read the website and draft the description from it. The result lands
   * in the textarea as an unsaved edit — a summary of a homepage is a
   * suggestion, and only the business knows whether it is true of them.
   */
  const draftFromSite = async () => {
    const url = draft.business_website.trim();
    if (!url) {
      toast.error('Add your website address first.');
      return;
    }
    setDrafting(true);
    try {
      const res = await fetch('/api/ai/agent/draft-from-site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not read that website.');
        return;
      }
      if (data.thin) {
        toast.warning(
          'That page did not say much about the business — write the description yourself, or point this at an About page.',
        );
        return;
      }
      set('business_description', data.description as string);
      toast.success('Drafted from your website — check it, then save.');
    } catch {
      toast.error('Could not read that website.');
    } finally {
      setDrafting(false);
    }
  };

  const disabled = !canEdit || saving;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-primary" /> Identity
          </CardTitle>
          <CardDescription>
            What the agent calls itself, and how it opens a conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Agent name</Label>
              <Input
                id="agent-name"
                value={draft.agent_name}
                onChange={(e) => set('agent_name', e.target.value)}
                placeholder="e.g. Nova"
                disabled={disabled}
                maxLength={60}
              />
              <p className="text-xs text-muted-foreground">
                Used if a customer asks who they are talking to. The agent never
                claims to be human.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="store-currency">Currency</Label>
              <Input
                id="store-currency"
                value={draft.store_currency}
                onChange={(e) => set('store_currency', e.target.value.toUpperCase())}
                placeholder="INR"
                disabled={disabled}
                maxLength={3}
                className="uppercase"
              />
              <p className="text-xs text-muted-foreground">
                Three-letter code. The agent states it whenever it quotes a
                price.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="greeting">Greeting</Label>
            <Textarea
              id="greeting"
              value={draft.greeting_message}
              onChange={(e) => set('greeting_message', e.target.value)}
              placeholder="e.g. Hi! Thanks for messaging Acme Coffee."
              rows={2}
              disabled={disabled}
              maxLength={600}
            />
            <p className="text-xs text-muted-foreground">
              Sent in front of the agent’s first reply on a conversation — not
              as a message of its own, which would read as a bot.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4 text-primary" /> The business
          </CardTitle>
          <CardDescription>
            The agent answers from this plus your knowledge base — nothing else.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="website">Website</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="website"
                value={draft.business_website}
                onChange={(e) => set('business_website', e.target.value)}
                placeholder="acme.com"
                disabled={disabled}
                inputMode="url"
              />
              <Button
                type="button"
                variant="outline"
                onClick={draftFromSite}
                disabled={disabled || drafting || !draft.business_website.trim()}
                className="shrink-0"
              >
                {drafting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Wand2 className="size-4" />
                )}
                Draft description
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              “Draft description” reads this one page and writes the summary
              below. It never saves on its own — read it first.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">What the business does</Label>
            <Textarea
              id="description"
              value={draft.business_description}
              onChange={(e) => set('business_description', e.target.value)}
              placeholder="e.g. Acme Coffee sells espresso machines and beans to cafés across South India, with installation and servicing in Chennai and Bengaluru."
              rows={5}
              disabled={disabled}
              maxLength={4000}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ground-rules">Ground rules</Label>
            <Textarea
              id="ground-rules"
              value={draft.ground_rules}
              onChange={(e) => set('ground_rules', e.target.value)}
              placeholder={
                'One rule per line, e.g.\nNever promise same-day delivery.\nNever quote a discount above 10%.\nAlways mention that installation is chargeable.'
              }
              rows={5}
              disabled={disabled}
              maxLength={4000}
            />
            <p className="text-xs text-muted-foreground">
              Absolute limits. These outrank every other instruction, including
              anything a knowledge document implies.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" /> Voice
          </CardTitle>
          <CardDescription>How replies sound, and how long they run.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Tone</Label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(Object.keys(TONE_LABELS) as AgentTone[]).map((tone) => {
                const active = draft.tone === tone;
                return (
                  <button
                    key={tone}
                    type="button"
                    onClick={() => set('tone', tone)}
                    disabled={disabled}
                    aria-pressed={active}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                      active
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40',
                    )}
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {TONE_LABELS[tone].label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {TONE_LABELS[tone].hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Reply length</Label>
            <div className="inline-flex rounded-lg border border-border p-1">
              {(Object.keys(LENGTH_LABELS) as ResponseLength[]).map((length) => {
                const active = draft.response_length === length;
                return (
                  <button
                    key={length}
                    type="button"
                    onClick={() => set('response_length', length)}
                    disabled={disabled}
                    aria-pressed={active}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-60',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {LENGTH_LABELS[length].label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {LENGTH_LABELS[draft.response_length].hint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tone-instructions">Extra voice notes</Label>
            <Textarea
              id="tone-instructions"
              value={draft.tone_instructions}
              onChange={(e) => set('tone_instructions', e.target.value)}
              placeholder="e.g. Use “₹” not “Rs.”. Never say “unfortunately”. Sign off with the shop name."
              rows={3}
              disabled={disabled}
              maxLength={1500}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {dirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
        <Button onClick={save} disabled={disabled || !dirty}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save persona
        </Button>
      </div>
    </div>
  );
}
