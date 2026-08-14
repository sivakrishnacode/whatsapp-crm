'use client';

import { useRef } from 'react';
import { Bold, Italic, Plus, Smile } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { TemplateParameterFormat } from '@/types';
import { nextVariableToken } from '@/lib/whatsapp/template-form';

// A fixed grid rather than a full emoji-picker dependency: template
// bodies are short marketing copy, and the long tail of emoji isn't
// worth ~1MB of bundle. Users can still paste anything.
const EMOJI = [
  '😀', '😃', '😄', '😁', '😊', '😍', '🥳', '😎',
  '🤩', '🙏', '👍', '👏', '💪', '🎉', '🎁', '✨',
  '🔥', '⭐', '❤️', '💚', '✅', '❌', '⚠️', '📢',
  '📌', '📎', '📅', '⏰', '🚀', '💰', '🛒', '🏷️',
  '📦', '🚚', '📞', '✉️', '📍', '🏠', '🍕', '☕',
];

interface TemplateBodyEditorProps {
  value: string;
  onChange: (next: string) => void;
  parameterFormat: TemplateParameterFormat;
  maxLength: number;
  rows?: number;
  placeholder?: string;
  /** Hides the variable button for text that takes no parameters. */
  allowVariables?: boolean;
  textareaId?: string;
  ariaLabel?: string;
}

/**
 * Body textarea plus the formatting affordances WhatsApp actually
 * supports: `*bold*`, `_italic_`, `{{variables}}`, emoji, and a live
 * character count against Meta's cap.
 *
 * All four insertions go through `replaceSelection` so they land at the
 * caret (or wrap the selection) instead of being appended — appending is
 * what makes this kind of toolbar useless once the body is more than one
 * line long.
 */
export function TemplateBodyEditor({
  value,
  onChange,
  parameterFormat,
  maxLength,
  rows = 4,
  placeholder,
  allowVariables = true,
  textareaId,
  ariaLabel,
}: TemplateBodyEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * Insert `before + selection + after` at the caret and restore a
   * sensible selection afterwards, so a user can hit Bold and keep
   * typing inside the markers.
   */
  function replaceSelection(before: string, after = '') {
    const el = ref.current;
    if (!el) {
      onChange(value + before + after);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const next =
      value.slice(0, start) + before + selected + after + value.slice(end);
    if (next.length > maxLength) return;
    onChange(next);

    // The DOM node keeps the old value until React commits, so move the
    // caret on the next frame.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      const caret = start + before.length + selected.length;
      node.setSelectionRange(caret, caret);
    });
  }

  const overCap = value.length >= maxLength;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        {allowVariables && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
            onClick={() =>
              replaceSelection(
                `{{${nextVariableToken(value, parameterFormat)}}}`,
              )
            }
          >
            <Plus className="size-3" />
            Add Variable
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Bold"
            title="Bold (*text*)"
            className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => replaceSelection('*', '*')}
          >
            <Bold className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Italic"
            title="Italic (_text_)"
            className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => replaceSelection('_', '_')}
          >
            <Italic className="size-3.5" />
          </Button>
          <Popover>
            <PopoverTrigger
              aria-label="Insert emoji"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Smile className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent className="w-64 border-border bg-popover p-2">
              <div className="grid grid-cols-8 gap-0.5">
                {EMOJI.map((e) => (
                  <button
                    key={e}
                    type="button"
                    aria-label={`Insert ${e}`}
                    className="rounded p-1 text-base leading-none hover:bg-muted"
                    onClick={() => replaceSelection(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <Textarea
        ref={ref}
        id={textareaId}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        className="resize-none border-border bg-muted text-foreground placeholder:text-muted-foreground"
      />

      <p
        className={`text-right text-[11px] ${
          overCap ? 'text-accent-amber' : 'text-muted-foreground'
        }`}
      >
        {value.length} / {maxLength} characters
      </p>
    </div>
  );
}
