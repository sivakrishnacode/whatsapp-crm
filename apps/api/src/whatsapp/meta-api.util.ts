/**
 * Meta WhatsApp Cloud API helpers — automations + flows slice.
 *
 * Ported from apps/web/src/lib/whatsapp/meta-api.ts. Contains the
 * calls the automations engine makes (`sendTextMessage`,
 * `sendTemplateMessage`'s legacy body-params path) plus the flows
 * engine's senders (`sendMediaMessage`, `sendInteractiveButtons`,
 * `sendInteractiveList` and the `INTERACTIVE_LIMITS` they and the
 * flow validator share) — the full file also covers embedded signup,
 * template management, media proxying, reactions, and product
 * messages, none of which either engine uses. Port the rest here
 * if/when a later phase (WhatsApp domain) needs it.
 *
 * Every function takes a single options object (named parameters)
 * rather than positional arguments — deliberate, matches the source.
 */

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export interface MetaSendResult {
  messageId: string;
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

interface MetaSendResponse {
  messages: Array<{ id: string }>;
}

async function throwMetaError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

export interface SendTextMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  text: string;
  /** Meta's message_id of the message being replied to. Adds a `context` field
   *  so WhatsApp renders the new message as a reply with a quote preview. */
  contextMessageId?: string;
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  };
  if (contextMessageId) {
    body.context = { message_id: contextMessageId };
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as MetaSendResponse;
  return { messageId: data.messages[0].id };
}

export interface SendTemplateMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  language?: string;
  /** Body-only variable values, in order. */
  params?: string[];
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string;
}

/**
 * Send a pre-approved WhatsApp message template. Required outside the
 * 24-hour window and for any first-touch messaging.
 *
 * Only the legacy body-params path is ported — automation `send_template`
 * steps never pass a full `MessageTemplate` row (that's the flows/inbox
 * caller's structured path, not ported here).
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'en_US',
    params,
    contextMessageId,
  } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  };
  if (params && params.length > 0) {
    templatePayload.components = [
      {
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      },
    ];
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: templatePayload,
  };
  if (contextMessageId) {
    body.context = { message_id: contextMessageId };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const metaErr = await (response
      .json()
      .catch(() => null) as Promise<MetaErrorResponse | null>);
    const errMsg =
      metaErr?.error?.message ?? `Meta API error: ${response.status}`;
    throw new Error(errMsg);
  }
  const data = (await response.json()) as MetaSendResponse;
  return { messageId: data.messages[0].id };
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio';

export interface SendMediaMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  kind: MediaKind;
  /** Public URL Meta fetches at send time. */
  link: string;
  /** Optional caption — Meta caps at 1024 chars. Documents + images + videos accept it; audio does NOT. */
  caption?: string;
  /** Document-only. Shown in the recipient's chat as the file name. Ignored for image/video/audio. */
  filename?: string;
  contextMessageId?: string;
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Used by the Flows engine's `send_media` node. Mirrors `sendTextMessage`
 * — single fetch, throws on non-2xx, returns Meta's message id.
 *
 * Audio is special-cased: Meta rejects `caption` and `filename` on audio
 * messages, so we send `{ link }` only. WhatsApp auto-renders an
 * OGG/Opus file as a playable voice note (waveform) rather than a file
 * attachment.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    kind,
    link,
    caption,
    filename,
    contextMessageId,
  } = args;
  if (!link) throw new Error('sendMediaMessage requires a link.');
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;

  // Audio accepts neither caption nor filename per Meta's spec — adding
  // either yields a 400. image/video/document accept a caption; only
  // document accepts a filename.
  const media: Record<string, unknown> = { link };
  if (caption && kind !== 'audio') media.caption = caption;
  if (kind === 'document' && filename) media.filename = filename;

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: kind,
    [kind]: media,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as MetaSendResponse;
  return { messageId: data.messages[0].id };
}

/**
 * Meta limits for interactive messages, hard-coded so violations
 * fail at build/save time rather than as a 400 from the Meta API
 * mid-conversation. See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const;

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string;
  /** Visible label (≤ 20 chars per Meta). */
  title: string;
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  /** The body text — what the customer reads above the buttons. */
  bodyText: string;
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string;
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string;
  /** 1–3 buttons. Validated against Meta's limits before sending. */
  buttons: InteractiveButton[];
  /** Meta's message_id of the message being replied to (quote preview). */
  contextMessageId?: string;
}

/**
 * Send an interactive message with up to 3 inline reply buttons. The
 * customer taps one and Meta delivers a webhook with
 * `messages[0].interactive.button_reply.id` set to the matching button.id.
 *
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save time, not during a live conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    headerText,
    footerText,
    buttons,
    contextMessageId,
  } = args;
  validateInteractiveBody(bodyText);
  validateInteractiveHeaderFooter(headerText, footerText);
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`,
    );
  }
  for (const btn of buttons) {
    if (!btn.id) throw new Error('Interactive button missing id.');
    if (!btn.title)
      throw new Error(`Interactive button "${btn.id}" missing title.`);
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
      );
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as MetaSendResponse;
  return { messageId: data.messages[0].id };
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string;
  /** Visible row title (≤ 24 chars per Meta). */
  title: string;
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string;
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string;
  rows: InteractiveListRow[];
}

export interface SendInteractiveListArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  bodyText: string;
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  /**
   * 1–10 rows TOTAL across all sections. Meta caps the *total*, not
   * per-section. Validation enforces this before send.
   */
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 * Webhook arrives with `messages[0].interactive.list_reply.id` set to
 * the matching row.id.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    buttonLabel,
    headerText,
    footerText,
    sections,
    contextMessageId,
  } = args;
  validateInteractiveBody(bodyText);
  validateInteractiveHeaderFooter(headerText, footerText);
  if (!buttonLabel) throw new Error('Interactive list requires a buttonLabel.');
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
    );
  }
  if (
    sections.length < 1 ||
    sections.length > INTERACTIVE_LIMITS.maxListSections
  ) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`,
    );
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`,
    );
  }
  const seenIds = new Set<string>();
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error('Interactive list row missing id.');
      if (seenIds.has(row.id)) {
        throw new Error(`Interactive list has duplicate row id "${row.id}".`);
      }
      seenIds.add(row.id);
      if (!row.title)
        throw new Error(`Interactive list row "${row.id}" missing title.`);
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`,
        );
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`,
        );
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as MetaSendResponse;
  return { messageId: data.messages[0].id };
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error('Interactive message requires bodyText.');
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`,
    );
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (
    headerText &&
    headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength
  ) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`,
    );
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`,
    );
  }
}
