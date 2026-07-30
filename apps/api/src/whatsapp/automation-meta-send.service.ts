import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sendTextMessage, sendTemplateMessage } from './meta-api.util';
import { decrypt } from '../common/security/encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from './phone-utils.util';
import { renderTemplateBody } from '../v1/utils/template-send-builder.util';

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Ported from apps/web/src/lib/automations/meta-send.ts. Mirrors the
// logic in the Next.js manual-send route but uses PrismaService (the
// engine has no cookies) and accepts the account/user/conversation/
// contact identifiers the engine already has on hand.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

interface SendTemplateArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  templateName: string;
  language?: string;
  params?: string[];
}

type SendInput =
  (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' });

@Injectable()
export class AutomationMetaSendService {
  constructor(private readonly prisma: PrismaService) {}

  async sendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, kind: 'text' });
  }

  async sendTemplate(
    args: SendTemplateArgs,
  ): Promise<{ whatsapp_message_id: string }> {
    return this.sendViaMeta({ ...args, kind: 'template' });
  }

  private async sendViaMeta(
    input: SendInput,
  ): Promise<{ whatsapp_message_id: string }> {
    // Scope the contact + config lookups by account_id, not user_id.
    // Prisma bypasses RLS entirely, so without this filter an
    // authenticated user could fire their own automations against
    // another tenant's contact UUID and send via their own WhatsApp
    // config to that contact's phone.
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
      if (input.kind === 'template') {
        const r = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName: input.templateName,
          language: input.language,
          params: input.params,
        });
        return r.messageId;
      }
      const r = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: input.text,
      });
      return r.messageId;
    };

    // Same phone-variant retry as the manual send route — Meta sandbox
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

    // Persist the sent message so it appears in the inbox with a real
    // Meta message id. sender_type='bot' distinguishes automation sends
    // from manual agent sends.
    const content_type = input.kind === 'template' ? 'template' : 'text';
    const template_name = input.kind === 'template' ? input.templateName : null;
    // Meta renders a template from its own approved copy and returns only
    // a message id, so the body has to be reconstructed locally or the
    // inbox shows an empty bubble. Read-only lookup — the payload already
    // sent to Meta above is untouched by this.
    const content_text =
      input.kind === 'text'
        ? input.text
        : await this.renderSentTemplateBody(input);

    try {
      await this.prisma.messages.create({
        data: {
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type,
          content_text,
          template_name,
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
        last_message_text:
          input.kind === 'template'
            ? (content_text ?? `[template:${input.templateName}]`)
            : input.text,
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { whatsapp_message_id: waMessageId };
  }

  /**
   * The body text of a template we just sent, with `{{n}}` placeholders
   * filled from the automation's params — what the recipient sees.
   *
   * Returns null when the template isn't in our table (it can be
   * approved at Meta but not yet synced locally); callers fall back to a
   * `[template:name]` marker rather than failing a send that Meta has
   * already accepted.
   */
  private async renderSentTemplateBody(
    input: SendTemplateArgs,
  ): Promise<string | null> {
    const row = await this.prisma.message_templates.findFirst({
      where: {
        account_id: input.accountId,
        name: input.templateName,
        language: input.language || 'en_US',
      },
      select: { body_text: true },
    });
    if (!row?.body_text) return null;
    return renderTemplateBody(row.body_text, { body: input.params });
  }
}
