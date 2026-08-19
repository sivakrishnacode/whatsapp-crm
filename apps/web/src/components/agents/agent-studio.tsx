'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Loader2,
  MessageSquare,
  Plug,
  Route,
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
import { AgentRouting } from './agent-routing';
import { AgentReadiness, type StudioTab } from './agent-readiness';
import { AiPlayground } from './ai-playground';

const TAB_QUERY: Record<string, StudioTab> = {
  persona: 'persona',
  knowledge: 'knowledge',
  skills: 'skills',
  actions: 'actions',
  behaviour: 'behaviour',
  routing: 'routing',
  // The Web channel panel and older links point at these. `setup` used
  // to mean the provider key, which is now a workspace setting reached
  // from the agent list — Routing is the nearest thing that is still
  // about this agent.
  setup: 'routing',
  provider: 'routing',
  playground: 'persona',
};

/**
 * ============================================================
 * Agent Studio — one agent.
 *
 * The tabs follow the order someone actually builds an agent in — who it
 * is, what it knows, what it can do, what it can reach, when it stops,
 * where it answers — rather than grouping by which table a field lives
 * in.
 *
 * The header carries a READINESS CHECKLIST rather than a status word
 * alone, because "why is my bot silent?" is the question this screen
 * exists to answer and the reasons are spread across five tabs. It
 * mirrors the run-time gates exactly (see agent-readiness.tsx).
 *
 * The test panel is a drawer, not a tab: you want to try a change
 * immediately after making it, and a tab would mean leaving the form you
 * just edited. It is reachable from every tab for the same reason.
 * ============================================================
 */
export function AgentStudio({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const { studio, loading, saving, missing, reload, patch, setLibrary } =
    useAgentStudio(accountId, agentId);

  const searchParams = useSearchParams();
  const requested = TAB_QUERY[searchParams.get('tab') ?? ''];

  const [tab, setTab] = useState<StudioTab>(requested ?? 'persona');
  const [testOpen, setTestOpen] = useState(false);
  /**
   * Whether the workspace's Apps Script bridge is set up.
   *
   * Undefined until it loads, and readiness treats that as "no claim" —
   * a checklist that flashes a warning on every page load is one people
   * learn to ignore. Fetched here rather than folded into the studio
   * payload because it is a WORKSPACE fact, shared by every agent, and
   * the studio endpoint is per-agent.
   */
  const [googleConnected, setGoogleConnected] = useState<boolean | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/google-script', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connection?: { connected?: boolean } } | null) => {
        if (!cancelled) setGoogleConnected(Boolean(data?.connection?.connected));
      })
      // Silence is correct: a failed status check must not put a warning
      // on the agent, which has nothing to do with it.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (missing) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center">
        <p className="text-sm font-medium text-foreground">
          That agent no longer exists.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          It may have been deleted by someone else in your workspace.
        </p>
        <Button className="mt-4" variant="outline" onClick={() => router.push('/agents')}>
          <ArrowLeft className="size-4" />
          Back to agents
        </Button>
      </div>
    );
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
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All agents
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="size-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {studio.name?.trim() || 'AI agent'}
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

      <div className="mt-4">
        <AgentReadiness
          studio={studio}
          onGoToTab={setTab}
          googleConnected={googleConnected}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as StudioTab)}
        className="mt-6"
      >
        <TabsList className="flex-wrap">
          <TabsTrigger value="persona">
            <Sparkles className="size-4" /> Persona
          </TabsTrigger>
          <TabsTrigger value="knowledge">
            <BookOpen className="size-4" /> Knowledge
            {studio.knowledge.selected > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                {studio.knowledge.selected}
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
          <TabsTrigger value="routing">
            <Route className="size-4" /> Routing
          </TabsTrigger>
        </TabsList>

        <TabsContent value="persona" className="mt-4">
          <AgentPersona
            studio={studio}
            canEdit={canEdit}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <AgentKnowledge
            studio={studio}
            canEdit={canEdit}
            onChanged={reload}
            onSaveSelection={(documentIds) =>
              setLibrary(
                { document_ids: documentIds },
                { successMessage: 'Knowledge selection saved.' },
              )
            }
            onUseAll={() => patch({ uses_all_knowledge: true })}
          />
        </TabsContent>

        <TabsContent value="skills" className="mt-4">
          <AgentSkills
            studio={studio}
            canEdit={canEdit}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="actions" className="mt-4">
          <AgentActions
            studio={studio}
            canEdit={canEdit}
            onChanged={reload}
            onSaveSelection={(actionIds) =>
              setLibrary(
                { action_ids: actionIds },
                { successMessage: 'Action selection saved.' },
              )
            }
            onUseAll={() => patch({ uses_all_actions: true })}
          />
        </TabsContent>

        <TabsContent value="behaviour" className="mt-4">
          <AgentBehaviour
            studio={studio}
            canEdit={canEdit}
            saving={saving}
            onSave={patch}
          />
        </TabsContent>

        <TabsContent value="routing" className="mt-4">
          <AgentRouting
            studio={studio}
            canEdit={canEdit}
            saving={saving}
            onSave={patch}
          />
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
              Test {studio.name}
            </SheetTitle>
            <SheetDescription>
              Same prompt, knowledge and tools as this agent uses live. No
              customer is attached, and nothing is sent.
            </SheetDescription>
          </SheetHeader>

          <AiPlayground
            agentId={agentId}
            className="min-h-0 flex-1"
            onGoToSetup={() => {
              setTestOpen(false);
              setTab('routing');
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * One honest sentence about what the agent is doing right now. The
 * ordering matters: "no key" beats "off" beats "test mode" beats
 * "drafts only", because that is the order in which each fact stops the
 * agent from answering a customer.
 */
function resolveStatus(studio: {
  configured: boolean;
  is_active?: boolean;
  auto_reply_enabled?: boolean;
  test_mode?: boolean;
  test_numbers?: string[];
  channels?: string[];
}): {
  label: string;
  hint: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  className?: string;
} {
  if (!studio.configured) {
    return {
      label: 'Not connected',
      hint: 'This workspace has no provider key stored, so nothing can run. Add one under Provider & credits.',
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

  const where =
    studio.channels && studio.channels.length > 0
      ? studio.channels.join(', ')
      : 'every connected channel';

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
      className: 'border-amber-500/40 text-accent-amber',
    };
  }
  return {
    label: 'Live',
    hint: `Answering inbound messages automatically on ${where}.`,
    variant: 'default',
    className: 'bg-green-600 text-white',
  };
}
