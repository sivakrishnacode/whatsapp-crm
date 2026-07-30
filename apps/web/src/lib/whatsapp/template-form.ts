/**
 * Form state for the template builder, kept out of the component so the
 * mapping between "what the user sees" and "what Meta receives" is
 * testable on its own.
 *
 * The builder presents ONE selector — "Template Type" — the way Meta's
 * own manager and every competing CRM does. It covers two things Meta
 * models separately: the header format (none / text / media / location)
 * and the CAROUSEL shape, which is not a header at all but a different
 * template layout. `templateTypeToHeader` is where that collapse is
 * undone.
 */

import type {
  MessageTemplate,
  TemplateButton,
  TemplateCard,
  TemplateParameterFormat,
  TemplateSampleValues,
} from '@/types';
import {
  extractNamedVariables,
  extractVariableIndices,
} from './template-validators';

/** FILE is Meta's DOCUMENT — the label users recognise. */
export type TemplateTypeOption =
  | 'NONE'
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'LOCATION'
  | 'CAROUSEL';

export const TEMPLATE_TYPE_OPTIONS: {
  value: TemplateTypeOption;
  label: string;
  hint: string;
}[] = [
  { value: 'NONE', label: 'NONE', hint: 'Body text only' },
  { value: 'TEXT', label: 'TEXT', hint: 'Text header above the body' },
  { value: 'IMAGE', label: 'IMAGE', hint: 'JPEG or PNG header' },
  { value: 'VIDEO', label: 'VIDEO', hint: 'MP4 header' },
  { value: 'FILE', label: 'FILE', hint: 'PDF or document header' },
  { value: 'LOCATION', label: 'LOCATION', hint: 'Map pin set at send time' },
  { value: 'CAROUSEL', label: 'CAROUSEL', hint: 'Up to 10 swipeable cards' },
];

export interface CardFormData {
  header_format: 'image' | 'video';
  header_media_url: string;
  /**
   * A file chosen but NOT yet uploaded. Upload happens on submit (see
   * `uploadPendingTemplateMedia`) so an abandoned draft leaves nothing
   * behind in storage. Takes precedence over `header_media_url`.
   */
  header_media_file: File | null;
  body_text: string;
  body_samples: string[];
  buttons: TemplateButton[];
}

export interface TemplateFormData {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  parameter_format: TemplateParameterFormat;
  template_type: TemplateTypeOption;
  header_content: string;
  header_media_url: string;
  /** Chosen but not yet uploaded — see CardFormData.header_media_file. */
  header_media_file: File | null;
  header_sample: string;
  body_text: string;
  body_samples: string[];
  footer_text: string;
  buttons: TemplateButton[];
  cards: CardFormData[];
}

export const emptyTemplateForm: TemplateFormData = {
  name: '',
  category: 'Marketing',
  language: 'en_US',
  parameter_format: 'POSITIONAL',
  template_type: 'NONE',
  header_content: '',
  header_media_url: '',
  header_media_file: null,
  header_sample: '',
  body_text: '',
  body_samples: [],
  footer_text: '',
  buttons: [],
  cards: [],
};

export function emptyButton(type: TemplateButton['type']): TemplateButton {
  switch (type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: '' };
    case 'URL':
      return { type: 'URL', text: '', url: '' };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: '', phone_number: '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: '', example: '' };
  }
}

export function emptyCard(
  headerFormat: CardFormData['header_format'] = 'image',
): CardFormData {
  return {
    header_format: headerFormat,
    header_media_url: '',
    header_media_file: null,
    body_text: '',
    body_samples: [],
    // Meta requires at least one button per card, so a new card starts
    // with one rather than an empty list the user has to discover.
    buttons: [emptyButton('QUICK_REPLY')],
  };
}

const TYPE_TO_HEADER: Record<
  TemplateTypeOption,
  MessageTemplate['header_type'] | undefined
> = {
  NONE: undefined,
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  FILE: 'document',
  LOCATION: 'location',
  // A carousel's media lives on its cards; the outer bubble has no header.
  CAROUSEL: undefined,
};

export function templateTypeToHeader(
  type: TemplateTypeOption,
): MessageTemplate['header_type'] | undefined {
  return TYPE_TO_HEADER[type];
}

export function templateTypeFromRow(
  row: Pick<MessageTemplate, 'header_type' | 'cards'>,
): TemplateTypeOption {
  if (row.cards?.length) return 'CAROUSEL';
  switch (row.header_type) {
    case 'text':
      return 'TEXT';
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'document':
      return 'FILE';
    case 'location':
      return 'LOCATION';
    default:
      return 'NONE';
  }
}

export function typeNeedsMedia(type: TemplateTypeOption): boolean {
  return type === 'IMAGE' || type === 'VIDEO' || type === 'FILE';
}

/**
 * The placeholders in a piece of text, in the order their sample-value
 * inputs should appear. Positional tokens come back as `['1','2']` so
 * both schemes share one code path in the UI.
 */
export function variableTokens(
  text: string,
  format: TemplateParameterFormat,
): string[] {
  return format === 'NAMED'
    ? extractNamedVariables(text)
    : extractVariableIndices(text).map(String);
}

/**
 * The placeholder "Add Variable" should insert next. Positional picks up
 * after the highest existing index (not the count) so inserting into
 * text that already has `{{1}} {{3}}` can't produce a duplicate; named
 * falls back to variable_1, variable_2, … which the user then renames.
 */
export function nextVariableToken(
  text: string,
  format: TemplateParameterFormat,
): string {
  if (format === 'NAMED') {
    const used = new Set(extractNamedVariables(text));
    let n = 1;
    while (used.has(`variable_${n}`)) n++;
    return `variable_${n}`;
  }
  const indices = extractVariableIndices(text);
  return String((indices[indices.length - 1] ?? 0) + 1);
}

/** Resize a sample array to match its text's placeholder count. */
export function resizeSamples(samples: string[], count: number): string[] {
  if (samples.length === count) return samples;
  const next = samples.slice(0, count);
  while (next.length < count) next.push('');
  return next;
}

export function formFromTemplate(row: MessageTemplate): TemplateFormData {
  return {
    name: row.name,
    category: row.category,
    language: row.language || 'en_US',
    parameter_format: row.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    template_type: templateTypeFromRow(row),
    header_content: row.header_content ?? '',
    header_media_url: row.header_media_url ?? '',
    // Editing starts from what Meta already has; nothing is pending
    // until the user picks a new file.
    header_media_file: null,
    header_sample: row.sample_values?.header?.[0] ?? '',
    body_text: row.body_text,
    body_samples: row.sample_values?.body ?? [],
    footer_text: row.footer_text ?? '',
    buttons: row.buttons ?? [],
    cards: (row.cards ?? []).map((card) => ({
      header_format: card.header_format === 'video' ? 'video' : 'image',
      header_media_url: card.header_media_url ?? '',
      header_media_file: null,
      body_text: card.body_text,
      body_samples: card.body_samples ?? [],
      buttons: card.buttons ?? [],
    })),
  };
}

export interface TemplateSubmitPayload {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  parameter_format: TemplateParameterFormat;
  header_type?: MessageTemplate['header_type'];
  header_content?: string;
  header_media_url?: string;
  /**
   * Meta Resumable-Upload handle for the media sample. The browser never
   * sets this — the API mints it at submit from `header_media_url`
   * (resolveTemplateMediaHandles), because Meta rejects a plain URL. Part
   * of the type so the wire contract is visible from this side too.
   */
  header_handle?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  cards?: TemplateCard[];
  sample_values?: TemplateSampleValues;
}

/**
 * Form → submit payload. Only the fields that apply to the chosen
 * template type are emitted, so switching type in the UI without
 * clearing the old inputs can't smuggle a stale header URL or an
 * orphaned footer into the Meta payload.
 */
export function buildTemplateSubmitPayload(
  form: TemplateFormData,
): TemplateSubmitPayload {
  const isCarousel = form.template_type === 'CAROUSEL';
  const headerType = templateTypeToHeader(form.template_type);

  const sample_values: TemplateSampleValues = {};
  if (form.body_samples.some((v) => v.trim())) {
    sample_values.body = form.body_samples.map((v) => v.trim());
  }
  if (headerType === 'text' && form.header_sample.trim()) {
    sample_values.header = [form.header_sample.trim()];
  }

  return {
    name: form.name.trim(),
    category: form.category,
    language: form.language.trim() || 'en_US',
    parameter_format: form.parameter_format,
    header_type: headerType,
    header_content: headerType === 'text' ? form.header_content.trim() : undefined,
    header_media_url: typeNeedsMedia(form.template_type)
      ? form.header_media_url.trim() || undefined
      : undefined,
    body_text: form.body_text.trim(),
    footer_text: isCarousel ? undefined : form.footer_text.trim() || undefined,
    buttons: isCarousel || form.buttons.length === 0 ? undefined : form.buttons,
    cards: isCarousel
      ? form.cards.map((card) => ({
          header_format: card.header_format,
          header_media_url: card.header_media_url.trim() || undefined,
          body_text: card.body_text.trim(),
          body_samples: card.body_samples.map((v) => v.trim()),
          buttons: card.buttons,
        }))
      : undefined,
    sample_values:
      Object.keys(sample_values).length > 0 ? sample_values : undefined,
  };
}
