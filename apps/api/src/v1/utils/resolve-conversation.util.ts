import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from './respond.util';
import { sanitizePhoneForMeta, isValidE164 } from './phone.util';
import { resolveAuditUserId, findExistingContact, isUniqueViolation } from './contacts.util';
import { HttpStatus } from '@nestjs/common';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  contactCreated: boolean;
}

export async function resolveConversationByPhone(
  prisma: PrismaService,
  webhookDeliver: any,
  accountId: string,
  phone: string,
  name?: string | null,
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new ApiError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      HttpStatus.BAD_REQUEST,
    );
  }

  const config = await prisma.whatsapp_config.findFirst({
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

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(prisma, accountId);
  } catch (err: any) {
    throw new ApiError('db_error', err.message || 'Failed to resolve account owner', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(prisma, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await prisma.contacts.update({
        where: { id: existing.id },
        data: { name, updated_at: new Date() },
      });
    }
  } else {
    try {
      const created = await prisma.contacts.create({
        data: {
          account_id: accountId,
          user_id: ownerUserId,
          phone: sanitized,
          name: name || sanitized,
        },
        select: { id: true },
      });
      contactId = created.id;
      contactCreated = true;

      if (webhookDeliver) {
        void webhookDeliver.dispatchWebhookEvent(accountId, 'contact.created', {
          contact_id: contactId,
          phone: sanitized,
          name: name || sanitized,
        });
      }
    } catch (createErr) {
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(prisma, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new ApiError(
            'db_error',
            'Failed to create contact',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr,
        );
        throw new ApiError('db_error', 'Failed to create contact', HttpStatus.INTERNAL_SERVER_ERROR);
      }
    }
  }

  const conv = await prisma.conversations.findFirst({
    where: {
      account_id: accountId,
      contact_id: contactId,
    },
    select: { id: true },
  });

  if (conv?.id) {
    return { conversationId: conv.id, contactId, contactCreated };
  }

  try {
    const newConv = await prisma.conversations.create({
      data: {
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: contactId,
      },
      select: { id: true },
    });
    return { conversationId: newConv.id, contactId, contactCreated };
  } catch (convErr) {
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new ApiError(
      'db_error',
      'Failed to create conversation',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
