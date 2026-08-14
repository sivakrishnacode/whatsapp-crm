'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Heart, Loader2, Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { channelScopeLabel, runsOnInstagram } from '@/lib/instagram/intents';
import { cn } from '@/lib/utils';

interface Automation {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: { keywords?: string[]; match_type?: string } | null;
  /** Empty = every channel. Non-empty restricts. See migration 052. */
  channels: string[];
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
 * keyword rules that reach Instagram, with the Instagram-specific
 * reach (comments as well as DMs) spelled out.
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

  const keywordRules = automations.filter(
    (a) => a.trigger_type === 'keyword_match'
  );
  const intents = keywordRules.filter(runsOnInstagram);
  // Keyword rules that exist but are scoped away from Instagram. Worth
  // naming: "I definitely made one of these" is otherwise a confusing
  // way to look at an empty page.
  const otherChannelCount = keywordRules.length - intents.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-lg font-semibold">Intents</h1>
          <p className="text-muted-foreground text-sm">
            Keyword rules that route a message to the right response.
          </p>
        </div>
        <Button size="sm" onClick={() => router.push('/automations/new')}>
          <Plus className="size-4" />
          New intent
        </Button>
      </div>

      <div className="border-border bg-card text-muted-foreground rounded-xl border p-4 text-xs">
        Intents are{' '}
        <Link href="/automations" className="text-primary hover:underline">
          automations
        </Link>{' '}
        with a keyword trigger. On Instagram they match both{' '}
        <strong className="text-foreground">direct messages</strong> and{' '}
        <strong className="text-foreground">comments</strong> — which is what
        makes the &ldquo;comment a keyword, get a DM&rdquo; pattern work.
        {otherChannelCount > 0 && (
          <>
            {' '}
            {otherChannelCount} other keyword rule
            {otherChannelCount === 1 ? ' is' : 's are'} scoped to another
            channel and {otherChannelCount === 1 ? 'does' : 'do'} not run here.
          </>
        )}
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading intents…
        </div>
      ) : intents.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed p-10 text-center">
          <Heart className="text-muted-foreground mx-auto size-8" />
          <p className="text-foreground mt-3 text-sm font-medium">
            No intents yet
          </p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
            {otherChannelCount > 0 ? (
              <>
                You have {otherChannelCount} keyword rule
                {otherChannelCount === 1 ? '' : 's'}, but{' '}
                {otherChannelCount === 1 ? 'it is' : 'none are'} set to run on
                Instagram. Add Instagram to{' '}
                {otherChannelCount === 1 ? 'its' : 'their'} channels, or create
                a new one.
              </>
            ) : (
              <>
                A common first one: reply with a link whenever someone comments
                or DMs &ldquo;price&rdquo;. Create an automation with a{' '}
                <strong>keyword match</strong> trigger.
              </>
            )}
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
    <li className="border-border bg-card rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/automations/${intent.id}/edit`}
              className="text-foreground font-medium hover:underline"
            >
              {intent.name}
            </Link>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                intent.is_active
                  ? 'bg-green-500/10 text-accent-green'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {intent.is_active ? 'Active' : 'Paused'}
            </span>

            {/* Makes the page's filter legible: a rule is here either
                because it is Instagram-scoped or because it is unscoped
                and therefore runs everywhere. */}
            <span
              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium"
              title="Which channels this rule runs on"
            >
              {channelScopeLabel(intent.channels ?? [])}
            </span>
          </div>

          {intent.description && (
            <p className="text-muted-foreground mt-1 text-xs">
              {intent.description}
            </p>
          )}

          {keywords.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
                <span
                  key={kw}
                  className="bg-muted text-foreground rounded-md px-2 py-0.5 font-mono text-[11px]"
                >
                  {kw}
                </span>
              ))}
            </div>
          ) : (
            // A keyword rule with no keywords matches nothing and will
            // never fire — worth saying, since the row otherwise looks
            // perfectly healthy.
            <p className="mt-2 text-xs text-accent-amber">
              No keywords configured — this intent can never match.
            </p>
          )}
        </div>

        <div className="text-muted-foreground shrink-0 text-right text-xs">
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
