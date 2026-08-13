'use client';

/**
 * Text inputs that can reference data from earlier steps.
 *
 * THE PROBLEM THIS SOLVES
 *   The engine resolves an unknown token to an EMPTY STRING rather than
 *   leaving it visible — right for a customer-facing message, terrible
 *   for authoring, because a typo produces silence rather than an error.
 *   So the common case must never be typed by hand.
 *
 * WHY THE HIGHLIGHTING IS IN A PREVIEW STRIP, NOT THE INPUT
 *   A substring inside an `<input>` cannot be styled. The usual trick —
 *   a transparent input over a mirrored div painting <mark> spans —
 *   needs pixel-identical typography and per-frame scroll sync, breaks
 *   IME composition and find-in-page, and when it desynchronises it
 *   highlights the WRONG characters, which is worse than no
 *   highlighting. Instead: the field switches to mono the moment it
 *   contains `{{` (braces, dots and underscores are what a token is made
 *   of, and a proportional face mushes all three), and a preview strip
 *   below it shows what the value will actually read as.
 */

import { useMemo, useRef, useState } from 'react';

import { Braces, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toTokenText, type TokenGroup } from '@/lib/automations/tokens';

// ============================================================
// Field block — label row (with the token button), control, helper
// ============================================================

export function FieldBlock({
  label,
  htmlFor,
  hint,
  action,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** Right side of the label row — the token button lives here, never
   *  inside the input where it would overlap the text being typed. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-[20px] items-center justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="text-muted-foreground text-xs font-medium"
        >
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}

// ============================================================
// The picker
// ============================================================

export function TokenPicker({
  groups,
  onInsert,
  className,
}: {
  groups: TokenGroup[];
  onInsert: (path: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.path.toLowerCase().includes(q) ||
            g.label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Insert data from an earlier step"
        aria-haspopup="dialog"
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring flex h-5 w-5 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:outline-none',
          className,
        )}
      >
        <Braces size={13} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0"
      >
        <div className="border-border flex items-center gap-2 border-b px-3 py-2">
          <Search size={13} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search data…"
            className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-[12.5px] outline-none"
          />
        </div>

        <div
          role="listbox"
          aria-label="Available data"
          className="max-h-[300px] overflow-y-auto overscroll-contain py-1"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center">
              <p className="text-muted-foreground text-[12px]">
                No data called &ldquo;{query}&rdquo;.
              </p>
              <button
                type="button"
                onClick={() => {
                  onInsert(query.trim());
                  setOpen(false);
                }}
                className="text-primary mt-2 font-mono text-[11px] hover:underline"
              >
                Insert {`{{ ${query.trim()} }}`} anyway
              </button>
            </div>
          )}

          {filtered.map((group) => (
            <div key={group.id}>
              <div className="bg-popover text-muted-foreground sticky top-0 px-3 py-1.5 text-[10px] font-semibold tracking-wider uppercase">
                {group.label}
              </div>
              {group.options.map((option) => (
                <button
                  key={option.path}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => {
                    onInsert(option.path);
                    setOpen(false);
                  }}
                  className="hover:bg-muted focus-visible:bg-muted flex min-h-[38px] w-full flex-col items-start px-3 py-1.5 text-left focus-visible:outline-none"
                >
                  <span className="text-popover-foreground text-[12.5px]">
                    {option.label}
                    {option.conditional && (
                      <span className="text-muted-foreground ml-1.5 text-[10px]">
                        (only if that branch ran)
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground w-full truncate font-mono text-[10.5px]">
                    {option.path}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-[10.5px]">
          Click to insert at the cursor
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// Token-aware input / textarea
// ============================================================

interface TokenInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  groups: TokenGroup[];
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
  invalid?: boolean;
}

export function TokenInput({
  label,
  value,
  onChange,
  groups,
  placeholder,
  hint,
  multiline,
  rows = 4,
  mono,
  invalid,
}: TokenInputProps) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const hasTokens = value.includes('{{');
  const tokenCount = (value.match(/\{\{/g) ?? []).length;

  /**
   * Insert at the caret, not at the end.
   *
   * Appending is the lazy version and it is wrong the moment somebody
   * edits an existing sentence — "Hi , your order {{…}}" is what you get
   * when the caret is ignored.
   */
  const insert = (path: string) => {
    const token = toTokenText(path);
    const el = ref.current;
    if (!el) {
      onChange(`${value}${token}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    // A leading space when the caret sits mid-word, so a token never
    // abuts prose and become unreadable.
    const needsSpace = start > 0 && /\S/.test(value.slice(start - 1, start));
    const inserted = `${needsSpace ? ' ' : ''}${token}`;
    const next = value.slice(0, start) + inserted + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + inserted.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const controlClass = cn(
    'bg-muted text-foreground',
    (hasTokens || mono) && 'font-mono text-[12px]',
    invalid && 'border-destructive',
  );

  return (
    <FieldBlock
      label={label}
      hint={hint}
      action={
        <span className="flex items-center gap-1.5">
          {tokenCount > 0 && (
            <span className="text-muted-foreground text-[10px]">
              {tokenCount} token{tokenCount === 1 ? '' : 's'}
            </span>
          )}
          <TokenPicker groups={groups} onInsert={insert} />
        </span>
      }
    >
      {multiline ? (
        <Textarea
          ref={ref as React.Ref<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          aria-invalid={invalid || undefined}
          className={controlClass}
        />
      ) : (
        <Input
          ref={ref as React.Ref<HTMLInputElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          className={controlClass}
        />
      )}
      {hasTokens && <TokenPreview value={value} />}
    </FieldBlock>
  );
}

/**
 * What the field will read as at run time, with each token shown as a
 * highlighted chip.
 *
 * This is a <div>, so the highlighting is free — which is the whole
 * reason it exists rather than trying to style the input. The input
 * shows SYNTAX; this shows MEANING.
 */
export function TokenPreview({ value }: { value: string }) {
  const parts = useMemo(() => splitTokens(value), [value]);
  return (
    <div className="border-border bg-card rounded-md border px-2 py-1.5">
      <div className="text-muted-foreground text-[10px] tracking-wider uppercase">
        Preview
      </div>
      <div className="mt-0.5 max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
        {parts.map((part, i) =>
          part.token ? (
            <span
              key={i}
              className="bg-primary-soft text-primary rounded-[3px] px-1"
            >
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </div>
    </div>
  );
}

function splitTokens(value: string): { text: string; token: boolean }[] {
  const out: { text: string; token: boolean }[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    if (match.index > last) {
      out.push({ text: value.slice(last, match.index), token: false });
    }
    out.push({ text: match[1], token: true });
    last = match.index + match[0].length;
  }
  if (last < value.length) out.push({ text: value.slice(last), token: false });
  return out;
}

// ============================================================
// Key/value table — HTTP headers, query params, JSON body fields
// ============================================================

export function KeyValueTable({
  label,
  rows,
  onChange,
  groups,
  keyPlaceholder = 'name',
  valuePlaceholder = 'value',
  addLabel = 'Add row',
  hint,
}: {
  label: string;
  rows: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  groups: TokenGroup[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  hint?: string;
}) {
  /**
   * Rows live in LOCAL state while editing, and only valid ones are
   * committed upward.
   *
   * Deriving them from the object prop looks tidier and does not work: a
   * new row starts with an empty name, an empty name cannot be a key, so
   * the row would vanish on the render after "+ Add" — you could never
   * add one. The same applies mid-rename, when a half-typed key
   * momentarily collides with another.
   *
   * Seeded once per mount; the inspector remounts this per step (React
   * key), so switching steps still loads the right rows.
   */
  const [entries, setEntries] = useState<[string, unknown][]>(() =>
    Object.entries(rows ?? {}),
  );

  const commit = (next: [string, unknown][]) => {
    setEntries(next);
    const out: Record<string, unknown> = {};
    for (const [k, v] of next) {
      if (!k.trim()) continue;
      out[k] = v;
    }
    onChange(out);
  };

  return (
    <FieldBlock label={label} hint={hint}>
      <div className="space-y-1.5">
        {entries.length > 0 && (
          <div className="text-muted-foreground grid grid-cols-[1fr_1fr_28px] gap-1.5 text-[10px] tracking-wider uppercase">
            <span>Name</span>
            <span>Value</span>
            <span />
          </div>
        )}
        {entries.map(([key, value], i) => (
          <div
            key={i}
            className="group grid grid-cols-[1fr_1fr_28px] items-center gap-1.5"
          >
            <Input
              value={key}
              onChange={(e) => {
                const next = [...entries];
                next[i] = [e.target.value, value];
                commit(next);
              }}
              placeholder={keyPlaceholder}
              className="bg-muted h-8 font-mono text-[12px]"
            />
            <div className="relative">
              <Input
                value={String(value ?? '')}
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = [key, e.target.value];
                  commit(next);
                }}
                placeholder={valuePlaceholder}
                className="bg-muted h-8 pr-7 font-mono text-[12px]"
              />
              {/* focus-within, not just hover: a hover-only control is
                  unreachable by keyboard. */}
              <span className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <TokenPicker
                  groups={groups}
                  onInsert={(path) => {
                    const next = [...entries];
                    next[i] = [key, `${String(value ?? '')}${toTokenText(path)}`];
                    commit(next);
                  }}
                />
              </span>
            </div>
            <button
              type="button"
              onClick={() => commit(entries.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive h-8 text-xs"
              aria-label={`Remove ${key || 'row'}`}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => commit([...entries, ['', '']])}
          className="text-muted-foreground hover:text-foreground border-border hover:border-primary/40 w-full rounded-md border border-dashed py-1.5 text-[11.5px] transition-colors"
        >
          + {addLabel}
        </button>
      </div>
    </FieldBlock>
  );
}
