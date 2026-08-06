'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRight,
  Bot,
  BookOpen,
  ChevronDown,
  Loader2,
  RotateCcw,
  Send,
  UserCircle2,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { PlaygroundResponse, ToolTraceEntry } from '@/lib/agents/types';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handoff?: boolean;
  grounded?: PlaygroundResponse['grounded_on'];
  toolCalls?: ToolTraceEntry[];
}

/**
 * Talk to the agent as a customer would.
 *
 * This runs the SAME assembly as the live auto-reply bot — same prompt,
 * same knowledge retrieval, same tools — because a test surface that
 * differs from production is worse than none: it teaches you to trust
 * behaviour you will not get.
 *
 * The two differences are deliberate and both visible here: there is no
 * customer attached (so contact-scoped tools say so rather than reading
 * someone's real orders), and nothing is sent to anyone.
 */
export function AiPlayground({
  onGoToSetup,
  className,
}: {
  onGoToSetup?: () => void;
  className?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only role + content — the server ignores anything else, and a
        // client must not be able to inject a fake tool result.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<PlaygroundResponse> & {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error('No agent configured yet — add your provider key first.');
        } else {
          toast.error(data.error ?? "Couldn't get a reply.");
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content: typeof data.reply === 'string' ? data.reply : '',
          handoff: Boolean(data.handoff),
          grounded: data.grounded_on ?? [],
          toolCalls: data.tool_calls ?? [],
        },
      ]);
    } catch {
      toast.error("Couldn't reach the agent.");
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="text-xs text-muted-foreground">
          Nothing here is sent to a customer.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="size-3.5" /> New chat
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center text-sm text-muted-foreground">
            <Bot className="mb-2 size-8 text-muted-foreground/60" />
            <p>Send a message to see how your agent would reply.</p>
            <p className="mt-1 text-xs">
              Same prompt, same knowledge and same tools as the live bot — and it
              shows you which documents it used.
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                Not set up yet? Add a provider key
                <ArrowRight className="size-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-1.5">
            <div
              className={cn(
                'flex gap-2',
                turn.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {turn.role === 'assistant' && (
                <Bot className="mt-1 size-5 shrink-0 text-primary" />
              )}
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                  turn.role === 'user'
                    ? 'rounded-br-sm bg-primary text-primary-foreground'
                    : 'rounded-bl-sm bg-muted text-foreground',
                )}
              >
                {turn.content && (
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                )}
                {turn.role === 'assistant' && turn.handoff && (
                  <p
                    className={cn(
                      'flex items-center gap-1 text-xs text-amber-500',
                      turn.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                    )}
                  >
                    <UserCircle2 className="size-3.5" />
                    Would hand off to a human here
                  </p>
                )}
              </div>
              {turn.role === 'user' && (
                <UserCircle2 className="mt-1 size-5 shrink-0 text-muted-foreground" />
              )}
            </div>

            {turn.role === 'assistant' && <TurnEvidence turn={turn} />}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="size-5 text-primary" />
            <Loader2 className="size-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Type a customer message…"
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={send}
          disabled={!input.trim() || sending}
          className="size-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * What the answer was built from. Collapsed by default — the reply is the
 * point — but one click away, because "why did it say that?" is the
 * question this screen exists to answer.
 */
function TurnEvidence({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const grounded = turn.grounded ?? [];
  const tools = turn.toolCalls ?? [];

  if (grounded.length === 0 && tools.length === 0) return null;

  return (
    <div className="ml-7 space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {grounded.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <BookOpen className="size-3" />
            {grounded.length} source{grounded.length === 1 ? '' : 's'}
          </span>
        )}
        {tools.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Wrench className="size-3" />
            {tools.length} tool call{tools.length === 1 ? '' : 's'}
          </span>
        )}
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2.5">
          {tools.map((call, i) => (
            <div key={`tool-${i}`} className="space-y-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Wrench className="size-3 text-muted-foreground" />
                <code className="font-mono text-foreground">{call.name}</code>
                <span
                  className={cn(
                    call.ok
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-destructive',
                  )}
                >
                  {call.ok ? 'ok' : 'failed'}
                </span>
                <span className="text-muted-foreground">{call.durationMs}ms</span>
              </p>
              {Object.keys(call.arguments ?? {}).length > 0 && (
                <pre className="overflow-x-auto rounded bg-background p-1.5 font-mono text-[10px] text-muted-foreground">
                  {JSON.stringify(call.arguments)}
                </pre>
              )}
              <p className="line-clamp-3 text-[11px] text-muted-foreground">
                {call.detail}
              </p>
            </div>
          ))}

          {grounded.map((source, i) => (
            <div key={`src-${i}`} className="space-y-0.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <BookOpen className="size-3 text-muted-foreground" />
                {source.title ?? 'Untitled document'}
              </p>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">
                {source.excerpt}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
