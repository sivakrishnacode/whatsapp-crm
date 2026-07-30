'use client';

import { useRef } from 'react';
import { toast } from 'sonner';
import { Copy, Plus, Trash2, Upload, X } from 'lucide-react';
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
import type { TemplateParameterFormat } from '@/types';
import { TEMPLATE_LIMITS } from '@/lib/whatsapp/template-validators';
import {
  emptyCard,
  resizeSamples,
  variableTokens,
  type CardFormData,
} from '@/lib/whatsapp/template-form';
import {
  validateTemplateMediaFile,
  TEMPLATE_MEDIA_RULES,
} from '@/lib/whatsapp/template-media';
import { TemplateBodyEditor } from './template-body-editor';
import { TemplateButtonsEditor } from './template-buttons-editor';

interface TemplateCardsEditorProps {
  cards: CardFormData[];
  onChange: (next: CardFormData[]) => void;
  parameterFormat: TemplateParameterFormat;
}

interface CardRowProps {
  card: CardFormData;
  index: number;
  total: number;
  parameterFormat: TemplateParameterFormat;
  onPatch: (patch: Partial<CardFormData>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  canAdd: boolean;
}

function CardRow({
  card,
  index,
  total,
  parameterFormat,
  onPatch,
  onRemove,
  onDuplicate,
  canAdd,
}: CardRowProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const tokens = variableTokens(card.body_text, parameterFormat);
  const rules = TEMPLATE_MEDIA_RULES[card.header_format];

  /** Stage, don't upload — see uploadPendingTemplateMedia. */
  function stageFile(file: File) {
    const problem = validateTemplateMediaFile(card.header_format, file);
    if (problem) {
      toast.error(problem);
      return;
    }
    onPatch({ header_media_file: file, header_media_url: '' });
  }

  function setBodyText(text: string) {
    const count = variableTokens(text, parameterFormat).length;
    onPatch({
      body_text: text,
      body_samples: resizeSamples(card.body_samples, count),
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          Card {index + 1}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Duplicate card ${index + 1}`}
            title="Duplicate this card — keeps the button shape Meta requires"
            disabled={!canAdd}
            onClick={onDuplicate}
            className="h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove card ${index + 1}`}
            disabled={total <= 1}
            onClick={onRemove}
            className="size-7 text-muted-foreground hover:bg-red-950/30 hover:text-red-400"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={rules.accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) stageFile(f);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            className="h-7 border-border bg-transparent text-xs"
          >
            <Upload className="size-3.5" />
            Choose {card.header_format}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            or paste a public link
          </span>
        </div>

        {card.header_media_file ? (
          <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2 py-1.5">
            <span className="truncate text-xs text-foreground">
              {card.header_media_file.name}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                uploads on submit
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove card ${index + 1} file`}
                onClick={() => onPatch({ header_media_file: null })}
                className="size-6 text-muted-foreground hover:bg-red-950/30 hover:text-red-400"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <Input
            placeholder={`https://… (public ${card.header_format} link)`}
            value={card.header_media_url}
            onChange={(e) => onPatch({ header_media_url: e.target.value })}
            className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
          />
        )}
      </div>

      <TemplateBodyEditor
        value={card.body_text}
        onChange={setBodyText}
        parameterFormat={parameterFormat}
        maxLength={TEMPLATE_LIMITS.cardBodyMaxLength}
        rows={2}
        placeholder="Card body text"
        ariaLabel={`Card ${index + 1} body text`}
      />

      {tokens.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Card sample values
          </Label>
          {tokens.map((token, ti) => (
            <Input
              key={token}
              aria-label={`Card ${index + 1} sample value for {{${token}}}`}
              placeholder={`Sample for {{${token}}}`}
              value={card.body_samples[ti] ?? ''}
              onChange={(e) => {
                const next = [...card.body_samples];
                next[ti] = e.target.value;
                onPatch({ body_samples: next });
              }}
              className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
            />
          ))}
        </div>
      )}

      <TemplateButtonsEditor
        buttons={card.buttons}
        onChange={(next) => onPatch({ buttons: next })}
        parameterFormat={parameterFormat}
        label="Card buttons"
        maxButtons={TEMPLATE_LIMITS.maxCardButtons}
        minButtons={1}
        allowCopyCode={false}
        compact
        helpText="1-2 buttons per card. Quick reply, URL, and phone only."
      />
    </div>
  );
}

/**
 * Carousel card editor.
 *
 * Meta requires every card in a carousel to share the same shape — same
 * header format, same button types in the same order — so this editor
 * pushes users toward that instead of letting them build something the
 * API will reject:
 *
 *   - The header format selector is per-carousel, not per-card.
 *   - "Duplicate" copies a finished card, which is the fastest way to
 *     get matching button rows across ten cards.
 *
 * The remaining per-card freedom (media, body text, button labels and
 * targets) is exactly what Meta does allow to differ.
 */
export function TemplateCardsEditor({
  cards,
  onChange,
  parameterFormat,
}: TemplateCardsEditorProps) {
  const headerFormat = cards[0]?.header_format ?? 'image';
  const canAdd = cards.length < TEMPLATE_LIMITS.maxCarouselCards;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-muted-foreground">
            Carousel cards ({cards.length}/{TEMPLATE_LIMITS.maxCarouselCards})
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Every card must use the same media type and the same button
            types, in the same order — Meta rejects mismatched cards.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={headerFormat}
            onValueChange={(val) => {
              if (!val) return;
              const format = val as CardFormData['header_format'];
              // Applies to every card at once: a carousel with mixed
              // media formats can't be submitted at all. Staged files are
              // dropped because a picked MP4 isn't a valid image.
              onChange(
                cards.map((c) => ({
                  ...c,
                  header_format: format,
                  header_media_file:
                    c.header_format === format ? c.header_media_file : null,
                })),
              );
            }}
          >
            <SelectTrigger className="h-8 w-32 border-border bg-muted text-xs text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              <SelectItem
                value="image"
                className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
              >
                Image cards
              </SelectItem>
              <SelectItem
                value="video"
                className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
              >
                Video cards
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
            disabled={!canAdd}
            onClick={() => onChange([...cards, emptyCard(headerFormat)])}
          >
            <Plus className="size-3" />
            Add Card
          </Button>
        </div>
      </div>

      {cards.map((card, i) => (
        <CardRow
          key={i}
          card={card}
          index={i}
          total={cards.length}
          parameterFormat={parameterFormat}
          canAdd={canAdd}
          onPatch={(patch) =>
            onChange(cards.map((c, x) => (x === i ? { ...c, ...patch } : c)))
          }
          onRemove={() => onChange(cards.filter((_, x) => x !== i))}
          onDuplicate={() =>
            onChange([
              ...cards.slice(0, i + 1),
              { ...card, buttons: card.buttons.map((b) => ({ ...b })) },
              ...cards.slice(i + 1),
            ])
          }
        />
      ))}
    </div>
  );
}
