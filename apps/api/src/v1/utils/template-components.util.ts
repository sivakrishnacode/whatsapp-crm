/**
 * Translate our local template row shape into the `components` array
 * shape that Meta's POST /{waba_id}/message_templates endpoint expects.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

import {
  extractNamedVariables,
  resolveParameterFormat,
  isCarouselTemplate,
  type TemplatePayload,
} from './template-validators.util';
import type {
  TemplateButton,
  TemplateCard,
  TemplateParameterFormat,
} from '../types/index';

/**
 * NAMED templates carry their examples as {param_name, example} pairs
 * instead of a bare ordered array. The names are not stored separately:
 * they are read back out of the template text in order of first
 * appearance and zipped against the ordered sample array.
 */
export interface MetaNamedParam {
  param_name: string;
  example: string;
}

export interface MetaComponentExample {
  header_text?: string[];
  header_text_named_params?: MetaNamedParam[];
  header_url?: string[];
  header_handle?: string[];
  body_text?: string[][];
  body_text_named_params?: MetaNamedParam[];
}

export interface MetaCarouselCard {
  components: MetaComponent[];
}

export interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'CAROUSEL';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  text?: string;
  buttons?: MetaButtonPayload[];
  cards?: MetaCarouselCard[];
  example?: MetaComponentExample;
}

interface MetaButtonPayload {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE';
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[];
}

const MEDIA_FORMATS = {
  image: 'IMAGE',
  video: 'VIDEO',
  document: 'DOCUMENT',
} as const;

/**
 * Build the `example` for a piece of variable-bearing text. Returns
 * undefined when there is nothing to exemplify, so callers can assign
 * it unconditionally without emitting an empty object.
 */
function buildTextExample(
  text: string,
  samples: string[] | undefined,
  format: TemplateParameterFormat,
  kind: 'body' | 'header',
): MetaComponentExample | undefined {
  if (!samples || samples.length === 0) return undefined;

  if (format === 'NAMED') {
    const names = extractNamedVariables(text);
    const named = names
      .map((param_name, i) => ({ param_name, example: samples[i] }))
      .filter((p): p is MetaNamedParam => Boolean(p.example));
    if (named.length === 0) return undefined;
    return kind === 'body'
      ? { body_text_named_params: named }
      : { header_text_named_params: named };
  }

  // Meta expects body_text as a 2D array — outer is "examples", inner is
  // the values for each variable. We submit a single example row.
  // header_text is flat: a text header takes at most one variable.
  return kind === 'body' ? { body_text: [samples] } : { header_text: samples };
}

function buildHeaderComponent(
  payload: TemplatePayload,
  format: TemplateParameterFormat,
): MetaComponent | null {
  // header_media_url is deliberately not read: Meta wants the uploaded
  // handle, not the URL (see requireHandle).
  const { header_type, header_content, header_handle } = payload;
  if (!header_type) return null;

  // LOCATION headers are declared bare. Meta supplies the map pin from
  // the send-time parameters, so there is no text and no example.
  if (header_type === 'location') {
    return { type: 'HEADER', format: 'LOCATION' };
  }

  if (header_type === 'text') {
    const component: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header_content,
    };
    const example = buildTextExample(
      header_content ?? '',
      payload.sample_values?.header,
      format,
      'header',
    );
    if (example) component.example = example;
    return component;
  }

  const component: MetaComponent = {
    type: 'HEADER',
    format: MEDIA_FORMATS[header_type],
  };
  component.example = {
    header_handle: [requireHandle(header_handle, 'Header')],
  };
  return component;
}

/**
 * Media samples MUST be Resumable-Upload handles. A public URL in
 * `header_url` is rejected by the live API ("Missing sample parameter for
 * title type"), so there is no useful fallback to emit — failing loudly
 * here beats sending a payload Meta will refuse.
 *
 * `resolveTemplateMediaHandles` is what turns the builder's URL into a
 * handle; reaching this throw means it was skipped.
 */
function requireHandle(handle: string | undefined, where: string): string {
  if (!handle) {
    throw new Error(
      `${where} media has no uploaded Meta handle. The sample must be uploaded to Meta before submitting (resolveTemplateMediaHandles).`,
    );
  }
  return handle;
}

function buildBodyComponent(
  payload: TemplatePayload,
  format: TemplateParameterFormat,
): MetaComponent {
  const component: MetaComponent = {
    type: 'BODY',
    text: payload.body_text,
  };
  const example = buildTextExample(
    payload.body_text,
    payload.sample_values?.body,
    format,
    'body',
  );
  if (example) component.example = example;
  return component;
}

function buildFooterComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.footer_text?.trim()) return null;
  return { type: 'FOOTER', text: payload.footer_text };
}

function buildButtonPayload(b: TemplateButton): MetaButtonPayload {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL': {
      const payload: MetaButtonPayload = {
        type: 'URL',
        text: b.text,
        url: b.url,
      };
      if (b.example) payload.example = [b.example];
      return payload;
    }
    case 'PHONE_NUMBER':
      return {
        type: 'PHONE_NUMBER',
        text: b.text,
        phone_number: b.phone_number,
      };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: [b.example] };
  }
}

function buildButtonsComponent(
  buttons: TemplateButton[] | undefined,
): MetaComponent | null {
  if (!buttons || buttons.length === 0) return null;
  return {
    type: 'BUTTONS',
    buttons: buttons.map(buildButtonPayload),
  };
}

/**
 * One carousel card: HEADER (image/video) → BODY → BUTTONS, the same
 * canonical order as the outer template. `card_index` is deliberately
 * absent — Meta assigns it from array position at creation and only
 * expects it back on the send-time payload.
 */
function buildCardComponents(
  card: TemplateCard,
  format: TemplateParameterFormat,
): MetaCarouselCard {
  const header: MetaComponent = {
    type: 'HEADER',
    format: card.header_format === 'video' ? 'VIDEO' : 'IMAGE',
    example: { header_handle: [requireHandle(card.header_handle, 'Card')] },
  };

  const body: MetaComponent = { type: 'BODY', text: card.body_text };
  const bodyExample = buildTextExample(
    card.body_text,
    card.body_samples,
    format,
    'body',
  );
  if (bodyExample) body.example = bodyExample;

  const components: MetaComponent[] = [header, body];
  const buttons = buildButtonsComponent(card.buttons);
  if (buttons) components.push(buttons);
  return { components };
}

function buildCarouselComponent(
  payload: TemplatePayload,
  format: TemplateParameterFormat,
) {
  const cards = payload.cards ?? [];
  if (cards.length === 0) return null;
  return {
    type: 'CAROUSEL' as const,
    cards: cards.map((card) => buildCardComponents(card, format)),
  };
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: MetaComponent[];
  /**
   * Omitted for POSITIONAL — that is Meta's default, and not sending it
   * keeps every pre-existing template's payload byte-identical.
   */
  parameter_format?: TemplateParameterFormat;
}

const CATEGORY_TO_META: Record<
  'Marketing' | 'Utility' | 'Authentication',
  MetaTemplateSubmitPayload['category']
> = {
  Marketing: 'MARKETING',
  Utility: 'UTILITY',
  Authentication: 'AUTHENTICATION',
};

/**
 * Assemble the full submit payload.
 *
 * Component order is canonical: HEADER → BODY → FOOTER → BUTTONS for a
 * regular template, and BODY → CAROUSEL for a carousel (which has no
 * outer header, footer, or buttons — see validateCarousel).
 */
export function buildMetaTemplatePayload(
  payload: TemplatePayload,
): MetaTemplateSubmitPayload {
  const format = resolveParameterFormat(payload.parameter_format);
  const components: MetaComponent[] = [];

  if (isCarouselTemplate(payload)) {
    components.push(buildBodyComponent(payload, format));
    const carousel = buildCarouselComponent(payload, format);
    if (carousel) components.push(carousel);
  } else {
    const header = buildHeaderComponent(payload, format);
    if (header) components.push(header);
    components.push(buildBodyComponent(payload, format));
    const footer = buildFooterComponent(payload);
    if (footer) components.push(footer);
    const buttons = buildButtonsComponent(payload.buttons);
    if (buttons) components.push(buttons);
  }

  const out: MetaTemplateSubmitPayload = {
    name: payload.name,
    category: CATEGORY_TO_META[payload.category],
    language: payload.language,
    components,
  };
  if (format === 'NAMED') out.parameter_format = 'NAMED';
  return out;
}
