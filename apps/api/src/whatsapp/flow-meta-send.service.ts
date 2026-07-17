import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from './meta-api.util';
import { decrypt } from './encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from './phone-utils.util';

// ------------------------------------------------------------
// Flows-side Meta sender (text / media / interactive variants).
//
// Ported from apps/web/src/lib/flows/meta-send.ts (engineSendText /
// engineSendMedia / engineSendInteractiveButtons /
// engineSendInteractiveList). Mirrors AutomationMetaSendService but
// emits the flows engine's message kinds. Kept separate from the
// automations sender so the two engines don't fight over each
// other's shape — once both stabilize, the phone-variant retry +
// DB persistence are obvious extraction candidates into a shared base.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

interface SendMediaArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  kind: MediaKind;
  /** Public URL Meta fetches at send time. */
  link: string;
  caption?: string;
  /** Document-only; ignored by Meta for image/video. */
  filename?: string;
}

interface SendInteractiveButtonsArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
}

interface SendInteractiveListArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
}

/** Internal discriminated union. `send` is the tag; SendMediaArgs keeps
 *  its public `kind: MediaKind` field un-shadowed. */
type SendInput =
  | (SendTextArgs & { send: 'text' })
  | (SendMediaArgs & { send: 'media' })
  | (SendInteractiveButtonsArgs & { send: 'buttons' })
  | (SendInteractiveListArgs & { send: 'list' });

@Injectable()
export class FlowMetaSendService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Send a plain-text WhatsApp message from the Flows engine.
   * Used by the runner's `send_message` and `collect_input` nodes.
   */
  async sendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, send: 'text' });
  }

  /**
   * Send an image / video / document from the Flows engine (`send_media`
   * node). Persists the outgoing message with `content_type` matching
   * the media kind so the inbox renders the right preview.
   */
  async sendMedia(
    args: SendMediaArgs,
  ): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, send: 'media' });
  }

  /**
   * Send an interactive-button WhatsApp message from the Flows engine.
   * Returns the Meta message id so the engine can stash it on
   * `flow_runs.last_prompt_message_id`.
   */
  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, send: 'buttons' });
  }

  /**
   * Send an interactive-list WhatsApp message from the Flows engine.
   * Used when the flow needs more than 3 options (Meta's button cap).
   */
  async sendInteractiveList(
    args: SendInteractiveListArgs,
  ): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, send: 'list' });
  }

  private async sendViaMeta(
    input: SendInput,
  ): Promise<{ whatsapp_message_id: string }> {
    // Scope the contact + whatsapp_config lookups by account_id —
    // Prisma bypasses RLS entirely, so without this filter a run
    // could send via one tenant's WhatsApp config to another
    // tenant's contact UUID.
    const contact = await this.prisma.contacts.findFirst({
      where: { id: input.contactId, account_id: input.accountId },
      select: { id: true, phone: true },
    });
    if (!contact?.phone) {
      throw new Error('contact not found for this account');
    }

    const sanitized = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(sanitized)) {
      throw new Error(`contact phone invalid: ${contact.phone}`);
    }

    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: input.accountId },
    });
    if (!config) {
      throw new Error('WhatsApp not configured for this account');
    }

    const accessToken = decrypt(config.access_token);

    const attempt = async (phone: string): Promise<string> => {
      if (input.send === 'text') {
        const r = await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          text: input.text,
        });
        return r.messageId;
      }
      if (input.send === 'media') {
        const r = await sendMediaMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          kind: input.kind,
          link: input.link,
          caption: input.caption,
          filename: input.filename,
        });
        return r.messageId;
      }
      if (input.send === 'buttons') {
        const r = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: input.bodyText,
          buttons: input.buttons,
          headerText: input.headerText,
          footerText: input.footerText,
        });
        return r.messageId;
      }
      const r = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttonLabel: input.buttonLabel,
        sections: input.sections,
        headerText: input.headerText,
        footerText: input.footerText,
      });
      return r.messageId;
    };

    // Same phone-variant retry as the automations sender — Meta sandbox
    // and numbers registered with/without a trunk 0 both require this
    // to reliably land a message.
    const variants = phoneVariants(sanitized);
    let workingPhone = sanitized;
    let waMessageId = '';
    let lastError: unknown = null;
    for (const v of variants) {
      try {
        waMessageId = await attempt(v);
        workingPhone = v;
        lastError = null;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(msg)) throw err;
        lastError = err;
      }
    }
    if (lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error('meta-send failed after exhausting phone variants');
    }

    if (workingPhone !== sanitized) {
      await this.prisma.contacts.update({
        where: { id: contact.id },
        data: { phone: workingPhone },
      });
    }

    // Persist the bot's message so it appears in the inbox with a real
    // Meta message id. sender_type='bot' distinguishes flow sends from
    // manual agent sends. content_type: 'text' | media kind |
    // 'interactive' — the last preserves the "Button reply" affordance.
    let contentType: string;
    let contentText: string | null;
    let preview: string;
    if (input.send === 'text') {
      contentType = 'text';
      contentText = input.text;
      preview = input.text;
    } else if (input.send === 'media') {
      contentType = input.kind;
      contentText = input.caption ?? null;
      preview = input.caption?.trim() || `[${input.kind}]`;
    } else {
      contentType = 'interactive';
      contentText = input.bodyText;
      preview = input.bodyText;
    }

    try {
      await this.prisma.messages.create({
        data: {
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: contentType,
          content_text: contentText,
          message_id: waMessageId,
          status: 'sent',
        },
      });
    } catch (err) {
      // Meta already has the message; record the DB error but don't
      // pretend the send failed. The engine wraps this in a log line.
      throw new Error(
        `sent to Meta but DB insert failed: ${(err as Error).message}`,
      );
    }

    await this.prisma.conversations.update({
      where: { id: input.conversationId },
      data: {
        last_message_text: preview,
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { whatsapp_message_id: waMessageId };
  }
}
