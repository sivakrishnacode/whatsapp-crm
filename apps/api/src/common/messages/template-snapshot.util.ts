import { renderTemplateBody } from '../../v1/utils/template-send-builder.util';
import type { SendTimeParams } from '../../v1/utils/template-send-builder.util';
import type {
  MessageTemplateSnapshot,
  MessageTemplateButton,
} from './message-content.types';

/**
 * Capture what an outbound template will look like on the customer's
 * phone, for storage on the message row.
 *
 * ## Why this has to happen at send time
 *
 * Meta renders templates from its own approved copy and returns only a
 * message id — nothing about the rendered message comes back. Only the
 * substituted body was being stored, so a template with an image
 * header, a footer and two buttons appeared in the inbox as a bare
 * paragraph while the customer was looking at a photo and two tappable
 * buttons. An agent reading the thread could not see what they had
 * actually sent, which matters most for exactly the messages where it
 * is least obvious: a promo blast whose opt-out button the customer
 * then taps.
 *
 * It is a *snapshot*, not a join to `message_templates`, for two
 * reasons. A template can be edited or deleted after the send, and the
 * thread must keep saying what was actually delivered. And the header
 * media and URL-button values are per-send substitutions that exist
 * nowhere on the template row.
 */
export function buildTemplateSnapshot(
  template: {
    name: string;
    language?: string | null;
    header_type?: string | null;
    header_content?: string | null;
    header_media_url?: string | null;
    footer_text?: string | null;
    buttons?: unknown;
  },
  params?: SendTimeParams,
): MessageTemplateSnapshot {
  return {
    name: template.name,
    language: template.language ?? null,
    header: buildHeader(template, params),
    footer: template.footer_text ?? null,
    buttons: buildButtons(template.buttons, params),
  };
}

function buildHeader(
  template: {
    header_type?: string | null;
    header_content?: string | null;
    header_media_url?: string | null;
  },
  params?: SendTimeParams,
): MessageTemplateSnapshot['header'] {
  const type = template.header_type?.toUpperCase();
  if (!type || type === 'NONE') return null;

  if (type === 'TEXT') {
    // A TEXT header can carry its own {{1}}. `headerText` is the
    // send-time value; fall back to the approved copy so the snapshot
    // is never emptier than the template itself.
    return {
      type: 'TEXT',
      text: params?.headerText || template.header_content || null,
    };
  }

  if (type === 'IMAGE' || type === 'VIDEO' || type === 'DOCUMENT') {
    // Send-time media wins: the caller may override the template's
    // default per message. `headerMediaId` (a Meta media handle) is
    // deliberately not recorded — it is not fetchable from the browser,
    // so a URL-less snapshot correctly renders as "media unavailable"
    // rather than a broken image.
    return {
      type,
      media_url: params?.headerMediaUrl || template.header_media_url || null,
      filename: type === 'DOCUMENT' ? (template.header_content ?? null) : null,
    };
  }

  if (type === 'LOCATION') {
    const loc = params?.headerLocation;
    return {
      type: 'LOCATION',
      text: loc ? [loc.name, loc.address].filter(Boolean).join(' — ') : null,
    };
  }

  return null;
}

/**
 * Normalize the template's `buttons` JSON into the snapshot shape,
 * substituting any send-time URL suffix.
 *
 * Defensive about the input because `message_templates.buttons` is an
 * untyped Json column — rows predate the current shape, and a template
 * synced from Meta can carry button types this app never creates. A bad
 * entry is dropped rather than throwing: losing one button off a
 * preview is a far better outcome than failing the send.
 */
function buildButtons(
  raw: unknown,
  params?: SendTimeParams,
): MessageTemplateButton[] {
  if (!Array.isArray(raw)) return [];

  const out: MessageTemplateButton[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const button = entry as Record<string, unknown>;
    // Narrowed rather than String()-coerced: the column is untyped
    // Json, so `type` can be an object, and stringifying that yields
    // "[object Object]" — which matches nothing and silently falls
    // through to the quick-reply branch.
    const type =
      typeof button.type === 'string' ? button.type.toUpperCase() : '';
    const text = typeof button.text === 'string' ? button.text : '';
    if (!text) return;

    if (type === 'URL') {
      const base = typeof button.url === 'string' ? button.url : '';
      const substitution = params?.buttonParams?.[index];
      out.push({
        type: 'URL',
        text,
        // Meta appends the send-time value to the approved prefix — it
        // replaces the trailing {{1}} rather than being the whole URL.
        url: substitution
          ? base.replace(/\{\{\s*1\s*\}\}/, substitution)
          : base,
      });
      return;
    }

    if (type === 'PHONE_NUMBER') {
      out.push({
        type: 'PHONE_NUMBER',
        text,
        phone_number:
          typeof button.phone_number === 'string' ? button.phone_number : '',
      });
      return;
    }

    if (type === 'COPY_CODE') {
      out.push({ type: 'COPY_CODE', text });
      return;
    }

    // Everything else is a quick reply as far as the inbox is
    // concerned: a label the customer can tap, with no destination.
    out.push({ type: 'QUICK_REPLY', text });
  });

  return out;
}

/**
 * The body text a template will send with, or null when it cannot be
 * derived (the template row is not held locally).
 *
 * Thin wrapper over `renderTemplateBody` so the two call sites that
 * need both a snapshot and the rendered body read the same way.
 */
export function renderSnapshotBody(
  bodyText: string | null | undefined,
  params?: SendTimeParams,
): string | null {
  if (!bodyText) return null;
  return renderTemplateBody(bodyText, params);
}
