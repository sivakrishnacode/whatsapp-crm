'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Bot,
  BookOpen,
  KeyRound,
  Loader2,
  MessageSquare,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { useAgentStudio } from '@/hooks/use-agent-studio';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';

import { AgentPersona } from './agent-persona';
import { AgentSkills } from './agent-skills';
import { AgentKnowledge } from './agent-knowledge';
import { AgentActions } from './agent-actions';
import { AgentBehaviour } from './agent-behaviour';
import { AiPlayground } from './ai-playground';
import { AiConfig } from '@/components/settings/ai-config';

type Tab = 'persona' | 'knowledge' | 'skills' | 'actions' | 'behaviour' | 'provider';

const TAB_QUERY: Record<string, Tab> = {
  persona: 'persona',
  knowledge: 'knowledge',
  skills: 'skills',
  actions: 'actions',
  behaviour: 'behaviour',
  provider: 'provider',
  // The Web channel panel and older links point at these.
  setup: 'provider',
  playground: 'persona',
};

/**
 * ============================================================
 * Agent Studio.
 *
 * The tabs follow the order someone actually builds an agent in — who it
 * is, what it knows, what it can do, what it can reach, when it stops,
 * what powers it — rather than grouping by which table a field lives in.
 *
 * The test panel is a drawer, not a tab: you want to try a change
 * immediately after making it, and a tab would mean leaving the form you
 * just edited. It is reachable from every tab for the same reason.
 * ============================================================
 */
export function AgentStudio() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const { studio, loading, saving, reload, patch } = useAgentStudio(accountId);

  // `?tab=` is the deep-link contract — the Web channel's "Knowledge
  // Base" row points here, and so do older `?tab=setup` links.
  const searchParams = useSearchParams();
  const requested = TAB_QUERY[searchParams.get('tab') ?? ''];

  const [tab, setTab] = useState<Tab>(requested ?? 'persona');
  const [testOpen, setTestOpen] = useState(false);
  const [autoTabbed, setAutoTabbed] = useState(false);

  // With no key there is nothing worth doing on any other tab, so land on
  // Provider — once, and never over an explicit link or a tab the user
  // has since clicked. Adjusted during render rather than in an effect,
  // which would flash the wrong tab first.
  if (!autoTabbed && !requested && studio && !studio.configured) {
    setAutoTabbed(true);
    setTab('provider');
  }

  if (loading || profileLoading || !studio) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading your agent…
      </div>
    );
  }

  const status = resolveStatus(studio);

  return (
    // Capped and centred like Settings: every tab here is a form, and a
    // full-width text input on a 1080p monitor is unreadable. The cap sits
    // on the root so the header, the tab bar and all six panels line up.
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="size-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {studio.agent_name?.trim() || 'AI agent'}
            </h1>
            <Badge
              variant={status.variant}
              className={cn(status.className)}
              title={status.hint}
            >
              {status.label}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {status.hint}
          </p>
        </div>

        <Button variant="outline" onClick={() => setTestOpen(true)}>
          <MessageSquare className="size-4" />
          Test agent
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="mt-6"
      >
        <TabsList className="flex-wrap">
          <TabsTrigger value="persona">
            <Sparkles className="size-4" /> Persona
          </TabsTrigger>
          <TabsTrigger value="knowledge">
            <BookOpen className="size-4" /> Knowledge
            {studio.knowledge.total > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                {studio.knowledge.total}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="skills">
            <Zap className="size-4" /> Skills
          </TabsTrigger>
          <TabsTrigger value="actions">
            <Plug className="size-4" /> Actions
            {studio.actions_count > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                {studio.actions_count}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="behaviour">
            <SlidersHorizontal className="size-4" /> Behaviour
          </TabsTrigger>
          <TabsTrigger value="provider">
            <KeyRound className="size-4" /> Provider
          </TabsTrigger>
        </TabsList>

        {!studio.configured && tab !== 'provider' && (
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
            This workspace has no AI provider key yet, so nothing here is live.
            Add one on the Provider tab — Converse360 calls the provider with
            your key, so there are no per-seat AI fees.
          </p>
        )}

        <TabsContent value="persona" className="mt-4">
          <AgentPersona
            studio={studio}
            canEdit={canEdit && studio.configured}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <AgentKnowledge onChanged={reload} />
        </TabsContent>

        <TabsContent value="skills" className="mt-4">
          <AgentSkills
            studio={studio}
            canEdit={canEdit && studio.configured}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="actions" className="mt-4">
          <AgentActions onChanged={reload} />
        </TabsContent>

        <TabsContent value="behaviour" className="mt-4">
          <AgentBehaviour
            studio={studio}
            canEdit={canEdit && studio.configured}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="provider" className="mt-4">
          <AiConfig onSaved={reload} />
        </TabsContent>
      </Tabs>

      <Sheet open={testOpen} onOpenChange={setTestOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col p-0 sm:max-w-md"
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle className="flex items-center gap-2">
              <MessageSquare className="size-4 text-primary" />
              Test your agent
            </SheetTitle>
            <SheetDescription>
              Same prompt, knowledge and tools as the live agent. No customer is
              attached, and nothing is sent.
            </SheetDescription>
          </SheetHeader>

          <AiPlayground
            className="min-h-0 flex-1"
            onGoToSetup={() => {
              setTestOpen(false);
              setTab('provider');
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * One honest sentence about what the agent is doing right now. The
 * ordering matters: "no key" beats "paused" beats "test mode" beats
 * "drafts only", because that is the order in which each fact stops the
 * agent from answering a customer.
 */
function resolveStatus(studio: {
  configured: boolean;
  is_active?: boolean;
  auto_reply_enabled?: boolean;
  test_mode?: boolean;
  test_numbers?: string[];
}): {
  label: string;
  hint: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  className?: string;
} {
  if (!studio.configured) {
    return {
      label: 'Not connected',
      hint: 'Add an AI provider key to bring the agent to life.',
      variant: 'outline',
    };
  }
  if (!studio.is_active) {
    return {
      label: 'Off',
      hint: 'The agent is switched off. Nothing is drafted or auto-replied.',
      variant: 'secondary',
    };
  }
  if (!studio.auto_reply_enabled) {
    return {
      label: 'Drafts only',
      hint: 'Suggests replies in the inbox for a human to send. It never answers a customer on its own.',
      variant: 'outline',
    };
  }
  if (studio.test_mode) {
    const count = studio.test_numbers?.length ?? 0;
    return {
      label: 'Test mode',
      hint: `Answering automatically, but only your ${count} test number${count === 1 ? '' : 's'}. Everyone else is left for your team.`,
      variant: 'outline',
      className: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    };
  }
  return {
    label: 'Live',
    hint: 'Answering inbound messages automatically on every connected channel.',
    variant: 'default',
    className: 'bg-emerald-600 text-white',
  };
}
