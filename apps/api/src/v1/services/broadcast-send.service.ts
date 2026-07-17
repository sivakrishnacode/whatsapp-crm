import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sendTemplateMessage } from '../../whatsapp/meta-api.util';
import { decrypt } from '../../whatsapp/encryption.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '../utils/phone.util';
import { findOrCreateContact } from '../utils/contacts.util';
import { ApiError } from '../utils/respond.util';
import { WebhookDeliverService } from './webhook-deliver.service';

const MAX_RECIPIENTS = 1000;

export interface BroadcastRecipientInput {
  to: string;
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: any;
  planned: PlannedRecipient[];
  rejected: number;
}

function isMessageTemplate(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  return (
    typeof row.id === 'string' &&
    typeof row.userId === 'string' &&
    typeof row.name === 'string' &&
    typeof row.bodyText === 'string'
  );
}

@Injectable()
export class BroadcastSendService {
  private readonly logger = new Logger(BroadcastSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  async createBroadcast(
    accountId: string,
    auditUserId: string,
    params: CreateBroadcastParams,
  ): Promise<BroadcastPlan> {
    const { name, templateName, recipients } = params;
    const templateLanguage = params.templateLanguage || 'en_US';

    if (!templateName) {
      throw new ApiError('bad_request', "'template_name' is required", HttpStatus.BAD_REQUEST);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new ApiError(
        'bad_request',
        "'recipients' must be a non-empty array of { to, params? }",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new ApiError(
        'bad_request',
        `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: accountId },
    });
    if (!config) {
      throw new ApiError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const accessToken = decrypt(config.access_token);

    const rawTemplateRow = await this.prisma.message_templates.findFirst({
      where: {
        account_id: accountId,
        name: templateName,
        language: templateLanguage,
      },
    });
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      throw new ApiError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const resolved: { contactId: string; phone: string; params: string[] }[] = [];
    let rejected = 0;
    for (const r of recipients) {
      const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
      if (!isValidE164(sanitized)) {
        rejected++;
        continue;
      }
      const { id } = await findOrCreateContact(
        this.prisma,
        this.webhookDeliver,
        accountId,
        auditUserId,
        { phone: sanitized },
      );
      resolved.push({
        contactId: id,
        phone: sanitized,
        params: Array.isArray(r.params)
          ? r.params.filter((p): p is string => typeof p === 'string')
          : [],
      });
    }

    const seenContact = new Set<string>();
    const deduped = resolved.filter((r) => {
      if (seenContact.has(r.contactId)) return false;
      seenContact.add(r.contactId);
      return true;
    });

    if (deduped.length === 0) {
      throw new ApiError(
        'bad_request',
        'No recipients had a valid E.164 phone number',
        HttpStatus.BAD_REQUEST,
      );
    }

    const broadcast = await this.prisma.broadcasts.create({
      data: {
        account_id: accountId,
        user_id: auditUserId,
        name: name || `API broadcast (${templateName})`,
        template_name: templateName,
        template_language: templateLanguage,
        status: 'sending',
        total_recipients: deduped.length,
      },
      select: { id: true },
    });

    // Create the broadcast_recipients rows in a batch
    await this.prisma.broadcast_recipients.createMany({
      data: deduped.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        status: 'pending',
      })),
    });

    const recipientRows = await this.prisma.broadcast_recipients.findMany({
      where: { broadcast_id: broadcast.id },
      select: { id: true, contact_id: true },
    });

    const byContact = new Map(deduped.map((r) => [r.contactId, r]));
    const planned: PlannedRecipient[] = recipientRows.map((row) => {
      const r = byContact.get(row.contact_id as string)!;
      return { recipientRowId: row.id, phone: r.phone, params: r.params };
    });

    return {
      broadcastId: broadcast.id,
      templateName,
      templateLanguage,
      phoneNumberId: config.phone_number_id,
      accessToken,
      templateRow: rawTemplateRow ?? null,
      planned,
      rejected,
    };
  }

  async deliverBroadcast(plan: BroadcastPlan): Promise<void> {
    let sentCount = 0;

    for (const recipient of plan.planned) {
      const variants = phoneVariants(recipient.phone);
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: plan.phoneNumberId,
            accessToken: plan.accessToken,
            to: variant,
            templateName: plan.templateName,
            language: plan.templateLanguage,
            template: plan.templateRow ?? undefined,
            params: recipient.params,
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (error: any) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          lastError = message;
          if (!isRecipientNotAllowedError(message)) break;
        }
      }

      try {
        if (sentMessageId) {
          sentCount++;
          await this.prisma.broadcast_recipients.update({
            where: { id: recipient.recipientRowId },
            data: {
              status: 'sent',
              sent_at: new Date(),
              whatsapp_message_id: sentMessageId,
              error_message: null,
            },
          });
        } else {
          await this.prisma.broadcast_recipients.update({
            where: { id: recipient.recipientRowId },
            data: {
              status: 'failed',
              error_message: lastError || 'Unknown error',
            },
          });
        }
      } catch (err: any) {
        this.logger.error(
          `[broadcast-core] failed updating recipient ${recipient.recipientRowId}: ${err?.message || err}`,
        );
      }
    }

    try {
      await this.prisma.broadcasts.update({
        where: { id: plan.broadcastId },
        data: {
          status: sentCount > 0 ? 'sent' : 'failed',
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.error(
        `[broadcast-core] failed updating final status for ${plan.broadcastId}: ${err?.message || err}`,
      );
    }
  }
}
