/**
 * Build the Meta `components` array used by POST /{phone_number_id}/messages
 * when sending an APPROVED template.
 *
 * Distinct from `template-components.ts` — that module builds the
 * `components` for TEMPLATE CREATION (where you describe headers,
 * footers, buttons, examples). This module builds the per-send
 * `components` (where you fill in variable values and supply the
 * actual media link or button URL suffix for THIS specific delivery).
 *
 * Auto-fills as much as possible from the template row so callers
 * only need to supply values for the variable-bearing fields:
 *
 *   - Static IMAGE/VIDEO/DOCUMENT headers ride along automatically
 *     using the template's `header_media_url` (or `header_handle`).
 *     Meta requires the media component on every send even though
 *     the URL hasn't changed since approval.
 *   - TEXT headers with `{{1}}` need `headerText` from the caller.
 *   - Body variables come in as `body: string[]`, indexed by {{N}}.
 *   - URL buttons with `{{1}}` need `buttonUrlParams[i]` keyed by
 *     button index. URL buttons without variables, plus QUICK_REPLY
 *     and PHONE_NUMBER buttons, don't need send-time parameters.
 *   - COPY_CODE buttons need the actual code to display. We fall
 *     back to the template's `example` value if the caller doesn't
 *     override — that matches the most common use case (a static
 *     promo code) without forcing UI work.
 *   - LOCATION headers need `headerLocation` every time. The pin is a
 *     per-send value, so unlike media there is nothing on the template
 *     row to fall back to.
 *   - NAMED templates ({{customer_name}}) accept either `bodyNamed`
 *     keyed by name or the same ordered `body` array as positional
 *     ones, resolved by order of first appearance in the text.
 *   - CAROUSEL templates take `cards[i]`, mirroring the per-card
 *     shape: media, body values, button overrides.
 *
 * Validation throws here (not at the Meta API boundary) so a missing
 * sample surfaces as "Header text variable {{1}} requires a value",
 * not a 400 from Meta that doesn't say which field broke.
 */

import type {
  MessageTemplate,
  TemplateButton,
  TemplateCard,
} from '@/types';
import {
  extractNamedVariables,
  extractVariableIndices,
} from './template-validators';

/** Meta's send-time map pin for a LOCATION header. */
export interface TemplateLocationParam {
  latitude: string;
  longitude: string;
  name?: string;
  address?: string;
}

/** Per-card send-time values for a CAROUSEL template, indexed by card. */
export interface CardSendParams {
  headerMediaUrl?: string;
  headerMediaId?: string;
  body?: string[];
  bodyNamed?: Record<string, string>;
  buttonParams?: Record<number, string>;
}

export interface SendTimeParams {
  body?: string[];
  /**
   * NAMED templates only: body values keyed by parameter name. Takes
   * precedence over `body` per name; anything missing falls back to the
   * positional array, so a caller that knows nothing about named
   * parameters keeps working unchanged.
   */
  bodyNamed?: Record<string, string>;
  headerText?: string;
  headerMediaUrl?: string;
  headerMediaId?: string;
  /** Required for LOCATION headers — the pin is per send, not per template. */
  headerLocation?: TemplateLocationParam;
  buttonParams?: Record<number, string>;
  /** CAROUSEL templates: one entry per card, in card order. */
  cards?: CardSendParams[];
}

export interface MetaSendCard {
  card_index: number;
  components: MetaSendComponent[];
}

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | {
      type: 'button';
      sub_type: 'url' | 'quick_reply' | 'copy_code';
      index: string;
      parameters: MetaSendParameter[];
    }
  | { type: 'carousel'; cards: MetaSendCard[] };

type MetaSendParameter =
  | { type: 'text'; text: string; parameter_name?: string }
  | { type: 'image'; image: { link?: string; id?: string } }
  | { type: 'video'; video: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string } }
  | { type: 'location'; location: TemplateLocationParam }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string };

/**
 * Resolve the ordered values for one piece of variable-bearing text,
 * whichever parameter scheme it uses.
 *
 * NAMED text yields parameters that carry `parameter_name` — Meta
 * matches on the name, not the position, but it still wants them as an
 * array. Values are read from the named map first, then from the
 * positional array by order of first appearance, so both calling styles
 * work against the same template.
 */
function buildTextParameters(
  text: string,
  positional: string[] | undefined,
  named: Record<string, string> | undefined,
  where: string,
): MetaSendParameter[] | null {
  const names = extractNamedVariables(text);
  const values = positional ?? [];

  if (names.length > 0) {
    return names.map((name, i) => {
      const value = named?.[name] ?? values[i];
      if (value === undefined || value === null || !String(value).trim()) {
        throw new Error(
          `${where} variable {{${name}}} requires a value at send time.`,
        );
      }
      return { type: 'text', parameter_name: name, text: String(value) };
    });
  }

  const varCount = extractVariableIndices(text).length;
  if (varCount === 0 && values.length === 0) return null;
  if (values.length < varCount) {
    throw new Error(
      `${where} has ${varCount} variable(s) but only ${values.length} value(s) were supplied.`,
    );
  }
  return values
    .slice(0, varCount)
    .map((value) => ({ type: 'text', text: String(value) }));
}

function buildMediaParameter(
  kind: 'image' | 'video' | 'document',
  link: string | undefined,
  id: string | undefined,
): MetaSendParameter {
  const media: { link?: string; id?: string } = id ? { id } : { link };
  if (kind === 'image') return { type: 'image', image: media };
  if (kind === 'video') return { type: 'video', video: media };
  return { type: 'document', document: media };
}

function buildHeaderComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const headerType = template.header_type;
  if (!headerType) return null;

  if (headerType === 'location') {
    const loc = params.headerLocation;
    if (!loc?.latitude || !loc?.longitude) {
      throw new Error(
        'Location header requires latitude and longitude at send time — pass headerLocation.',
      );
    }
    return { type: 'header', parameters: [{ type: 'location', location: loc }] };
  }

  if (headerType === 'text') {
    // A text header takes at most one variable, so `headerText` covers
    // both schemes — the only difference is that NAMED sends carry the
    // parameter's name alongside the value. Static text headers ride
    // along inside the template itself; no header component needed.
    const content = template.header_content ?? '';
    const names = extractNamedVariables(content);
    const varCount = names.length || extractVariableIndices(content).length;
    if (varCount === 0) return null;
    const token = names[0] ?? '1';
    const value = params.headerText;
    if (!value || !value.trim()) {
      throw new Error(
        `Header text variable {{${token}}} requires a value — pass headerText.`,
      );
    }
    return {
      type: 'header',
      parameters: [
        names.length > 0
          ? { type: 'text', parameter_name: names[0], text: value }
          : { type: 'text', text: value },
      ],
    };
  }

  const link = params.headerMediaUrl ?? template.header_media_url;
  const id = params.headerMediaId;
  if (!link && !id) {
    throw new Error(
      `${headerType} header requires a media link or id at send time — set header_media_url on the template or pass headerMediaUrl/headerMediaId.`,
    );
  }
  return {
    type: 'header',
    parameters: [buildMediaParameter(headerType, link, id)],
  };
}

function buildBodyComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const parameters = buildTextParameters(
    template.body_text,
    params.body,
    params.bodyNamed,
    'Body',
  );
  return parameters ? { type: 'body', parameters } : null;
}

function buttonNeedsSendParam(
  button: TemplateButton,
  override: string | undefined,
): boolean {
  switch (button.type) {
    case 'URL':
      return (
        extractVariableIndices(button.url).length > 0 ||
        extractNamedVariables(button.url).length > 0
      );
    case 'COPY_CODE':
      return true;
    case 'QUICK_REPLY':
    case 'PHONE_NUMBER':
      return override !== undefined;
  }
}

function buildButtonComponent(
  button: TemplateButton,
  index: number,
  override: string | undefined,
  where = 'URL button',
): MetaSendComponent | null {
  if (!buttonNeedsSendParam(button, override)) return null;

  switch (button.type) {
    case 'URL': {
      if (!override || !override.trim()) {
        const token =
          extractNamedVariables(button.url)[0] ??
          extractVariableIndices(button.url)[0];
        throw new Error(
          `${where} #${index + 1} uses {{${token}}} — requires a buttonParams[${index}] value.`,
        );
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: override }],
      };
    }
    case 'COPY_CODE': {
      const code = override?.trim() || button.example;
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: code }],
      };
    }
    case 'QUICK_REPLY': {
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override! }],
      };
    }
    case 'PHONE_NUMBER':
      return null;
  }
}

/**
 * One carousel card's send-time components. Meta requires the card's
 * media on every send — same rule as a media header — so the card's
 * stored sample URL is used when the caller supplies no override.
 */
function buildCardComponent(
  card: TemplateCard,
  cardIndex: number,
  params: CardSendParams | undefined,
): MetaSendCard {
  const label = `Card #${cardIndex + 1}`;
  const components: MetaSendComponent[] = [];

  const link = params?.headerMediaUrl ?? card.header_media_url;
  const id = params?.headerMediaId;
  if (!link && !id) {
    throw new Error(
      `${label} requires a media link or id at send time — set header_media_url on the card or pass cards[${cardIndex}].headerMediaUrl.`,
    );
  }
  components.push({
    type: 'header',
    parameters: [
      buildMediaParameter(
        card.header_format === 'video' ? 'video' : 'image',
        link,
        id,
      ),
    ],
  });

  const bodyParams = buildTextParameters(
    card.body_text,
    params?.body,
    params?.bodyNamed,
    `${label} body`,
  );
  if (bodyParams) components.push({ type: 'body', parameters: bodyParams });

  (card.buttons ?? []).forEach((btn, i) => {
    const component = buildButtonComponent(
      btn,
      i,
      params?.buttonParams?.[i],
      `${label} URL button`,
    );
    if (component) components.push(component);
  });

  return { card_index: cardIndex, components };
}

/**
 * The template body with its placeholders substituted — i.e. the text
 * WhatsApp actually renders on the recipient's device.
 *
 * Needed because Meta renders templates from its own approved copy: the
 * send response returns only a message id, so nothing carries the text
 * back for us to store. Callers persist this as the message's
 * `content_text`, otherwise the sent bubble renders empty in the inbox.
 *
 * Handles both parameter schemes off the text alone — `{{1}}` reads the
 * positional array, `{{name}}` reads the named map and falls back to the
 * positional array by order of first appearance. Placeholders with no
 * supplied value are left verbatim rather than blanked, which keeps a
 * partially-filled body readable.
 */
export function renderTemplateBody(
  bodyText: string,
  params: SendTimeParams = {},
): string {
  const values = params.body ?? [];
  const order = extractNamedVariables(bodyText);
  return bodyText.replace(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
    (placeholder, raw: string) => {
      const value = /^\d+$/.test(raw)
        ? values[Number(raw) - 1]
        : (params.bodyNamed?.[raw] ?? values[order.indexOf(raw)]);
      if (value === undefined || value === null) return placeholder;
      const text = String(value);
      return text.trim().length > 0 ? text : placeholder;
    },
  );
}

export function buildSendComponents(
  template: MessageTemplate,
  params: SendTimeParams = {},
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];
  const cards = template.cards ?? [];

  // A carousel is body + carousel only. Its cards carry the media and
  // the buttons, and Meta rejects an outer header/button component on
  // one — so the regular branch is skipped entirely rather than merged.
  if (cards.length > 0) {
    const body = buildBodyComponent(template, params);
    if (body) out.push(body);
    out.push({
      type: 'carousel',
      cards: cards.map((card, i) =>
        buildCardComponent(card, i, params.cards?.[i]),
      ),
    });
    return out;
  }

  const header = buildHeaderComponent(template, params);
  if (header) out.push(header);
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  if (template.buttons?.length) {
    template.buttons.forEach((btn, i) => {
      const override = params.buttonParams?.[i];
      const component = buildButtonComponent(btn, i, override);
      if (component) out.push(component);
    });
  }
  return out;
}
