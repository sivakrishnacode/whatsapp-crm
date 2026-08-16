'use client';

/**
 * "Build with AI" — the prompt bar in the flow editor's top bar.
 *
 * ⚠️ IT REPLACES THE CANVAS, SO IT ASKS FIRST.
 *   A generated flow is a whole graph; merging it into an existing one
 *   would produce two disconnected halves and no way to tell which node
 *   came from where. So it replaces — and because replacing is
 *   destructive, an existing flow gets a confirmation step naming what
 *   is about to go ("6 nodes, replacing your 3"). An EMPTY canvas skips
 *   the confirmation: there is nothing to lose and a dialog asking to
 *   overwrite nothing is noise.
 *
 * ⚠️ NOTHING IS SAVED HERE.
 *   Applying a draft only changes editor state — the author still
 *   presses Save, against the same validation as any other edit. That is
 *   also why the undo story is simply "don't save": the flow on the
 *   server is untouched until they do.
 */

import { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAiCredits } from '@/hooks/use-ai-credits';
import { cn } from '@/lib/utils';
import {
  describeDraft,
  draftToBuilderNodes,
  type AiFlowDraft,
  type AiFlowDraftResponse,
} from '@/lib/flows/ai-draft';
import { useFlowEditor } from './flow-editor-state';

const SUGGESTIONS = [
  'Greet new customers, ask what they need, and route them to sales or support',
  'Take a food order: menu buttons, then ask for the delivery address',
  'Qualify a lead — ask for name, budget and timeline, then hand to an agent',
  'Answer "where is my order", ask for the order number, then look it up',
];

export function AiFlowPrompt() {
  const { state, setState, selectNode } = useFlowEditor();
  const { setBalance } = useAiCredits();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AiFlowDraft | null>(null);
  const [open, setOpen] = useState(false);

  async function generate() {
    const text = prompt.trim();
    if (!text || busy) return;

    setBusy(true);
    try {
      const res = await fetch('/api/ai/flow-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const body = (await res.json().catch(() => ({}))) as
        AiFlowDraftResponse | { error?: string; code?: string };

      if (!res.ok) {
        const message =
          ('error' in body && body.error) ||
          `The AI could not build that (${res.status}).`;
        toast.error(message);
        return;
      }

      const { draft, credits_remaining } = body as AiFlowDraftResponse;
      if (typeof credits_remaining === 'number') setBalance(credits_remaining);

      if (draft.nodes.length === 0) {
        toast.error("The AI didn't produce a flow.", {
          description: draft.notes[0] ?? 'Try describing it more specifically.',
        });
        return;
      }

      // An empty canvas has nothing to lose, so skip the confirmation.
      if (state.nodes.length === 0) {
        apply(draft);
      } else {
        setPending(draft);
      }
    } catch {
      toast.error("Couldn't reach the AI. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  function apply(draft: AiFlowDraft) {
    const nodes = draftToBuilderNodes(draft);
    setState((s) => ({
      ...s,
      // The flow's own name is kept if the author already set one —
      // they named it deliberately, and the model's title is a guess.
      name: s.name?.trim() ? s.name : draft.name,
      description: s.description?.trim() ? s.description : draft.description,
      trigger_type: draft.trigger_type,
      trigger_config: draft.trigger_config,
      entry_node_id: draft.entry_node_key || (nodes[0]?.node_key ?? null),
      nodes,
    }));
    selectNode(null);
    setPending(null);
    setPrompt('');
    setOpen(false);

    const extras = [...draft.notes, ...draft.needs.map((n) => `Pick ${n}.`)];
    toast.success(`Built ${describeDraft(draft)}. Nothing is saved yet.`, {
      description: extras.length > 0 ? extras.join(' ') : undefined,
      duration: extras.length > 0 ? 10000 : 5000,
    });
  }

  return (
    <>
      {/* ---- collapsed trigger / expanded input ---- */}
      {open ? (
        <div className="border-primary/40 bg-card flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1 focus-within:shadow-[0_0_0_3px_var(--primary-soft)] md:max-w-[520px]">
          <Sparkles className="text-primary h-4 w-4 shrink-0" />
          <input
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void generate();
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Describe the flow you want…"
            aria-label="Describe the flow you want"
            disabled={busy}
            className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-1 py-1 text-[13px] outline-none"
          />
          <Button
            size="sm"
            onClick={() => void generate()}
            disabled={busy || !prompt.trim()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Build
          </Button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close the AI prompt"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className="border-primary/40 text-primary hover:bg-primary-soft shrink-0"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Build with AI
        </Button>
      )}

      {/* ---- suggestions, only while empty and focused ---- */}
      {open && !prompt.trim() && !busy && (
        <div className="border-border bg-popover absolute top-full left-0 z-50 mt-1 w-[min(520px,90vw)] rounded-lg border p-1.5 shadow-lg">
          <p className="text-muted-foreground px-2 py-1 text-[11px]">
            Try one of these
          </p>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setPrompt(s)}
              className="text-foreground hover:bg-muted block w-full rounded-md px-2 py-1.5 text-left text-[12.5px]"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <ReplaceConfirm
          draft={pending}
          existingCount={state.nodes.length}
          onCancel={() => setPending(null)}
          onConfirm={() => apply(pending)}
        />
      )}
    </>
  );
}

/**
 * The confirmation. Names both sides of the trade — what arrives and
 * what goes — because "Are you sure?" tells the author nothing they can
 * weigh.
 */
function ReplaceConfirm({
  draft,
  existingCount,
  onCancel,
  onConfirm,
}: {
  draft: AiFlowDraft;
  existingCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="bg-background/70 absolute inset-0 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden
      />
      <div className="bg-card border-border relative w-[min(460px,95vw)] rounded-xl border p-5 shadow-2xl">
        <h2 className="text-foreground flex items-center gap-2 text-base font-semibold">
          <Sparkles className="text-primary h-4 w-4" />
          Replace this flow?
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          The AI built{' '}
          <strong className="text-foreground">{describeDraft(draft)}</strong>.
          Applying it replaces the {existingCount} node
          {existingCount === 1 ? '' : 's'} on your canvas.
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          Nothing is saved until you press Save — close without saving to get
          your old flow back.
        </p>

        {(draft.notes.length > 0 || draft.needs.length > 0) && (
          <ul className="text-muted-foreground bg-muted/50 mt-3 flex list-disc flex-col gap-1 rounded-md py-2 pr-3 pl-7 text-[11.5px]">
            {draft.needs.map((n) => (
              <li key={`need-${n}`}>You still need to pick {n}.</li>
            ))}
            {draft.notes.map((n, i) => (
              <li key={`note-${i}`}>{n}</li>
            ))}
          </ul>
        )}

        <div className={cn('mt-4 flex items-center justify-end gap-2')}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Keep my flow
          </Button>
          <Button size="sm" onClick={onConfirm}>
            Replace it
          </Button>
        </div>
      </div>
    </div>
  );
}
