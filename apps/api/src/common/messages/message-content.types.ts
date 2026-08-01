import type { Prisma } from '@prisma/client';

/**
 * The shape of `messages.metadata` for WhatsApp rows.
 *
 * `content_type` says which renderer to use; anything that renderer
 * needs beyond `content_text` and `media_url` lives here. The column is
 * shared with Instagram, which writes its own keys (`ig_attachment_type`,
 * `reel_video_id`, `title`) — so this is a partial contract, not an
 * exhaustive one. Never overwrite the whole object; merge.
 *
 * Mirrored in apps/web/src/types/index.ts. The two must agree, because
 * the inbox reads these rows straight out of Supabase and the API is
 * what writes them.
 */

/** A template button exactly as the customer saw it. */
export interface MessageTemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE';
  text: string;
  /** URL buttons only, with any {{1}} already substituted. */
  url?: string;
  /** PHONE_NUMBER buttons only. */
  phone_number?: string;
}

/**
 * What an outbound template actually looked like on the customer's
 * phone.
 *
 * Meta renders templates from its own approved copy and returns only a
 * message id, so nothing about the rendered message comes back to us.
 * Before this, only the substituted body text was stored — which is why
 * a template with an image header appeared in the inbox as a bare
 * paragraph while the customer saw a photo, a footer and two buttons.
 * The snapshot is taken at send time because it is the only moment all
 * the pieces are in one place, and because a template edited or deleted
 * later must not change what the thread says was sent.
 */
export interface MessageTemplateSnapshot {
  /** Template name as submitted to Meta. Also on messages.template_name. */
  name: string;
  language?: string | null;
  header?: {
    type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    /** TEXT headers, variables already substituted. */
    text?: string | null;
    /** IMAGE/VIDEO/DOCUMENT headers — directly renderable. */
    media_url?: string | null;
    /** DOCUMENT headers, for the filename shown on the card. */
    filename?: string | null;
  } | null;
  footer?: string | null;
  buttons?: MessageTemplateButton[];
}

/** One card from a `contacts` message. */
export interface MessageContactCard {
  name: string;
  phones: Array<{ phone: string; type?: string | null }>;
  emails?: Array<{ email: string; type?: string | null }>;
  organization?: string | null;
}

/** One line of a submitted cart. */
export interface MessageOrderItem {
  retailer_id: string;
  name?: string | null;
  quantity: number;
  unit_price: number;
  currency?: string | null;
}

export interface WhatsAppMessageMetadata {
  /**
   * Where a stored 'interactive' row came from. Meta uses `button` for a
   * tap on a *template's* quick-reply button and `interactive` for a tap
   * on an interactive message; both mean "the customer tapped something
   * we sent", so both are stored as content_type 'interactive' and
   * distinguished here rather than by splitting the renderer.
   */
  source?: 'template_button' | 'interactive_reply' | 'flow_reply';
  template?: MessageTemplateSnapshot;
  contacts?: MessageContactCard[];
  order?: {
    catalog_id?: string | null;
    items: MessageOrderItem[];
    total?: number;
    currency?: string | null;
    note?: string | null;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string | null;
    address?: string | null;
  };
  /** `unsupported` rows — why WhatsApp could not deliver the content. */
  error?: {
    code?: number | null;
    title?: string | null;
    detail?: string | null;
  };
  /** Submitted WhatsApp Flow response, keyed by the flow's field names. */
  flow_response?: Record<string, unknown>;
  /** Sticker rows: animated stickers render differently from static. */
  animated?: boolean;
}

/**
 * Hand a metadata object to Prisma's Json column.
 *
 * Prisma's `InputJsonValue` requires an index signature, which a
 * precise interface deliberately does not have — that is what makes a
 * typo'd key an error rather than a silently-written field. The cast is
 * confined here, once, so the three write sites keep their type
 * checking and none of them grows an inline `as unknown as`.
 *
 * `undefined` (not `null`) for an absent value: Prisma reads that as
 * "leave the column alone", whereas `null` would ask for a JSON null.
 */
export function toMessageMetadata(
  metadata: WhatsAppMessageMetadata | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!metadata) return undefined;
  return metadata as unknown as Prisma.InputJsonValue;
}
