'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Heart, Loader2, Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Automation {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: { keywords?: string[]; match_type?: string } | null;
  is_active: boolean;
  execution_count: number;
  last_executed_at: string | null;
}

/**
 * Keyword intents — "when someone says X, do Y".
 *
 * This is a *view* over the shared Automations engine, not a second
 * rules system. Every row here is an automation with a `keyword_match`
 * trigger; creating and editing happens in the Automations builder.
 *
 * Why a view rather than its own store: an intent is exactly what
 * `keyword_match` already models, and a parallel implementation would
 * mean two engines racing to answer the same message, two places to
 * look when one misfires, and rules that work on WhatsApp but not
 * Instagram. The value this page adds is framing — surfacing the
 * keyword rules on their own, with the Instagram-specific reach
 * (comments as well as DMs) spelled out.
 */
export function InstagramIntents() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/automations', { cache: 'no-store' });
        const data = await res.json();
        if (!cancelled) setAutomations(data.automations ?? []);
      } catch {
        if (!cancelled) toast.error('Could not load intents.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const intents = automations.filter((a) => a.trigger_type === 'keyword_match');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Intents</h1>
          <p className="text-sm text-muted-foreground">
            Keyword rules that route a message to the right response.
          </p>
        </div>
        <Button size="sm" onClick={() => router.push('/automations/new')}>
          <Plus className="size-4" />
          New intent
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        Intents are{' '}
        <Link href="/automations" className="text-primary hover:underline">
          automations
        </Link>{' '}
        with a keyword trigger, shared with WhatsApp. On Instagram they match
        both <strong className="text-foreground">direct messages</strong> and{' '}
        <strong className="text-foreground">comments</strong> — which is what
        makes the &ldquo;comment a keyword, get a DM&rdquo; pattern work.
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading intents…
        </div>
      ) : intents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Heart className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No intents yet
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            A common first one: reply with a link whenever someone comments or
            DMs &ldquo;price&rdquo;. Create an automation with a{' '}
            <strong>keyword match</strong> trigger.
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => router.push('/automations/new')}
          >
            <Plus className="size-4" />
            Create an intent
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {intents.map((intent) => (
            <IntentCard key={intent.id} intent={intent} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IntentCard({ intent }: { intent: Automation }) {
  const keywords = intent.trigger_config?.keywords ?? [];

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/automations/${intent.id}/edit`}
              className="font-medium text-foreground hover:underline"
            >
              {intent.name}
            </Link>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                intent.is_active
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {intent.is_active ? 'Active' : 'Paused'}
            </span>
          </div>

          {intent.description && (
            <p className="mt-1 text-xs text-muted-foreground">
              {intent.description}
            </p>
          )}

          {keywords.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
                <span
                  key={kw}
                  className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {kw}
                </span>
              ))}
            </div>
          ) : (
            // A keyword rule with no keywords matches nothing and will
            // never fire — worth saying, since the row otherwise looks
            // perfectly healthy.
            <p className="mt-2 text-xs text-amber-600">
              No keywords configured — this intent can never match.
            </p>
          )}
        </div>

        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <p className="flex items-center justify-end gap-1">
            <Zap className="size-3" />
            {intent.execution_count} run
            {intent.execution_count === 1 ? '' : 's'}
          </p>
          {intent.last_executed_at && (
            <p className="mt-0.5">
              last {new Date(intent.last_executed_at).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
