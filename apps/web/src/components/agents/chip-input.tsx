'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A list of short strings, edited as chips.
 *
 * Used for the three places the agent config takes a small set of
 * values — handoff trigger phrases, test numbers, and the fields a
 * qualification skill collects. A textarea would be less typing to build
 * but hides the important property: these are DISCRETE entries, and one
 * with a stray comma in it behaves differently from two.
 */
export function ChipInput({
  values,
  onChange,
  placeholder,
  disabled,
  max,
  inputMode,
  className,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  max?: number;
  inputMode?: 'text' | 'tel';
  className?: string;
}) {
  const [draft, setDraft] = useState('');
  const full = max !== undefined && values.length >= max;

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (full) return;
    // Case-insensitive de-dupe: two spellings of the same phrase would
    // both match the same message, and the second is dead config.
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div className={cn('space-y-2', className)}>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2.5 pr-1 text-xs text-foreground"
            >
              <span className="max-w-[18rem] truncate">{value}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(values.filter((v) => v !== value))}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  aria-label={`Remove ${value}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={full ? `Limit of ${max} reached` : placeholder}
            disabled={full}
            inputMode={inputMode}
            className="h-9"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={add}
            disabled={!draft.trim() || full}
            className="h-9 shrink-0"
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
