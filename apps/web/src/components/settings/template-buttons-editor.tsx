'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TemplateButton, TemplateParameterFormat } from '@/types';
import { TEMPLATE_LIMITS } from '@/lib/whatsapp/template-validators';
import { emptyButton, variableTokens } from '@/lib/whatsapp/template-form';

/**
 * Field patch for one button. The type union covers every variant's
 * fields; the conditional rendering below guarantees only fields valid
 * for the current button's `type` are ever sent, so the per-variant
 * spread in `patchButton` preserves the discriminated union without
 * every call site threading the type through generics.
 */
type ButtonPatch = {
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string;
};

function patchButton(current: TemplateButton, patch: ButtonPatch): TemplateButton {
  switch (current.type) {
    case 'QUICK_REPLY':
      return {
        ...current,
        ...(patch.text !== undefined && { text: patch.text }),
      };
    case 'URL':
      return {
        ...current,
        ...(patch.text !== undefined && { text: patch.text }),
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.example !== undefined && { example: patch.example }),
      };
    case 'PHONE_NUMBER':
      return {
        ...current,
        ...(patch.text !== undefined && { text: patch.text }),
        ...(patch.phone_number !== undefined && {
          phone_number: patch.phone_number,
        }),
      };
    case 'COPY_CODE':
      return {
        ...current,
        ...(patch.text !== undefined && { text: patch.text }),
        ...(patch.example !== undefined && { example: patch.example }),
      };
  }
}

const ALL_TYPES: { value: TemplateButton['type']; label: string }[] = [
  { value: 'QUICK_REPLY', label: 'Quick Reply' },
  { value: 'URL', label: 'URL' },
  { value: 'PHONE_NUMBER', label: 'Phone' },
  { value: 'COPY_CODE', label: 'Copy Code' },
];

interface TemplateButtonsEditorProps {
  buttons: TemplateButton[];
  onChange: (next: TemplateButton[]) => void;
  parameterFormat: TemplateParameterFormat;
  label?: string;
  maxButtons?: number;
  /** Carousel cards can't use copy-code buttons (Meta rule). */
  allowCopyCode?: boolean;
  /** Meta requires ≥1 button per carousel card, so removal is blocked there. */
  minButtons?: number;
  helpText?: string;
  compact?: boolean;
}

export function TemplateButtonsEditor({
  buttons,
  onChange,
  parameterFormat,
  label = 'Buttons (optional)',
  maxButtons = TEMPLATE_LIMITS.maxButtonsTotal,
  allowCopyCode = true,
  minButtons = 0,
  helpText,
  compact = false,
}: TemplateButtonsEditorProps) {
  const types = allowCopyCode
    ? ALL_TYPES
    : ALL_TYPES.filter((t) => t.value !== 'COPY_CODE');

  function update(index: number, patch: ButtonPatch) {
    const current = buttons[index];
    if (!current) return;
    const next = [...buttons];
    next[index] = patchButton(current, patch);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-muted-foreground">{label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...buttons, emptyButton('QUICK_REPLY')])}
          disabled={buttons.length >= maxButtons}
          className="h-7 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
        >
          <Plus className="size-3" />
          Add Button
        </Button>
      </div>

      {buttons.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {helpText ??
            `Up to ${maxButtons} buttons. QUICK_REPLY buttons must come before URL / phone / copy-code buttons.`}
        </p>
      ) : (
        <div className="space-y-2">
          {buttons.map((btn, i) => {
            const urlVars =
              btn.type === 'URL' ? variableTokens(btn.url, parameterFormat) : [];
            return (
              <div
                key={i}
                className={`space-y-2 rounded border border-border bg-muted/50 ${
                  compact ? 'p-1.5' : 'p-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={btn.type}
                    onValueChange={(val) => {
                      // @base-ui Select fires onValueChange(null) on
                      // deselect (per PR 148) — ignore it.
                      if (!val) return;
                      const next = [...buttons];
                      next[i] = emptyButton(val as TemplateButton['type']);
                      onChange(next);
                    }}
                  >
                    <SelectTrigger className="h-8 w-36 border-border bg-muted text-xs text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-popover">
                      {types.map((t) => (
                        <SelectItem
                          key={t.value}
                          value={t.value}
                          className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                        >
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Button label"
                    value={btn.text}
                    maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
                    onChange={(e) => update(i, { text: e.target.value })}
                    className="h-8 flex-1 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove button"
                    disabled={buttons.length <= minButtons}
                    onClick={() => onChange(buttons.filter((_, x) => x !== i))}
                    className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>

                {btn.type === 'URL' && (
                  <div className="space-y-1 pl-1">
                    <Input
                      placeholder={
                        parameterFormat === 'NAMED'
                          ? 'https://example.com/path or with a {{name}} suffix'
                          : 'https://example.com/path or with {{1}} suffix'
                      }
                      value={btn.url}
                      onChange={(e) => update(i, { url: e.target.value })}
                      className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                    />
                    {urlVars.length > 0 && (
                      <Input
                        placeholder={`Example value for {{${urlVars[0]}}} (required when the URL has a variable)`}
                        value={btn.example ?? ''}
                        onChange={(e) => update(i, { example: e.target.value })}
                        className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                      />
                    )}
                  </div>
                )}

                {btn.type === 'PHONE_NUMBER' && (
                  <Input
                    placeholder="+15551234567"
                    value={btn.phone_number}
                    onChange={(e) => update(i, { phone_number: e.target.value })}
                    className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                  />
                )}

                {btn.type === 'COPY_CODE' && (
                  <Input
                    placeholder="Example code (e.g. SUMMER20)"
                    value={btn.example}
                    onChange={(e) => update(i, { example: e.target.value })}
                    className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
