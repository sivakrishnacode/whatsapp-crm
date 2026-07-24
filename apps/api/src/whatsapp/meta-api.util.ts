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

import { buildSendComponents, type SendTimeParams } from '../v1/utils/template-send-builder.util';
import type { MessageTemplate } from '../v1/types/index';

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
  template?: MessageTemplate;
  messageParams?: SendTimeParams;
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string;
}

/**
 * Send a pre-approved WhatsApp message template. Required outside the
 * 24-hour window and for any first-touch messaging.
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
    template,
    messageParams,
    contextMessageId,
  } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  };

  if (template) {
    const components = buildSendComponents(template, {
      body: messageParams?.body ?? params,
      headerText: messageParams?.headerText,
      headerMediaUrl: messageParams?.headerMediaUrl,
      headerMediaId: messageParams?.headerMediaId,
      buttonParams: messageParams?.buttonParams,
    });
    if (components.length > 0) {
      templatePayload.components = components;
    }
  } else if (params && params.length > 0) {
    // Legacy body-only path — no template row available.
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
  listSectionTitleMaxLength: 24,
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
    if (section.title && section.title.length > INTERACTIVE_LIMITS.listSectionTitleMaxLength) {
      throw new Error(
        `Interactive list section title "${section.title}" exceeds ${INTERACTIVE_LIMITS.listSectionTitleMaxLength} chars.`,
      );
    }
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

export interface SendProductMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  catalogId: string;
  productRetailerId: string;
  bodyText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export async function sendProductMessage(
  args: SendProductMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    catalogId,
    productRetailerId,
    bodyText,
    footerText,
    contextMessageId,
  } = args;
  
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const body: any = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'product',
      action: {
        catalog_id: catalogId,
        product_retailer_id: productRetailerId,
      },
    },
  };

  if (bodyText) {
    body.interactive.body = { text: bodyText };
  }
  if (footerText) {
    body.interactive.footer = { text: footerText };
  }
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

export interface SendProductListMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  catalogId: string;
  headerText: string;
  bodyText: string;
  footerText?: string;
  sections: Array<{
    title: string;
    productRetailerIds: string[];
  }>;
  contextMessageId?: string;
}

export async function sendProductListMessage(
  args: SendProductListMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    catalogId,
    headerText,
    bodyText,
    footerText,
    sections,
    contextMessageId,
  } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const body: any = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: {
        type: 'text',
        text: headerText,
      },
      body: {
        text: bodyText,
      },
      action: {
        catalog_id: catalogId,
        sections: sections.map((s) => ({
          title: s.title,
          product_items: s.productRetailerIds.map((id) => ({
            product_retailer_id: id,
          })),
        })),
      },
    },
  };

  if (footerText) {
    body.interactive.footer = { text: footerText };
  }
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

// ============================================================
// Phone number / account / Signup
// ============================================================

export interface MetaPhoneInfo {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
}

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Verify a Meta phone number ID by fetching its public metadata.
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs,
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args;
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  return response.json();
}

export interface ExchangeEmbeddedSignupCodeArgs {
  code: string;
  appId: string;
  appSecret: string;
}

export interface ExchangeEmbeddedSignupCodeResult {
  accessToken: string;
  expiresIn?: number;
}

export async function exchangeEmbeddedSignupCode(
  args: ExchangeEmbeddedSignupCodeArgs,
): Promise<ExchangeEmbeddedSignupCodeResult> {
  const { code, appId, appSecret } = args;

  // Step 1: code -> short-lived user access token.
  const shortLivedUrl =
    `${META_API_BASE}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;
  const shortLivedRes = await fetch(shortLivedUrl);
  if (!shortLivedRes.ok) {
    await throwMetaError(shortLivedRes, 'Failed to exchange authorization code');
  }
  const shortLivedData = (await shortLivedRes.json()) as { access_token?: string };
  if (!shortLivedData.access_token) {
    throw new Error('Meta did not return an access token for this authorization code');
  }

  // Step 2: short-lived -> long-lived user access token.
  const longLivedUrl =
    `${META_API_BASE}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortLivedData.access_token)}`;
  const longLivedRes = await fetch(longLivedUrl);
  if (!longLivedRes.ok) {
    await throwMetaError(longLivedRes, 'Failed to exchange long-lived access token');
  }
  const longLivedData = (await longLivedRes.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!longLivedData.access_token) {
    throw new Error('Meta did not return a long-lived access token');
  }

  return { accessToken: longLivedData.access_token, expiresIn: longLivedData.expires_in };
}

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
  pin: string;
}

export interface RegisterPhoneNumberResult {
  success: boolean;
  alreadyRegistered: boolean;
}

/**
 * Register a phone number for inbound webhook events.
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs,
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/register`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });

  if (response.ok) {
    return { success: true, alreadyRegistered: false };
  }

  let data: { error?: { message?: string; code?: number; error_subcode?: number } } = {};
  try {
    data = await response.json();
  } catch {
    /* keep empty */
  }
  const message = data.error?.message ?? `Meta API error: ${response.status}`;
  if (/already.*registered/i.test(message)) {
    return { success: true, alreadyRegistered: true };
  }
  throw new Error(message);
}

export interface SubscribeWabaToAppArgs {
  wabaId: string;
  accessToken: string;
}

/**
 * Subscribe the WABA to this Meta app's webhook.
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs,
): Promise<void> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
}

export interface GetSubscribedAppsArgs {
  wabaId: string;
  accessToken: string;
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string;
    name?: string;
    link?: string;
  };
}

/**
 * Diagnostic — fetch the list of apps currently subscribed to this WABA.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs,
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { data?: SubscribedApp[] };
  return data.data ?? [];
}

// ============================================================
// Resumable Upload
// ============================================================

export interface UploadResumableMediaArgs {
  appId: string;
  accessToken: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export async function uploadResumableMedia(
  args: UploadResumableMediaArgs,
): Promise<{ handle: string }> {
  const { appId, accessToken, fileName, mimeType, bytes } = args;

  const startParams = new URLSearchParams({
    file_name: fileName,
    file_length: String(bytes.byteLength),
    file_type: mimeType,
    access_token: accessToken,
  });
  const startRes = await fetch(
    `${META_API_BASE}/${appId}/uploads?${startParams.toString()}`,
    { method: 'POST' },
  );
  if (!startRes.ok) {
    await throwMetaError(startRes, `Resumable upload start failed: ${startRes.status}`);
  }
  const startData = (await startRes.json()) as { id?: string };
  if (!startData.id) {
    throw new Error('Resumable upload did not return a session id.');
  }

  const uploadRes = await fetch(`${META_API_BASE}/${startData.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
    },
    body: bytes as unknown as BodyInit,
  });
  if (!uploadRes.ok) {
    await throwMetaError(uploadRes, `Resumable upload failed: ${uploadRes.status}`);
  }
  const uploadData = (await uploadRes.json()) as { h?: string };
  if (!uploadData.h) {
    throw new Error('Resumable upload did not return a file handle.');
  }
  return { handle: uploadData.h };
}

// ============================================================
// Template Submission & Management
// ============================================================

import type { MetaTemplateSubmitPayload } from '../v1/utils/template-components.util';

export interface SubmitMessageTemplateArgs {
  wabaId: string;
  accessToken: string;
  payload: MetaTemplateSubmitPayload;
}

export interface SubmitMessageTemplateResult {
  id: string;
  status: string;
  category?: string;
}

export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs,
): Promise<SubmitMessageTemplateResult> {
  const { wabaId, accessToken, payload } = args;
  const url = `${META_API_BASE}/${wabaId}/message_templates`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  if (!data?.id) {
    throw new Error('Meta accepted the template but returned no id.');
  }
  return {
    id: String(data.id),
    status: typeof data.status === 'string' ? data.status : 'PENDING',
    category: typeof data.category === 'string' ? data.category : undefined,
  };
}

export interface EditMessageTemplateArgs {
  metaTemplateId: string;
  accessToken: string;
  components: MetaTemplateSubmitPayload['components'];
  category?: MetaTemplateSubmitPayload['category'];
}

export interface EditMessageTemplateResult {
  success: boolean;
}

export async function editMessageTemplate(
  args: EditMessageTemplateArgs,
): Promise<EditMessageTemplateResult> {
  const { metaTemplateId, accessToken, components, category } = args;
  const body: Record<string, unknown> = { components };
  if (category) body.category = category;
  const response = await fetch(`${META_API_BASE}/${metaTemplateId}`, {
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
  const data = await response.json().catch(() => ({}));
  return { success: data?.success !== false };
}

export interface DeleteMessageTemplateArgs {
  wabaId: string;
  accessToken: string;
  name: string;
  metaTemplateId?: string;
}

export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs,
): Promise<void> {
  const { wabaId, accessToken, name, metaTemplateId } = args;
  const params = new URLSearchParams({ name });
  if (metaTemplateId) params.set('hsm_id', metaTemplateId);
  const url = `${META_API_BASE}/${wabaId}/message_templates?${params.toString()}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return;
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  targetMessageId: string;
  emoji: string;
}

export async function sendReactionMessage(
  args: SendReactionMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, targetMessageId, emoji } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: targetMessageId, emoji },
    }),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

// ============================================================
// Media Retrieval
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string;
  accessToken: string;
}

export async function getMediaUrl(
  args: GetMediaUrlArgs,
): Promise<{ url: string; mimeType: string }> {
  const { mediaId, accessToken } = args;
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Media fetch failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data.url) throw new Error('Media URL not found in Meta response');
  return { url: data.url, mimeType: data.mime_type || 'application/octet-stream' };
}

export interface DownloadMediaArgs {
  downloadUrl: string;
  accessToken: string;
}

export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, accessToken } = args;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`);
  }
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
}

// ============================================================
// Commerce Catalog — product sync (Catalog Batch API)
// ============================================================
//
// Products sent in WhatsApp product / product-list messages must exist in the
// Meta Commerce catalog linked to the WABA, keyed by `retailer_id` (the SKU).
// We upsert local `whatsapp_products` into that catalog via the Catalog Batch
// API: POST /{catalog-id}/items_batch.
//
// IMPORTANT: this endpoint is asynchronous. A 2xx response means Meta *queued*
// the batch — it does NOT mean every item passed validation. It returns
// `handles` which must be polled via `getCatalogBatchStatus` to surface
// per-item errors (bad price format, missing required field, etc.).
//
// Price must be formatted as "<amount> <ISO-4217 currency>", e.g. "129.99 INR"
// — a decimal string with the currency code, NOT integer minor units.

export interface CatalogProductInput {
  /** The SKU. Becomes the catalog item id + the product_retailer_id used when sending. */
  retailerId: string;
  name: string;
  description?: string | null;
  /** Numeric price amount, e.g. 129.99. */
  priceAmount: number;
  /** ISO 4217 code, e.g. "INR". */
  currency: string;
  imageUrl?: string | null;
  /** Merchant website link for the item. Optional for WhatsApp catalogs. */
  url?: string | null;
  brand?: string | null;
  available: boolean;
}

export interface CatalogBatchResult {
  handles: string[];
}

function buildCatalogItemData(p: CatalogProductInput): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: p.retailerId,
    title: p.name,
    // description is a required field and cannot be blank — fall back to name.
    description: p.description?.trim() || p.name,
    price: `${p.priceAmount.toFixed(2)} ${p.currency.toUpperCase()}`,
    availability: p.available ? 'in stock' : 'out of stock',
    condition: 'new',
  };
  if (p.imageUrl) data.image_link = p.imageUrl;
  if (p.url) data.link = p.url;
  if (p.brand) data.brand = p.brand;
  return data;
}

export interface SyncCatalogItemsArgs {
  catalogId: string;
  accessToken: string;
  products: CatalogProductInput[];
}

/**
 * Upsert products into a Meta Commerce catalog (method UPDATE = create-or-update).
 * Returns the batch handles for status polling. See the section header for the
 * async-validation caveat.
 */
export async function syncCatalogItems(
  args: SyncCatalogItemsArgs,
): Promise<CatalogBatchResult> {
  const { catalogId, accessToken, products } = args;
  if (!catalogId) throw new Error('syncCatalogItems requires a catalogId.');
  if (products.length === 0) return { handles: [] };

  const url = `${META_API_BASE}/${catalogId}/items_batch`;
  const body = {
    item_type: 'PRODUCT_ITEM',
    requests: products.map((p) => ({
      method: 'UPDATE',
      retailer_id: p.retailerId,
      data: buildCatalogItemData(p),
    })),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Catalog sync failed: ${response.status}`);
  }
  const data = (await response.json()) as { handles?: string[] };
  return { handles: data.handles ?? [] };
}

export interface DeleteCatalogItemsArgs {
  catalogId: string;
  accessToken: string;
  retailerIds: string[];
}

/**
 * Remove items from a Meta Commerce catalog by retailer_id (SKU). Best-effort:
 * unknown ids are ignored by Meta.
 */
export async function deleteCatalogItems(
  args: DeleteCatalogItemsArgs,
): Promise<CatalogBatchResult> {
  const { catalogId, accessToken, retailerIds } = args;
  if (!catalogId) throw new Error('deleteCatalogItems requires a catalogId.');
  if (retailerIds.length === 0) return { handles: [] };

  const url = `${META_API_BASE}/${catalogId}/items_batch`;
  const body = {
    item_type: 'PRODUCT_ITEM',
    requests: retailerIds.map((rid) => ({
      method: 'DELETE',
      retailer_id: rid,
      data: { id: rid },
    })),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Catalog delete failed: ${response.status}`);
  }
  const data = (await response.json()) as { handles?: string[] };
  return { handles: data.handles ?? [] };
}

export interface CatalogBatchStatusArgs {
  catalogId: string;
  accessToken: string;
  handle: string;
}

export interface CatalogBatchItemError {
  message: string;
  retailerId?: string;
}

export interface CatalogBatchStatus {
  /** Meta reports e.g. "in_progress" / "finished". */
  status: string;
  finished: boolean;
  errors: CatalogBatchItemError[];
}

/**
 * Poll the status of a batch by its handle. Parsed defensively — Meta's error
 * envelope shape has varied across versions, so we scan for anything that
 * looks like a per-item error rather than assuming one exact layout.
 */
export async function getCatalogBatchStatus(
  args: CatalogBatchStatusArgs,
): Promise<CatalogBatchStatus> {
  const { catalogId, accessToken, handle } = args;
  const params = new URLSearchParams({ handle });
  const url = `${META_API_BASE}/${catalogId}/check_batch_request_status?${params.toString()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Catalog status check failed: ${response.status}`);
  }
  const json = (await response.json()) as {
    data?: Array<{
      status?: string;
      errors?:
        | { data?: Array<{ message?: string; retailer_id?: string }> }
        | Array<{ message?: string; retailer_id?: string }>;
    }>;
  };
  const first = json.data?.[0];
  const status = first?.status ?? 'unknown';
  const rawErrors = Array.isArray(first?.errors)
    ? first?.errors
    : (first?.errors?.data ?? []);
  return {
    status,
    finished: /finish|complet|done/i.test(status),
    errors: (rawErrors ?? []).map((e) => ({
      message: e.message ?? 'Unknown error',
      retailerId: e.retailer_id,
    })),
  };
}

export interface FetchCatalogProductsArgs {
  catalogId: string;
  accessToken: string;
  /** Safety cap on total items pulled (protects against huge catalogs). */
  maxItems?: number;
}

export interface CatalogProductRecord {
  /** The SKU / content id. Empty items are filtered out by the caller. */
  retailerId: string;
  name: string;
  description: string | null;
  /** Major-unit amount, e.g. 1999.00 (Meta returns minor units — already converted). */
  priceAmount: number;
  currency: string;
  imageUrl: string | null;
  available: boolean;
}

/**
 * Meta returns a product item's `price` as an int64 in the currency's minor
 * units (e.g. 199900 = 1,999.00). Convert to a major-unit amount. Parsed
 * defensively so a formatted string ("₹1,999.00", "1999.00 INR") — which some
 * API versions/fields return — is also handled: a decimal point means the value
 * is already in major units, a bare integer means minor units.
 */
function parseMetaCatalogPrice(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw) / 100;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return 0;
    if (s.includes('.')) {
      const n = parseFloat(s.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    const digits = s.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) / 100 : 0;
  }
  return 0;
}

/**
 * Read every product in a Meta Commerce catalog (the reverse of
 * `syncCatalogItems`): GET /{catalog-id}/products, following `paging.next`
 * until exhausted or `maxItems` is reached. Used to import a catalog that was
 * built in Commerce Manager into local `whatsapp_products`.
 */
export async function fetchCatalogProducts(
  args: FetchCatalogProductsArgs,
): Promise<CatalogProductRecord[]> {
  const { catalogId, accessToken, maxItems = 2000 } = args;
  if (!catalogId) throw new Error('fetchCatalogProducts requires a catalogId.');

  const fields =
    'retailer_id,name,description,price,currency,availability,image_url';
  let url:
    | string
    | null = `${META_API_BASE}/${catalogId}/products?fields=${fields}&limit=100`;

  const out: CatalogProductRecord[] = [];
  // Bounded page walk — 100/page against a 2000 default cap is 20 pages max.
  for (let page = 0; url && out.length < maxItems && page < 50; page++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      await throwMetaError(response, `Catalog products fetch failed: ${response.status}`);
    }
    const json = (await response.json()) as {
      data?: Array<{
        retailer_id?: string;
        name?: string;
        description?: string | null;
        price?: unknown;
        currency?: string;
        availability?: string;
        image_url?: string | null;
      }>;
      paging?: { next?: string };
    };
    for (const item of json.data ?? []) {
      out.push({
        retailerId: (item.retailer_id ?? '').trim(),
        name: item.name ?? '',
        description: item.description ?? null,
        priceAmount: parseMetaCatalogPrice(item.price),
        currency: (item.currency || 'INR').toUpperCase(),
        imageUrl: item.image_url ?? null,
        available: (item.availability ?? 'in stock').toLowerCase() === 'in stock',
      });
    }
    url = json.paging?.next ?? null;
  }
  return out;
}

export interface GetCatalogInfoArgs {
  catalogId: string;
  accessToken: string;
}

export interface CatalogInfo {
  id: string;
  name: string;
  productCount?: number;
}

/**
 * Fetch basic catalog metadata. Used as a preflight before a sync: if the
 * token can't read the catalog (wrong id, or — far more commonly — the token's
 * system user isn't assigned to the catalog / lacks `catalog_management`),
 * this fails fast with Meta's real message instead of an opaque items_batch
 * error deep in the batch.
 */
export async function getCatalogInfo(
  args: GetCatalogInfoArgs,
): Promise<CatalogInfo> {
  const { catalogId, accessToken } = args;
  const url = `${META_API_BASE}/${catalogId}?fields=name,product_count`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Catalog lookup failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    id?: string;
    name?: string;
    product_count?: number;
  };
  return {
    id: data.id ?? catalogId,
    name: data.name ?? '',
    productCount: data.product_count,
  };
}

