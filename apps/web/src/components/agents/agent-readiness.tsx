'use client';

import { AlertTriangle, Check, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AgentStudio } from '@/lib/agents/types';

/**
 * The tools the Apps Script bridge backs.
 *
 * ⚠️ MIRRORS `GOOGLE_TOOL_NAMES` in the API's lib/tools/google.ts. A tool
 * added there and not here means a skill silently loses its tools with
 * this checklist still claiming everything is fine.
 */
const GOOGLE_TOOL_NAMES = new Set([
  'check_availability',
  'book_meeting',
  'log_to_sheet',
  'save_to_contacts',
  'create_task',
]);

export type StudioTab =
  | 'persona'
  | 'knowledge'
  | 'skills'
  | 'actions'
  | 'behaviour'
  | 'routing';

export interface ReadinessItem {
  id: string;
  label: string;
  done: boolean;
  /** Which tab fixes it. */
  tab: StudioTab;
  /** Why it matters, in one sentence. Only shown when not done. */
  hint: string;
  /**
   * A blocker stops the agent answering ANYBODY. A warning is a thing
   * worth fixing that still lets it work.
   */
  blocking: boolean;
}

/**
 * ============================================================
 * What is stopping this agent from doing its job?
 *
 * ⚠️ THIS IS A MIRROR OF THE RUN-TIME GATES, NOT A STYLE GUIDE.
 * Every item corresponds to a real reason `AiReplyService` would return
 * without answering, in the order it checks them. If a gate is added
 * there and not here, this list starts lying — which is worse than not
 * having it, because the whole point is to answer "why is my bot
 * silent?" without reading logs.
 *
 * The gates it mirrors, in order:
 *   1. no workspace provider key / no credits  → nothing can run
 *   2. agent switched off                      → returns immediately
 *   3. no channel covers the conversation      → routing finds nobody
 *   4. auto-reply off                          → drafts only, by choice
 *   5. test mode with no numbers               → refused on save
 *   6. a Google skill on, Google not connected → those tools are WITHHELD
 *
 * Items 4 and 5 are deliberately NOT blockers: "drafts only" is a
 * legitimate way to run an agent, and saying otherwise would nag
 * somebody who has chosen it on purpose.
 *
 * Item 6 is not a blocker either, and the distinction is worth keeping
 * straight: the agent still answers, it just cannot check a calendar or
 * write a row. `agent-runtime` withholds those tools rather than letting
 * them fail, which is invisible from the chat — the reply simply reads as
 * if the agent forgot it could book. This line is the only place that
 * says why.
 * ============================================================
 */
export function readinessOf(
  studio: AgentStudio,
  /** From GET /api/google-script. Undefined = not loaded yet, so no claim. */
  googleConnected?: boolean,
): ReadinessItem[] {
  const hasPersona = Boolean(
    studio.business_description?.trim() || studio.system_prompt?.trim(),
  );
  const knowsSomething = (studio.knowledge?.selected ?? 0) > 0;

  // Which enabled skills unlock a Google tool, read from the SERVED
  // registry rather than a hard-coded list here — a new Google skill on
  // the server must not need a web change to be checked.
  const googleSkillLabels = (studio.skills_registry ?? [])
    .filter((def) => (def.tools ?? []).some((t) => GOOGLE_TOOL_NAMES.has(t)))
    .filter((def) => studio.skills?.[def.id]?.enabled)
    .map((def) => def.label);

  return [
    {
      id: 'provider',
      label: 'The workspace can reach a model',
      done: studio.configured,
      tab: 'routing',
      hint:
        'This workspace is set to use its own provider key and none is stored, so no agent can answer.',
      blocking: true,
    },
    {
      id: 'persona',
      label: 'It knows what the business does',
      done: hasPersona,
      tab: 'persona',
      hint:
        'With no description it answers from the customer’s question alone, which is how an agent invents things.',
      blocking: false,
    },
    {
      id: 'knowledge',
      label: 'It has something to answer from',
      done: knowsSomething,
      tab: 'knowledge',
      hint:
        'No documents are selected for this agent, so every answer comes from the persona alone.',
      blocking: false,
    },
    {
      id: 'google',
      label: 'Its Google skills can reach Google',
      // `googleConnected === undefined` means the status has not loaded.
      // Treated as done, because a checklist that flickers a warning on
      // every page load teaches people to ignore it.
      done: googleSkillLabels.length === 0 || googleConnected !== false,
      tab: 'skills',
      hint:
        `${googleSkillLabels.join(' and ')} ${
          googleSkillLabels.length === 1 ? 'is' : 'are'
        } on, but Google is not connected for this workspace — those tools are ` +
        'withheld, so the agent answers without them and never says why. ' +
        'Set it up in Settings → Integrations → Google.',
      blocking: false,
    },
    {
      id: 'channels',
      label: 'A channel routes to it',
      // Empty channels means "every channel", which is a valid answer.
      done: true,
      tab: 'routing',
      hint: '',
      blocking: false,
    },
    {
      id: 'active',
      label: 'It is switched on',
      done: Boolean(studio.is_active),
      tab: 'routing',
      hint: 'Nothing is drafted or answered while the agent is off.',
      blocking: true,
    },
  ];
}

/**
 * The header block: what is done, what is not, and one click to the tab
 * that fixes it. Shown collapsed to a single line once everything that
 * blocks is resolved — a checklist that stays open after it is finished
 * is furniture.
 */
export function AgentReadiness({
  studio,
  onGoToTab,
  googleConnected,
}: {
  studio: AgentStudio;
  onGoToTab: (tab: StudioTab) => void;
  googleConnected?: boolean;
}) {
  const items = readinessOf(studio, googleConnected).filter(
    (item) => item.hint || !item.done,
  );
  const outstanding = items.filter((item) => !item.done);

  if (outstanding.length === 0) return null;

  const blockers = outstanding.filter((item) => item.blocking);

  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        blockers.length > 0
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border bg-card/60',
      )}
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        {blockers.length > 0 ? (
          <AlertTriangle className="size-4 text-accent-amber" />
        ) : (
          <Check className="size-4 text-muted-foreground" />
        )}
        {blockers.length > 0
          ? `${blockers.length} thing${blockers.length === 1 ? '' : 's'} stop${blockers.length === 1 ? 's' : ''} this agent answering`
          : 'Worth finishing before you go live'}
      </p>

      <ul className="mt-2 space-y-1.5">
        {outstanding.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onGoToTab(item.tab)}
              className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/60"
            >
              <span
                className={cn(
                  'mt-0.5 size-1.5 shrink-0 rounded-full',
                  item.blocking ? 'bg-accent-amber' : 'bg-muted-foreground/50',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{item.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {item.hint}
                </span>
              </span>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
