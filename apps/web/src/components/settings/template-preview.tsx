'use client';

import { Fragment, type ReactNode } from 'react';
import {
  ExternalLink,
  FileText,
  Image as ImageIcon,
  MapPin,
  Phone,
  Play,
  Copy,
} from 'lucide-react';
import type { TemplateButton } from '@/types';
import { useObjectUrl } from '@/hooks/use-object-url';
import { renderTemplateBody } from '@/lib/whatsapp/template-send-builder';
import type { CardFormData, TemplateFormData } from '@/lib/whatsapp/template-form';

/**
 * Render WhatsApp's inline formatting — `*bold*`, `_italic_`,
 * `~strikethrough~`, and ```monospace``` — as elements rather than raw
 * markers, so the preview shows what the recipient sees.
 *
 * Deliberately not a markdown library: WhatsApp's rules are narrower
 * (single-character delimiters, no nesting worth honouring) and the
 * output has to stay plain React nodes — no HTML injection path.
 */
const FORMAT_RULES: { pattern: RegExp; wrap: (node: ReactNode) => ReactNode }[] =
  [
    { pattern: /\*([^*\n]+)\*/, wrap: (n) => <strong>{n}</strong> },
    { pattern: /_([^_\n]+)_/, wrap: (n) => <em>{n}</em> },
    { pattern: /~([^~\n]+)~/, wrap: (n) => <s>{n}</s> },
    {
      pattern: /```([^`\n]+)```/,
      wrap: (n) => <code className="font-mono text-[0.9em]">{n}</code>,
    },
  ];

function formatWhatsAppText(text: string): ReactNode[] {
  // Find whichever delimiter appears earliest, format it, then recurse
  // on the remainder. Scanning by earliest match keeps `*a* _b_` in
  // order regardless of which rule is listed first.
  let earliest: { index: number; length: number; inner: string; wrap: (n: ReactNode) => ReactNode } | null =
    null;
  for (const rule of FORMAT_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (!earliest || match.index < earliest.index) {
      earliest = {
        index: match.index,
        length: match[0].length,
        inner: match[1],
        wrap: rule.wrap,
      };
    }
  }
  if (!earliest) return [text];
  return [
    text.slice(0, earliest.index),
    earliest.wrap(earliest.inner),
    ...formatWhatsAppText(text.slice(earliest.index + earliest.length)),
  ];
}

function FormattedText({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {formatWhatsAppText(text).map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </span>
  );
}

const BUTTON_ICONS: Record<TemplateButton['type'], typeof Phone> = {
  QUICK_REPLY: ExternalLink,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

function PreviewButtons({ buttons }: { buttons: TemplateButton[] }) {
  const filled = buttons.filter((b) => b.text.trim());
  if (filled.length === 0) return null;
  return (
    <div className="mt-1 space-y-1">
      {filled.map((b, i) => {
        const Icon = b.type === 'QUICK_REPLY' ? null : BUTTON_ICONS[b.type];
        return (
          <div
            key={i}
            className="flex items-center justify-center gap-1.5 rounded-md bg-white px-2 py-1.5 text-[13px] font-medium text-[#00a5f4] shadow-sm dark:bg-[#1f2c33]"
          >
            {Icon && <Icon className="size-3.5" />}
            <span className="truncate">{b.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Media placeholder — the real asset may only exist as a URL Meta fetches. */
function MediaBlock({
  kind,
  url,
  className = '',
}: {
  kind: 'image' | 'video' | 'document' | 'location';
  url?: string;
  className?: string;
}) {
  const showImage = kind === 'image' && !!url;
  const Icon =
    kind === 'image'
      ? ImageIcon
      : kind === 'video'
        ? Play
        : kind === 'document'
          ? FileText
          : MapPin;

  return (
    <div
      className={`flex items-center justify-center overflow-hidden rounded-md bg-black/5 dark:bg-white/5 ${className}`}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="max-h-32 w-full object-cover" />
      ) : (
        <div className="flex h-20 w-full flex-col items-center justify-center gap-1 text-muted-foreground">
          <Icon className="size-6" />
          <span className="text-[10px] uppercase tracking-wide">
            {kind === 'location' ? 'Map pin at send time' : kind}
          </span>
        </div>
      )}
    </div>
  );
}

function CardPreview({ card }: { card: CardFormData }) {
  const body = renderTemplateBody(card.body_text, {
    body: card.body_samples,
  });
  // A staged file has no URL yet, so preview it from its blob.
  const blobUrl = useObjectUrl(card.header_media_file);
  return (
    <div className="w-44 shrink-0 rounded-lg bg-white p-1.5 shadow-sm dark:bg-[#202c33]">
      <MediaBlock
        kind={card.header_format}
        url={blobUrl || card.header_media_url}
        className="mb-1.5"
      />
      {body.trim() ? (
        <p className="px-0.5 text-[12px] leading-snug text-[#111b21] dark:text-[#e9edef]">
          <FormattedText text={body} />
        </p>
      ) : (
        <p className="px-0.5 text-[12px] italic text-muted-foreground">
          Card body…
        </p>
      )}
      <PreviewButtons buttons={card.buttons} />
    </div>
  );
}

/**
 * WhatsApp-style preview of the template being built. Values come from
 * the sample inputs, which is exactly what Meta's reviewers see — so a
 * template that reads badly here reads badly in review.
 */
export function TemplatePreview({
  form,
  headerBlobUrl,
}: {
  form: TemplateFormData;
  /**
   * Blob URL for a staged-but-not-uploaded header file. Passed in rather
   * than derived here so the owning dialog controls the blob's lifetime —
   * this component re-renders on every keystroke in the body.
   */
  headerBlobUrl?: string;
}) {
  const isCarousel = form.template_type === 'CAROUSEL';
  const body = renderTemplateBody(form.body_text, { body: form.body_samples });
  const headerText = renderTemplateBody(form.header_content, {
    body: form.header_sample ? [form.header_sample] : [],
  });

  const mediaKind =
    form.template_type === 'IMAGE'
      ? 'image'
      : form.template_type === 'VIDEO'
        ? 'video'
        : form.template_type === 'FILE'
          ? 'document'
          : form.template_type === 'LOCATION'
            ? 'location'
            : null;

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <p className="mb-2 text-center text-xs font-medium text-muted-foreground">
        Preview
      </p>
      <div className="rounded-lg bg-[#e5ddd5] p-2.5 dark:bg-[#0b141a]">
        <div className="max-w-[17rem] rounded-lg rounded-tl-none bg-white p-2 shadow-sm dark:bg-[#202c33]">
          {mediaKind && (
            <MediaBlock
              kind={mediaKind}
              url={headerBlobUrl || form.header_media_url}
              className="mb-1.5"
            />
          )}
          {form.template_type === 'TEXT' && headerText.trim() && (
            <p className="mb-1 px-0.5 text-[14px] font-semibold text-[#111b21] dark:text-[#e9edef]">
              <FormattedText text={headerText} />
            </p>
          )}

          {body.trim() ? (
            <p className="px-0.5 text-[13.5px] leading-snug text-[#111b21] dark:text-[#e9edef]">
              <FormattedText text={body} />
            </p>
          ) : (
            <p className="px-0.5 text-[13.5px] italic text-muted-foreground">
              Your message body appears here.
            </p>
          )}

          {!isCarousel && form.footer_text.trim() && (
            <p className="mt-1 px-0.5 text-[11px] text-muted-foreground">
              {form.footer_text}
            </p>
          )}

          {!isCarousel && <PreviewButtons buttons={form.buttons} />}
        </div>

        {isCarousel && form.cards.length > 0 && (
          // Cards scroll horizontally exactly as they do on a phone; the
          // container owns the overflow so the dialog never scrolls
          // sideways.
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
            {form.cards.map((card, i) => (
              <CardPreview key={i} card={card} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
