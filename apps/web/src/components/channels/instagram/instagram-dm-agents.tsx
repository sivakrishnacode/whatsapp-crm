'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  Settings2,
  Workflow,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AiConfigStatus {
  configured: boolean;
  is_active?: boolean;
  auto_reply_enabled?: boolean;
  provider?: string;
  model?: string;
  auto_reply_max_per_conversation?: number;
}

interface Automation {
  id: string;
  name: string;
  trigger_type: string;
  is_active: boolean;
  execution_count: number;
}

/**
 * Which agent answers an Instagram DM, and in what order.
 *
 * This page deliberately does NOT host a second AI configuration. The
 * assistant is account-level (`ai_configs` is UNIQUE per account) and
 * shared with WhatsApp — duplicating the setup form here would imply a
 * per-channel model/key that does not exist, and two forms writing one
 * row is a bug waiting to happen.
 *
 * What is genuinely Instagram-specific is the *behaviour*: the reply
 * window, echo suppression, and which handler wins. That is what this
 * page explains, alongside a live view of what is currently switched
 * on and links to the shared editors.
 */
export function InstagramDmAgents() {
  const [ai, setAi] = useState<AiConfigStatus | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [aiRes, autoRes] = await Promise.allSettled([
        fetch('/api/ai/config', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/automations', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;

      if (aiRes.status === 'fulfilled') setAi(aiRes.value);
      if (autoRes.status === 'fulfilled') {
        setAutomations(autoRes.value?.automations ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading DM agents…
      </div>
    );
  }

  const aiLive = Boolean(ai?.configured && ai?.is_active && ai?.auto_reply_enabled);

  // The engines that can answer an inbound DM, in the order the webhook
  // consults them. Message-producing automations are the ones that
  // matter here — a tag-only automation is not an "agent".
  const messageTriggers = new Set([
    'new_message_received',
    'keyword_match',
    'first_inbound_message',
  ]);
  const activeAutomations = automations.filter(
    (a) => a.is_active && messageTriggers.has(a.trigger_type),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">DM Agents</h1>
        <p className="text-sm text-muted-foreground">
          What answers an Instagram DM when nobody on your team has yet.
        </p>
      </div>

      {/* Precedence is the single most useful thing to state. Without
          it, an operator with a flow AND the AI bot on cannot predict
          which one replies — and will assume it is broken. */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Who replies first
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every inbound Instagram DM is offered to these in order. The first
          one that handles the message stops the rest — so a customer gets
          one reply, not three.
        </p>

        <ol className="mt-4 space-y-3">
          <PrecedenceRow
            step={1}
            icon={Workflow}
            title="Flows"
            live={null}
            href="/flows"
            description="If the customer is mid-flow, or their message matches a flow's entry trigger, the flow answers and everything below is skipped."
          />
          <PrecedenceRow
            step={2}
            icon={Zap}
            title="Automations"
            live={activeAutomations.length > 0}
            href="/automations"
            description={
              activeAutomations.length > 0
                ? `${activeAutomations.length} active rule${activeAutomations.length === 1 ? '' : 's'} can act on an inbound message.`
                : 'No active message-triggered rules. Keyword rules are set up under Intents.'
            }
          />
          <PrecedenceRow
            step={3}
            icon={Bot}
            title="AI assistant"
            live={aiLive}
            href="/agents"
            description={
              !ai?.configured
                ? 'Not set up yet. The AI assistant answers anything the rules above did not.'
                : aiLive
                  ? `${ai.model ?? ai.provider ?? 'Configured'} · replies at most ${ai.auto_reply_max_per_conversation ?? 3} times per conversation.`
                  : 'Configured but auto-reply is off, so it will not answer DMs on its own.'
            }
          />
        </ol>

        <p className="mt-4 text-xs text-muted-foreground">
          These are shared with WhatsApp — one assistant, one set of rules,
          working across both channels. Changing them here changes them
          everywhere.
        </p>
      </div>

      <InstagramCaveats />

      {activeAutomations.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">
            Active message rules
          </h2>
          <ul className="mt-3 divide-y divide-border">
            {activeAutomations.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <Link
                    href={`/automations/${a.id}/edit`}
                    className="truncate text-sm text-foreground hover:underline"
                  >
                    {a.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {a.trigger_type.replace(/_/g, ' ')} · ran{' '}
                    {a.execution_count} time{a.execution_count === 1 ? '' : 's'}
                  </p>
                </div>
                <CheckCircle2 className="size-4 shrink-0 text-accent-green" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PrecedenceRow({
  step,
  icon: Icon,
  title,
  live,
  description,
  href,
}: {
  step: number;
  icon: typeof Bot;
  title: string;
  /** null when the state isn't a simple on/off. */
  live: boolean | null;
  description: string;
  href: string;
}) {
  const router = useRouter();

  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
        {step}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{title}</span>
          {live !== null && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                live
                  ? 'bg-green-500/10 text-accent-green'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {live ? 'Active' : 'Off'}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => router.push(href)}
        >
          <Settings2 className="size-3" />
          Configure
        </Button>
      </div>
    </li>
  );
}

/**
 * The rules that make an Instagram agent behave differently from the
 * same agent on WhatsApp. Each of these produces a "why didn't the bot
 * reply?" question if it isn't stated up front.
 */
function InstagramCaveats() {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-amber" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            How agents behave differently on Instagram
          </h2>
          <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
            <li>
              <strong className="text-foreground">
                Nothing replies outside the 24-hour window.
              </strong>{' '}
              Agents can only answer within 24 hours of the customer&apos;s
              last message. Unlike WhatsApp there is no template to re-open a
              closed thread, so a rule that fires late simply cannot send.
            </li>
            <li>
              <strong className="text-foreground">
                Replies you send from the Instagram app do not trigger agents.
              </strong>{' '}
              They arrive back as echo events and appear in the inbox, but are
              deliberately ignored by the engines — otherwise the assistant
              would answer your own messages.
            </li>
            <li>
              <strong className="text-foreground">
                Template and catalogue steps are skipped.
              </strong>{' '}
              Instagram supports neither. A shared automation containing one
              of those steps still runs; that step is refused with a logged
              reason rather than sending something unintended.
            </li>
            <li>
              <strong className="text-foreground">
                List messages are not supported.
              </strong>{' '}
              A flow that reaches a list step on an Instagram thread ends with
              an error instead of silently dropping options. Use a buttons
              step — Instagram allows up to 13 quick replies.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
