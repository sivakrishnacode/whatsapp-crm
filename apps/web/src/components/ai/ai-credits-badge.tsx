'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useAiCredits } from '@/hooks/use-ai-credits';
import { cn } from '@/lib/utils';
import { AiCreditsSheet } from './ai-credits-sheet';

/**
 * ============================================================
 * `✨ 123` in the header — how much AI this workspace has left.
 *
 * It lives next to the notification bell rather than inside the AI
 * screens on purpose: the balance is spent from the INBOX (every "Draft
 * with AI" press, every automatic reply), which is where people are
 * when it runs out. A number only visible on the settings page would be
 * discovered by its absence.
 *
 * It renders nothing at all in two cases, both deliberate:
 *
 *   - the workspace runs on its own provider key, where a credit count
 *     is a number that never moves and means nothing;
 *   - the server has no platform key configured, where the built-in AI
 *     does not exist and neither should its badge.
 * ============================================================
 */
export function AiCreditsBadge() {
  const { credits } = useAiCredits();
  const [open, setOpen] = useState(false);

  if (!credits) return null;
  if (!credits.platform_available) return null;
  if (credits.credit_mode === 'byok') return null;

  const empty = credits.balance <= 0;
  const low = credits.low && !empty;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`AI credits: ${credits.balance.toLocaleString()} remaining. Open top-up.`}
        title={
          empty
            ? 'Out of AI credits — top up to keep drafting'
            : `${credits.balance.toLocaleString()} AI credits remaining`
        }
        className={cn(
          'flex h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors',
          empty
            ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
            : low
              ? 'bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Sparkles className="size-[18px] shrink-0" />
        {/* The count is the point of the badge, so it never collapses to
            an icon — but the word does on narrow screens. */}
        <span className="tabular-nums">{credits.balance.toLocaleString()}</span>
        <span className="hidden sm:inline">AI credits</span>
      </button>

      <AiCreditsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
