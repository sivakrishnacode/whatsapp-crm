'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useAiCredits } from '@/hooks/use-ai-credits';
import { cn } from '@/lib/utils';
import { AiCreditsSheet } from './ai-credits-sheet';

/**
 * ============================================================
 * `✨ 1,250 AI credits` in the header — how much AI is left.
 *
 * It lives next to the notification bell rather than inside the AI
 * screens on purpose: the balance is spent from the INBOX (every "Draft
 * with AI" press, every automatic reply), which is where people are
 * when it runs out. A number only visible on a settings page would be
 * discovered by its absence.
 *
 * WHY IT IS A RAISED PILL AND NOT A PLAIN ICON BUTTON
 *   Everything else in this header is a neutral, ghosted control you
 *   press to go somewhere. This is the only one carrying a *value* —
 *   and a depleting one. Rendered in the same muted grey as its
 *   neighbours it read as another icon and the number disappeared into
 *   the row. The surface, border and lift make it the one thing in the
 *   header that looks like it holds something.
 *
 * The colour is the workspace's own accent (`--primary`, which the
 * theme picker rewrites) rather than a hardcoded violet, so it belongs
 * to whatever theme is active instead of fighting it. It escalates
 * through the shared `warning` and `destructive` surface pairs — the
 * same ones used everywhere else for "attention" and "broken" — so a
 * low balance reads the way every other warning in the product does.
 *
 * It renders nothing at all in two cases, both deliberate:
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
  const tone = empty ? 'empty' : low ? 'low' : 'normal';

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
          'group relative flex h-9 items-center gap-1.5 rounded-full border pl-2 pr-2.5 text-sm',
          'shadow-sm transition-all duration-150',
          // The lift: a touch higher on hover, pressed flat on click.
          'hover:-translate-y-px hover:shadow-md active:translate-y-0 active:shadow-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          {
            normal: cn(
              'border-primary/25 bg-primary-soft text-primary',
              'hover:border-primary/40 hover:bg-primary-soft-2',
              'focus-visible:ring-primary/50',
            ),
            low: cn(
              'border-warning/30 bg-warning-surface text-warning',
              'hover:border-warning/50',
              'focus-visible:ring-warning/50',
            ),
            empty: cn(
              'border-destructive/30 bg-destructive-surface text-destructive',
              'hover:border-destructive/50',
              'focus-visible:ring-destructive/50',
            ),
          }[tone],
        )}
      >
        <Sparkles
          className={cn(
            'size-[15px] shrink-0 transition-transform duration-150',
            'group-hover:scale-110',
            // Only when it needs attention — a permanently animated
            // header is a permanently distracting one.
            empty && 'animate-pulse',
          )}
        />
        {/* Tabular figures so the pill does not resize on every reply. */}
        <span className="font-semibold tabular-nums">
          {credits.balance.toLocaleString()}
        </span>
        {/* The word is what makes the number mean something, so it is
            kept wherever there is room and dropped only on the narrowest
            screens — where the sparkle plus a count still reads. */}
        <span className="hidden font-medium opacity-80 sm:inline">
          AI credits
        </span>
      </button>

      <AiCreditsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
