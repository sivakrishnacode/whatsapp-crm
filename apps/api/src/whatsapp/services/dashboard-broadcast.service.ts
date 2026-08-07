import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toE164 } from '../../v1/utils/phone.util';
import { resolveAccountCountry } from '../../common/phone/account-country.util';
import { BroadcastQueueService } from '../../queue/broadcast-queue.service';
import {
  BUTTON_PARAMS_KEY,
  HEADER_LOCATION_KEY,
  HEADER_MEDIA_KEY,
  HEADER_TEXT_KEY,
} from '../queues/broadcast-template.util';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: CustomFieldOperator;
    value: string;
  };
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
  headerText?: string | null;
  headerLocation?: {
    latitude: string;
    longitude: string;
    name?: string;
    address?: string;
  } | null;
  /** Per-button substitution, keyed by the button's index. */
  buttonParams?: Record<string, string> | null;
}

interface AudienceContact {
  id: string;
  /**
   * Never null. `contacts.phone` became nullable when Instagram landed,
   * but a WhatsApp broadcast is addressed *by* phone — so
   * `resolveAudience` filters phone-less contacts out and this stays a
   * plain string for every consumer downstream.
   */
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
}

/** A contacts row as selected, before the phone filter narrows it. */
type AudienceRow = Omit<AudienceContact, 'phone'> & { phone: string | null };

/**
 * Keys starting with "_" are reserved metadata (e.g. the header media
 * URL), never placeholders.
 */
function placeholderKeys(variables: Record<string, VariableMapping>): string[] {
  return Object.keys(variables).filter((k) => !k.startsWith('_'));
}

function resolveVariable(
  v: VariableMapping | undefined,
  contact: AudienceRow,
  customValues?: Map<string, string>,
): string {
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
}

/**
 * Per-contact resolution of template placeholders — a 1:1 port of the
 * old client-side resolveVariables. Keys are typically "1","2",… —
 * numeric-aware sort keeps {{1}} before {{10}}.
 */
export function resolveBroadcastVariables(
  variables: Record<string, VariableMapping>,
  // AudienceRow, not AudienceContact: the delivery loop passes a raw
  // contacts row (nullable phone) that it has already guarded. The
  // field map below tolerates nulls anyway.
  contact: AudienceRow,
  customValues?: Map<string, string>,
): string[] {
  const keys = placeholderKeys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) =>
    resolveVariable(variables[key], contact, customValues),
  );
}

/**
 * Same resolution, keyed by variable name instead of flattened to an
 * ordered array — for NAMED templates ({{customer_name}}).
 *
 * Ordering is the whole reason this exists: an array only lines up with
 * a NAMED template if it is sorted by each name's first appearance in
 * the body, which this service can't know. Meta matches named
 * parameters by name, so handing over a map sidesteps the question.
 */
export function resolveBroadcastVariableMap(
  variables: Record<string, VariableMapping>,
  contact: AudienceRow,
  customValues?: Map<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of placeholderKeys(variables)) {
    out[key] = resolveVariable(variables[key], contact, customValues);
  }
  return out;
}

/**
 * Server-side replacement for the dashboard's old client-side broadcast
 * fan-out (use-broadcast-sending.ts). The browser makes ONE request;
 * audience resolution and recipient creation happen here.
 *
 * Delivery does NOT happen here. This service's last act is to hand the
 * broadcast id to the orchestrator queue, which fans out one job per
 * recipient (see whatsapp/queues/). Everything the send needs is on the
 * `broadcasts` / `broadcast_recipients` rows, so delivery survives a
 * page refresh, an api restart, and a Redis flush alike — the recipient
 * rows are the work list, and only rows still in status='pending' are
 * ever sent.
 */
@Injectable()
export class DashboardBroadcastService {
  private readonly logger = new Logger(DashboardBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcastQueue: BroadcastQueueService,
  ) {}

  async createAndQueue(
    accountId: string,
    userId: string,
    params: CreateDashboardBroadcastParams,
  ): Promise<{ id: string; totalRecipients: number }> {
    const {
      name,
      templateName,
      audience,
      variables,
      headerMediaUrl,
      headerText,
      headerLocation,
      buttonParams,
    } = params;
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
    if (headerText?.trim()) {
      templateVariables[HEADER_TEXT_KEY] = headerText.trim();
    }
    // Only stored when usable: a pin missing either coordinate is not a
    // partial pin, it is a send Meta will reject.
    if (headerLocation?.latitude?.trim() && headerLocation?.longitude?.trim()) {
      templateVariables[HEADER_LOCATION_KEY] = {
        latitude: headerLocation.latitude.trim(),
        longitude: headerLocation.longitude.trim(),
        ...(headerLocation.name?.trim()
          ? { name: headerLocation.name.trim() }
          : {}),
        ...(headerLocation.address?.trim()
          ? { address: headerLocation.address.trim() }
          : {}),
      };
    }
    const trimmedButtonParams = Object.fromEntries(
      Object.entries(buttonParams ?? {})
        .filter(([, v]) => (v ?? '').trim())
        .map(([k, v]) => [k, v.trim()]),
    );
    if (Object.keys(trimmedButtonParams).length > 0) {
      templateVariables[BUTTON_PARAMS_KEY] = trimmedButtonParams;
    }

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
        // 'queued', not 'sending': nothing has been sent yet, and with
        // fan-out there is a real interval between acceptance and the
        // first message. The orchestrator moves it to 'sending'.
        status: 'queued',
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

    await this.broadcastQueue.enqueueBroadcast(broadcast.id);

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

    let contacts: AudienceRow[] = [];

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

    // Drop contacts that carry no phone. Since Instagram landed,
    // `audience.type === 'all'` can sweep up Instagram-only contacts —
    // and there is no way to broadcast to them: Instagram has no
    // approved-template mechanism, so bulk unsolicited DMs are both
    // technically impossible and a fast route to app restriction.
    // Filtering here means one silent, correct exclusion instead of N
    // per-recipient send failures.
    return contacts.filter((c): c is AudienceContact => Boolean(c.phone));
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
    // Canonicalize before anything else. The map key doubles as the
    // `phone: { in: phones }` lookup below, which is an exact string
    // match — so an uploaded "9791766444" used to miss the existing
    // "+919791766444" contact and then create a second row for the
    // same person, which the unique index on phone_normalized would
    // reject anyway. One conversion fixes the lookup and the insert.
    const country = await resolveAccountCountry(this.prisma, accountId);
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    let unparseable = 0;
    for (const row of csvRows) {
      const canonical =
        typeof row?.phone === 'string' ? toE164(row.phone, country) : null;
      if (!canonical) {
        unparseable++;
        continue;
      }
      uniqueByPhone.set(canonical, { phone: canonical, name: row.name });
    }
    if (unparseable > 0) {
      this.logger.warn(
        `Broadcast CSV: skipped ${unparseable} row(s) with an unusable phone number.`,
      );
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
    // `phone: { in: phones }` cannot match a NULL, so every row here has
    // one — the filter is for the type system, not the data.
    const byPhone = new Map<string, AudienceContact>(
      existing
        .filter((c): c is AudienceContact => Boolean(c.phone))
        .map((c) => [c.phone, c] as const),
    );

    for (const phone of phones) {
      if (byPhone.has(phone)) continue;
      const created = await this.prisma.contacts.create({
        data: {
          user_id: userId,
          account_id: accountId,
          phone,
          name: uniqueByPhone.get(phone)?.name ?? null,
          source: 'broadcast',
        },
        select,
      });
      // `phone` was just written from a non-empty string above.
      byPhone.set(phone, { ...created, phone });
    }

    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is AudienceContact => Boolean(c));
  }
}
