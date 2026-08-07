import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizePhoneForMeta, isValidE164 } from '../utils/phone.util';
import { findOrCreateContact } from '../utils/contacts.util';
import { ApiError } from '../utils/respond.util';
import { WebhookDeliverService } from './webhook-deliver.service';
import { BroadcastQueueService } from '../../queue/broadcast-queue.service';

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

export interface BroadcastAccepted {
  broadcastId: string;
  /** Recipients written as pending rows and handed to the queue. */
  accepted: number;
  /** Recipients dropped for an unusable phone number. */
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

/**
 * `POST /v1/broadcasts` — validate, persist, hand to the queue.
 *
 * This service used to *also* deliver: the controller called
 * `void deliverBroadcast(plan)` and a single in-process loop sent to
 * every recipient with no queue behind it at all. Anything that
 * interrupted the process — a deploy, a crash, an OOM — dropped the
 * remaining recipients silently, and the caller had already been told
 * 202 Accepted. Delivery is now the same fan-out queue the dashboard
 * uses, and the only difference between the two paths is where the
 * template parameters come from.
 */
@Injectable()
export class BroadcastSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly broadcastQueue: BroadcastQueueService,
  ) {}

  async createBroadcast(
    accountId: string,
    auditUserId: string,
    params: CreateBroadcastParams,
  ): Promise<BroadcastAccepted> {
    const { name, templateName, recipients } = params;
    const templateLanguage = params.templateLanguage || 'en_US';

    if (!templateName) {
      throw new ApiError(
        'bad_request',
        "'template_name' is required",
        HttpStatus.BAD_REQUEST,
      );
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

    // Fail fast on a disconnected WhatsApp account, but do NOT decrypt
    // the token here: nothing on this path sends any more. The
    // recipient processor reads and decrypts it at send time, which is
    // also the only way a token rotated between acceptance and delivery
    // is the one actually used.
    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: accountId },
      select: { id: true },
    });
    if (!config) {
      throw new ApiError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        HttpStatus.BAD_REQUEST,
      );
    }

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

    const resolved: { contactId: string; phone: string; params: string[] }[] =
      [];
    let rejected = 0;
    for (const r of recipients) {
      const sanitized = sanitizePhoneForMeta(
        typeof r.to === 'string' ? r.to : '',
      );
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

    // createMany + a follow-up read, rather than one create-with-nested,
    // because the per-recipient params have to land on the row: a
    // recipient job rebuilds its send from the database alone, so
    // params kept only in memory (as they were when this method
    // returned a plan for an in-process loop to walk) would come back
    // empty after any restart.
    const broadcast = await this.prisma.broadcasts.create({
      data: {
        account_id: accountId,
        user_id: auditUserId,
        name: name || `API broadcast (${templateName})`,
        template_name: templateName,
        template_language: templateLanguage,
        status: 'queued',
        total_recipients: deduped.length,
      },
      select: { id: true },
    });

    await this.prisma.broadcast_recipients.createMany({
      data: deduped.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        status: 'pending',
        // [] is stored as-is: "this recipient has no parameters" is a
        // real answer, and distinguishing it from NULL ("resolve from
        // the broadcast's variable mapping") is what lets one processor
        // serve both the API and the dashboard.
        template_params: r.params,
      })),
    });

    await this.broadcastQueue.enqueueBroadcast(broadcast.id);

    return {
      broadcastId: broadcast.id,
      accepted: deduped.length,
      rejected,
    };
  }
}
