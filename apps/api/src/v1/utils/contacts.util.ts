import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { normalizePhone, phonesMatch, isValidE164, sanitizePhoneForMeta } from './phone.util';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export function serializeContact(row: any): ApiContact {
  const joins = row.contact_tags ?? [];
  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    email: row.email ?? null,
    company: row.company ?? null,
    avatar_url: row.avatar_url ?? null,
    tags: joins
      .map((j: any) => j.tags)
      .filter((t: any) => t != null)
      .map((t: any) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
  };
}

export async function resolveAuditUserId(
  prisma: PrismaService,
  accountId: string,
): Promise<string> {
  const config = await prisma.whatsapp_config.findFirst({
    where: { account_id: accountId },
    select: { user_id: true },
  });
  if (config?.user_id) return config.user_id;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { ownerUserId: true },
  });
  if (account?.ownerUserId) return account.ownerUserId;

  throw new Error('Account owner could not be resolved');
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

export async function findExistingContact(
  prisma: PrismaService,
  accountId: string,
  phone: string,
) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const candidates = await prisma.contacts.findMany({
    where: {
      account_id: accountId,
      phone: {
        endsWith: suffix,
      },
    },
    include: {
      contact_tags: {
        include: {
          tags: true,
        },
      },
    },
  });

  return candidates.find((c) => phonesMatch(c.phone, phone)) ?? null;
}

export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  return false;
}

export async function findOrCreateContact(
  prisma: PrismaService,
  webhookDeliver: any,
  accountId: string,
  auditUserId: string,
  input: ContactInput,
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
    );
  }

  const existing = await findExistingContact(prisma, accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  try {
    const created = await prisma.contacts.create({
      data: {
        account_id: accountId,
        user_id: auditUserId,
        phone: sanitized,
        name: input.name ?? sanitized,
        email: input.email ?? null,
        company: input.company ?? null,
      },
      select: { id: true },
    });

    if (webhookDeliver) {
      void webhookDeliver.dispatchWebhookEvent(accountId, 'contact.created', {
        contact_id: created.id,
        phone: sanitized,
        name: input.name ?? sanitized,
      });
    }

    return { id: created.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(prisma, accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new Error('Failed to create contact');
  }
}

export const DEFAULT_TAG_COLOR = '#3b82f6';

export async function setContactTags(
  prisma: PrismaService,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[],
): Promise<void> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  const existingTags = await prisma.tags.findMany({
    where: { account_id: accountId },
    select: { id: true, name: true },
  });

  const tagIdByKey = new Map<string, string>();
  for (const tag of existingTags) {
    const key = tag.name.trim().toLowerCase();
    if (!tagIdByKey.has(key)) tagIdByKey.set(key, tag.id);
  }

  const toCreate: string[] = [];
  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (!tagIdByKey.has(key)) {
      toCreate.push(name);
    }
  }

  if (toCreate.length > 0) {
    const created = await Promise.all(
      toCreate.map(async (name) => {
        return prisma.tags.create({
          data: {
            user_id: auditUserId,
            account_id: accountId,
            name,
            color: DEFAULT_TAG_COLOR,
          },
          select: { id: true, name: true },
        });
      })
    );
    for (const tag of created) {
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
    }
  }

  const desired = new Set<string>();
  for (const name of uniqueNames) {
    const id = tagIdByKey.get(name.toLowerCase());
    if (id) desired.add(id);
  }

  const currentJoins = await prisma.contact_tags.findMany({
    where: { contact_id: contactId },
    select: { tag_id: true },
  });

  const existingJoined = new Set(currentJoins.map((rj) => rj.tag_id));
  const toAdd = [...desired].filter((id) => !existingJoined.has(id));
  const toRemove = [...existingJoined].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    await prisma.contact_tags.deleteMany({
      where: {
        contact_id: contactId,
        tag_id: { in: toRemove },
      },
    });
  }

  if (toAdd.length > 0) {
    await prisma.contact_tags.createMany({
      data: toAdd.map((tag_id) => ({
        contact_id: contactId,
        tag_id,
      })),
    });
  }
}
