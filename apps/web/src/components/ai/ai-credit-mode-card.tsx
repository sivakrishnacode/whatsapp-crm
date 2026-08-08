'use client';

import { useState } from 'react';
import { KeyRound, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAiCredits } from '@/hooks/use-ai-credits';
import { cn } from '@/lib/utils';
import { AiCreditsSheet } from './ai-credits-sheet';

/**
 * ============================================================
 * Which key powers this workspace's agent.
 *
 * The choice is stored, not inferred from "is there a key present".
 * Two failures that would otherwise be invisible are why:
 *
 *   - a workspace that pasted a key months ago must not silently start
 *     being billed by us when the built-in option ships;
 *   - a workspace that bought credits must not watch them sit unused
 *     while their own Google bill grows.
 *
 * Falling back is deliberately one-directional and only when the chosen
 * source cannot serve a call at all — spelled out below the options,
 * because a customer discovering it from an invoice is the bad version.
 * ============================================================
 */
export function AiCreditModeCard({
  canEdit,
  onChanged,
}: {
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const { credits, reload } = useAiCredits();
  const [saving, setSaving] = useState<'platform' | 'byok' | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);

  // Nothing to choose between when the server has no platform key: the
  // product is bring-your-own-key only, exactly as it was before.
  if (!credits?.platform_available) return null;

  const mode = credits.credit_mode;

  const choose = async (next: 'platform' | 'byok') => {
    if (next === mode) return;
    setSaving(next);
    try {
      const res = await fetch('/api/ai/credits/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credit_mode: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not change the AI source.');
        return;
      }
      toast.success(
        next === 'platform'
          ? 'The agent now runs on built-in AI credits.'
          : 'The agent now runs on your own provider key.',
      );
      await reload();
      onChanged?.();
    } catch {
      toast.error('Could not change the AI source.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How the AI is powered</CardTitle>
        <CardDescription>
          Use our built-in AI and pay per use, or bring your own provider key
          and pay them directly. You can switch at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ModeOption
          selected={mode === 'platform'}
          disabled={!canEdit || saving !== null}
          busy={saving === 'platform'}
          icon={<Sparkles className="size-4" />}
          title="Built-in AI"
          onSelect={() => void choose('platform')}
          detail={
            <>
              Nothing to set up. Runs on our Google Gemini key and spends AI
              credits — currently{' '}
              <span className="font-medium text-foreground tabular-nums">
                {credits.balance.toLocaleString()}
              </span>{' '}
              remaining.
            </>
          }
          action={
            mode === 'platform' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setTopUpOpen(true);
                }}
              >
                Top up
              </Button>
            ) : null
          }
        />

        <ModeOption
          selected={mode === 'byok'}
          disabled={!canEdit || saving !== null}
          busy={saving === 'byok'}
          icon={<KeyRound className="size-4" />}
          title="Your own provider key"
          onSelect={() => void choose('byok')}
          detail={
            credits.has_own_key ? (
              <>
                Runs on the key saved below. No credits are spent — your
                provider bills you directly, with no limit from us.
              </>
            ) : (
              <>
                Add an OpenAI, Anthropic or Google key below first, then choose
                this. Your provider bills you directly, with no limit from us.
              </>
            )
          }
        />

        <p className="text-xs leading-relaxed text-muted-foreground">
          {credits.has_own_key
            ? 'If the built-in credits run out, the agent falls back to your own key so it keeps answering. It never falls back the other way — your credits are only spent when you have chosen built-in AI.'
            : 'With no key of your own saved, the agent stops drafting when credits run out and conversations are left for a human.'}
        </p>
      </CardContent>

      <AiCreditsSheet open={topUpOpen} onOpenChange={setTopUpOpen} />
    </Card>
  );
}

function ModeOption({
  selected,
  disabled,
  busy,
  icon,
  title,
  detail,
  action,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  busy: boolean;
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
        selected
          ? 'border-primary bg-primary-soft/40'
          : 'border-border hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
          selected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {selected ? (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
              In use
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
