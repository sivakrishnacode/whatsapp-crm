'use client';

/**
 * The add-step picker: a two-pane popover, not a dropdown.
 *
 * With 24 step types a flat menu is a scroll container, and a scroll
 * container is where features go to be undiscovered. A category rail on
 * the left plus a filtered list on the right keeps every entry one click
 * and one glance away, and search covers the case where the author knows
 * the name but not the bucket.
 */

import { useMemo, useState } from 'react';
import { Ban, Plus, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  ADDABLE_STEPS,
  STEP_CATEGORIES,
  STEP_META,
  StepIconChip,
  type StepCategory,
} from '@/lib/automations/step-meta';
import { stepAvailability } from '@/lib/automations/availability';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

export function AddStepMenu({
  onPick,
  channels,
  triggerType,
  trigger,
  align = 'start',
}: {
  onPick: (type: AutomationStepType) => void;
  /** Automation's channel scope — empty means all of them. */
  channels: string[];
  triggerType: AutomationTriggerType;
  trigger?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<StepCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ADDABLE_STEPS.filter((type) => {
      const meta = STEP_META[type];
      if (!meta) return false;
      // Search deliberately ignores the category rail: someone typing
      // "webhook" wants the webhook step, not to be told it is filed
      // under a bucket they did not pick.
      if (q) {
        return (
          meta.label.toLowerCase().includes(q) ||
          meta.blurb.toLowerCase().includes(q) ||
          type.includes(q)
        );
      }
      return category === 'all' || meta.category === category;
    });
  }, [category, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Add a step"
        className={
          trigger
            ? 'contents'
            : 'bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)] transition-colors'
        }
      >
        {trigger ?? (
          <>
            <Plus className="h-4 w-4" />
            Add step
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={8}
        className="w-[420px] p-0"
      >
        <div className="border-border flex items-center gap-2 border-b px-3 py-2">
          <Search size={13} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search steps…"
            className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-[12.5px] outline-none"
          />
        </div>

        <div className="flex h-[340px]">
          <div className="border-border w-[122px] shrink-0 overflow-y-auto border-r py-1">
            {[{ id: 'all' as const, label: 'All' }, ...STEP_CATEGORIES].map(
              (c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCategory(c.id as StepCategory | 'all');
                    setQuery('');
                  }}
                  className={cn(
                    'w-full px-3 py-1.5 text-left text-[12px] transition-colors',
                    category === c.id && !query
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {c.label}
                </button>
              ),
            )}
          </div>

          <div className="flex-1 overflow-y-auto overscroll-contain py-1">
            {visible.length === 0 && (
              <p className="text-muted-foreground px-3 py-6 text-center text-[12px]">
                No step called “{query}”.
              </p>
            )}
            {visible.map((type) => {
              const meta = STEP_META[type];
              const availability = stepAvailability(type, channels, triggerType);
              const unusable = availability.status === 'never';
              return (
                <button
                  key={type}
                  type="button"
                  // Offered but dimmed, with the reason — NOT hidden. A
                  // step missing from a menu reads as a bug, whereas a
                  // greyed-out one that explains itself is a rule you
                  // learn once. It stays clickable so somebody who is
                  // about to widen the channels is not blocked.
                  onClick={() => {
                    onPick(type);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={cn(
                    'hover:bg-muted flex w-full items-start gap-2.5 px-3 py-2 text-left',
                    unusable && 'opacity-55',
                  )}
                >
                  <StepIconChip type={type} size={26} iconSize={14} className="mt-0.5 rounded-md" />
                  <span className="min-w-0 flex-1">
                    <span className="text-popover-foreground flex items-center gap-1.5 text-[12.5px] font-medium">
                      {meta.label}
                      {unusable && (
                        <span className="text-destructive flex items-center gap-0.5 text-[9.5px] tracking-wide uppercase">
                          <Ban size={10} />
                          won’t run here
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground block text-[11px] leading-snug">
                      {unusable ? availability.reason : meta.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
