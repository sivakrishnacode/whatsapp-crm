/**
 * Meta WhatsApp Cloud API helpers — automations-only slice.
 *
 * Ported from apps/web/src/lib/whatsapp/meta-api.ts. Only the two
 * calls the automations engine actually makes (`sendTextMessage`,
 * `sendTemplateMessage`'s legacy body-params path) are included —
 * the full file also covers embedded signup, template management,
 * media proxying, reactions, and interactive/product messages, none
 * of which any automation step type uses. Port the rest here if/when
 * a later phase (WhatsApp domain) needs it.
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
