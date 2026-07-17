import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { sendTemplateMessage } from '../meta-api.util';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '../../v1/utils/phone.util';

export const BROADCASTS_QUEUE = 'broadcasts-send';

/**
 * Meta rate-limit buffer — same policy the old client-side wizard used:
 * 10 sends per batch, 1 s pause between batches, keeping a large
 * broadcast comfortably under Meta's per-phone-number messaging rate.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** Key inside broadcasts.template_variables carrying the header media URL. */
const HEADER_MEDIA_KEY = '_headerMediaUrl';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: { fieldId: string; operator: CustomFieldOperator; value: string };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

export interface CreateDashboardBroadcastParams {
  name: string;
  templateName: string;
  templateLanguage?: string | null;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string | null;
}

interface AudienceContact {
  id: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  company: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-contact resolution of template placeholders — a 1:1 port of the
 * old client-side resolveVariables. Keys are typically "1","2",… —
 * numeric-aware sort keeps {{1}} before {{10}}. Keys starting with "_"
 * are reserved metadata (e.g. the header media URL), never placeholders.
 */
export function resolveBroadcastVariables(
  variables: Record<string, VariableMapping>,
  contact: AudienceContact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables)
    .filter((k) => !k.startsWith('_'))
    .sort((a, b) => {
      const an = Number(a);
      const bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.localeCompare(b);
    });

  return keys.map((key) => {
    const v = variables[key];
    if (!v || typeof v !== 'object') return '';
    if (v.type === 'static') return v.value ?? '';
    if (v.type === 'field') {
      const fieldMap: Record<string, string | null | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }
    // custom_field — value holds the custom_fields.id
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Server-side replacement for the dashboard's old client-side broadcast
 * fan-out (use-broadcast-sending.ts). The browser now makes ONE request;
 * audience resolution, recipient creation, and delivery all happen here.
 * Delivery runs on a BullMQ queue keyed by broadcast id, so it survives
 * page refreshes AND api restarts — the processor only ever picks up
 * recipients still in status='pending', making retries resume-safe.
 */
@Injectable()
export class DashboardBroadcastService {
  private readonly logger = new Logger(DashboardBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(BROADCASTS_QUEUE) private readonly queue: Queue,
  ) {}

  async createAndQueue(
    accountId: string,
    userId: string,
    params: CreateDashboardBroadcastParams,
  ): Promise<{ id: string; totalRecipients: number }> {
    const { name, templateName, audience, variables, headerMediaUrl } = params;
    const templateLanguage = params.templateLanguage || 'en_US';

    if (!templateName) {
      throw new BadRequestException({ error: 'template_name is required' });
    }
    if (!name || !name.trim()) {
      throw new BadRequestException({ error: 'Broadcast name is required' });
    }
    if (!audience || typeof audience !== 'object' || !audience.type) {
      throw new BadRequestException({ error: 'audience is required' });
    }

    // Fail fast if WhatsApp isn't connected — better than queueing a
    // broadcast doomed to fail recipient-by-recipient.
    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: accountId },
      select: { id: true },
    });
    if (!config) {
      throw new BadRequestException({
        error:
          'WhatsApp not configured. Please set up your WhatsApp integration first.',
      });
    }

    const contacts = await this.resolveAudience(accountId, userId, audience);
    if (contacts.length === 0) {
      throw new BadRequestException({
        error: 'No contacts found for this audience.',
      });
    }

    const templateVariables: Record<string, unknown> = { ...(variables ?? {}) };
    const trimmedMediaUrl = headerMediaUrl?.trim();
    if (trimmedMediaUrl) templateVariables[HEADER_MEDIA_KEY] = trimmedMediaUrl;

    const broadcast = await this.prisma.broadcasts.create({
      data: {
        user_id: userId,
        account_id: accountId,
        name: name.trim(),
        template_name: templateName,
        template_language: templateLanguage,
        template_variables: templateVariables as object,
        audience_filter: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          excludeTagIds: audience.excludeTagIds,
          csvCount: audience.csvContacts?.length,
        } as object,
        status: 'sending',
        total_recipients: contacts.length,
      },
      select: { id: true },
    });

    await this.prisma.broadcast_recipients.createMany({
      data: contacts.map((c) => ({
        broadcast_id: broadcast.id,
        contact_id: c.id,
        status: 'pending',
      })),
    });

    // jobId = broadcast id → duplicate enqueues are idempotent. Retries
    // re-enter deliver(), which only touches still-pending recipients.
    await this.queue.add(
      'deliver',
      { broadcastId: broadcast.id },
      {
        jobId: broadcast.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    return { id: broadcast.id, totalRecipients: contacts.length };
  }

  /** Resolve the wizard's audience config to concrete, account-scoped contacts. */
  private async resolveAudience(
    accountId: string,
    userId: string,
    audience: AudienceConfig,
  ): Promise<AudienceContact[]> {
    const select = {
      id: true,
      phone: true,
      name: true,
      email: true,
      company: true,
    } as const;

    let contacts: AudienceContact[] = [];

    if (audience.type === 'all') {
      contacts = await this.prisma.contacts.findMany({
        where: { account_id: accountId },
        select,
      });
    } else if (audience.type === 'tags' && audience.tagIds?.length) {
      const tagged = await this.prisma.contact_tags.findMany({
        where: { tag_id: { in: audience.tagIds } },
        select: { contact_id: true },
      });
      const ids = [...new Set(tagged.map((t) => t.contact_id))];
      if (ids.length > 0) {
        contacts = await this.prisma.contacts.findMany({
          where: { id: { in: ids }, account_id: accountId },
          select,
        });
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      const { fieldId, operator, value } = audience.customField;
      const valueFilter =
        operator === 'is'
          ? { equals: value }
          : operator === 'is_not'
            ? { not: value }
            : { contains: value, mode: 'insensitive' as const };
      const matches = await this.prisma.contact_custom_values.findMany({
        where: { custom_field_id: fieldId, value: valueFilter },
        select: { contact_id: true },
      });
      const ids = [...new Set(matches.map((m) => m.contact_id))];
      if (ids.length > 0) {
        contacts = await this.prisma.contacts.findMany({
          where: { id: { in: ids }, account_id: accountId },
          select,
        });
      }
    } else if (audience.type === 'csv' && audience.csvContacts?.length) {
      contacts = await this.upsertCsvContacts(
        accountId,
        userId,
        audience.csvContacts,
      );
    }

    if (audience.excludeTagIds?.length && contacts.length > 0) {
      const excluded = await this.prisma.contact_tags.findMany({
        where: { tag_id: { in: audience.excludeTagIds } },
        select: { contact_id: true },
      });
      const excludedIds = new Set(excluded.map((e) => e.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV rows arrive as raw phone/name pairs. broadcast_recipients FKs
   * contacts.id, so look up existing contacts by phone and create the
   * missing ones (same semantics as the old client-side upsert).
   */
  private async upsertCsvContacts(
    accountId: string,
    userId: string,
    csvRows: { phone: string; name?: string }[],
  ): Promise<AudienceContact[]> {
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      const phone = typeof row?.phone === 'string' ? row.phone.trim() : '';
      if (phone) uniqueByPhone.set(phone, { phone, name: row.name });
    }
    const phones = [...uniqueByPhone.keys()];
    if (phones.length === 0) return [];

    const select = {
      id: true,
      phone: true,
      name: true,
      email: true,
      company: true,
    } as const;

    const existing = await this.prisma.contacts.findMany({
      where: { account_id: accountId, phone: { in: phones } },
      select,
    });
    const byPhone = new Map<string, AudienceContact>(
      existing.map((c) => [c.phone, c]),
    );

    for (const phone of phones) {
      if (byPhone.has(phone)) continue;
      const created = await this.prisma.contacts.create({
        data: {
          user_id: userId,
          account_id: accountId,
          phone,
          name: uniqueByPhone.get(phone)?.name ?? null,
        },
        select,
      });
      byPhone.set(created.phone, created);
    }

    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is AudienceContact => Boolean(c));
  }

  /**
   * Deliver a queued broadcast. Called by the BullMQ processor —
   * idempotent: only recipients still in status='pending' are sent, so
   * a retried/resumed job never double-sends.
   */
  async deliver(broadcastId: string): Promise<void> {
    const broadcast = await this.prisma.broadcasts.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast || broadcast.status !== 'sending') return;

    const failRemaining = async (reason: string) => {
      await this.prisma.broadcast_recipients.updateMany({
        where: { broadcast_id: broadcastId, status: 'pending' },
        data: { status: 'failed', error_message: reason },
      });
      await this.prisma.broadcasts.update({
        where: { id: broadcastId },
        data: { status: 'failed', updated_at: new Date() },
      });
    };

    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: broadcast.account_id },
    });
    if (!config) {
      await failRemaining('WhatsApp not configured');
      return;
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch {
      await failRemaining('Failed to decrypt WhatsApp access token');
      return;
    }

    const templateRow = await this.prisma.message_templates.findFirst({
      where: {
        account_id: broadcast.account_id,
        name: broadcast.template_name,
        language: broadcast.template_language,
      },
    });

    const rawVariables = (broadcast.template_variables ?? {}) as Record<
      string,
      unknown
    >;
    const headerMediaUrl =
      typeof rawVariables[HEADER_MEDIA_KEY] === 'string'
        ? (rawVariables[HEADER_MEDIA_KEY] as string)
        : undefined;
    const variables = rawVariables as Record<string, VariableMapping>;
    const messageParams = headerMediaUrl ? { headerMediaUrl } : undefined;

    const recipients = await this.prisma.broadcast_recipients.findMany({
      where: { broadcast_id: broadcastId, status: 'pending' },
      select: {
        id: true,
        contacts: {
          select: {
            id: true,
            phone: true,
            name: true,
            email: true,
            company: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    // One bulk fetch of custom values for every contact, avoiding N+1
    // queries in the send loop (mirrors the old client's index).
    const contactIds = recipients
      .map((r) => r.contacts?.id)
      .filter((id): id is string => Boolean(id));
    const customValueIndex = new Map<string, Map<string, string>>();
    const PAGE = 500;
    for (let i = 0; i < contactIds.length; i += PAGE) {
      const rows = await this.prisma.contact_custom_values.findMany({
        where: { contact_id: { in: contactIds.slice(i, i + PAGE) } },
        select: { contact_id: true, custom_field_id: true, value: true },
      });
      for (const row of rows) {
        const bucket =
          customValueIndex.get(row.contact_id) ?? new Map<string, string>();
        bucket.set(row.custom_field_id, row.value ?? '');
        customValueIndex.set(row.contact_id, bucket);
      }
    }

    let processed = 0;
    for (const recipient of recipients) {
      const contact = recipient.contacts;
      if (!contact?.phone) {
        await this.markRecipient(recipient.id, null, 'No phone number on contact');
        continue;
      }

      const sanitized = sanitizePhoneForMeta(contact.phone);
      if (!isValidE164(sanitized)) {
        await this.markRecipient(recipient.id, null, 'Invalid phone number');
        continue;
      }

      const params = resolveBroadcastVariables(
        variables,
        contact,
        customValueIndex.get(contact.id),
      );

      let sentMessageId: string | null = null;
      let lastError: string | null = null;
      for (const variant of phoneVariants(sanitized)) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: broadcast.template_name,
            language: broadcast.template_language,
            template: (templateRow as any) ?? undefined,
            params,
            messageParams,
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          lastError = message;
          if (!isRecipientNotAllowedError(message)) break;
        }
      }

      await this.markRecipient(
        recipient.id,
        sentMessageId,
        sentMessageId ? null : (lastError ?? 'Unknown error'),
      );

      processed++;
      if (
        processed % SEND_BATCH_SIZE === 0 &&
        processed < recipients.length
      ) {
        await sleep(SEND_BATCH_DELAY_MS);
      }
    }

    // sent_count/failed_count aggregates are maintained by the DB
    // trigger on broadcast_recipients (migration 003) — only the final
    // status is flipped here. "failed" only when nothing went out.
    const sentCount = await this.prisma.broadcast_recipients.count({
      where: { broadcast_id: broadcastId, status: 'sent' },
    });
    await this.prisma.broadcasts.update({
      where: { id: broadcastId },
      data: {
        status: sentCount > 0 ? 'sent' : 'failed',
        updated_at: new Date(),
      },
    });
    this.logger.log(
      `broadcast ${broadcastId}: delivered ${sentCount}/${broadcast.total_recipients ?? recipients.length}`,
    );
  }

  private async markRecipient(
    recipientRowId: string,
    whatsappMessageId: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await this.prisma.broadcast_recipients.update({
        where: { id: recipientRowId },
        data: whatsappMessageId
          ? {
              status: 'sent',
              sent_at: new Date(),
              whatsapp_message_id: whatsappMessageId,
              error_message: null,
            }
          : { status: 'failed', error_message: errorMessage },
      });
    } catch (err) {
      this.logger.error(
        `failed updating recipient ${recipientRowId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
