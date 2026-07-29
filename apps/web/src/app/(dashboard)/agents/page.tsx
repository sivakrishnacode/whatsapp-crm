'use client';

import { useEffect, useState } from 'react';
import { Bot, Sparkles, Settings2, BookOpen } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { AiKnowledge } from '@/components/agents/ai-knowledge';

type Tab = 'playground' | 'knowledge' | 'setup';

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // The Web channel panel's "Knowledge Base" row links to `?tab=knowledge`.
  // Honouring it is what lets one shared surface serve every channel's nav
  // without the corpus being duplicated per channel.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'knowledge' || requested === 'setup') {
      setTab(requested);
      setDecided(true);
    }
  }, []);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          AI Agents
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Your bring-your-own-key AI agent — set it up, then test it in the
        playground before it replies to customers in the inbox.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            <TabsTrigger value="knowledge">
              <BookOpen className="mr-1.5 h-4 w-4" /> Knowledge
            </TabsTrigger>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Setup
            </TabsTrigger>
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="knowledge" className="mt-4">
            <AiKnowledge />
          </TabsContent>

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
