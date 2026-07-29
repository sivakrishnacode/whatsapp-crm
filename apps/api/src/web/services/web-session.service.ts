import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { WebConfigService } from './web-config.service';
import {
  generateVisitorId,
  signVisitorToken,
  verifyVisitorToken,
  VisitorTokenError,
} from '../utils/visitor-token.util';

export interface StartSessionInput {
  accountId: string;
  ownerUserId: string;
  /** A token from a previous visit, if the browser kept one. */
  existingToken?: string;
  /** Attribution, captured once per session. */
  pageUrl?: string;
  referrer?: string;
  utm?: Record<string, unknown>;
  userAgent?: string;
  /** Raw IP — hashed here and never stored. */
  ip?: string;
  /**
   * The customer's own user id plus an HMAC their server computed with
   * the account's widget secret. Present only for logged-in visitors on
   * sites that implement identity verification.
   */
  identity?: { external_id: string; hmac: string };
  /** Optional details the visitor volunteered (pre-chat form). */
  profile?: { name?: string; email?: string; phone?: string };
}

export interface StartSessionResult {
  sessionToken: string;
  conversationId: string;
  contactId: string;
  visitorId: string;
  /** True when this call created the conversation rather than resuming one. */
  isNew: boolean;
}

/**
 * Turns an anonymous browser into a contact and a `web` conversation.
 *
 * THE RESUME PATH IS THE IMPORTANT ONE
 *   Most widget loads are a returning visitor, not a new one. Presenting
 *   an empty chat to someone who asked a question yesterday is the single
 *   most noticeable way a chat widget feels broken, so a valid token
 *   always resumes its existing thread and only a missing or unusable one
 *   creates.
 *
 * WHY THE VISITOR ID IS SERVER-MINTED
 *   `contacts.web_visitor_id` is unique per account, so accepting a
 *   client-supplied id would let anyone claim another visitor's id and be
 *   handed that contact and its entire conversation history. The client
 *   only ever echoes back a *signed token*; the id inside it came from
 *   here.
 */
@Injectable()
export class WebSessionService {
  private readonly logger = new Logger(WebSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WebConfigService,
  ) {}

  async startOrResume(input: StartSessionInput): Promise<StartSessionResult> {
    const secret = await this.config.loadSigningSecret(input.accountId);

    const resumed = await this.tryResume(input, secret);
    if (resumed) return resumed;

    return this.createSession(input, secret);
  }

  /**
   * Resume an existing thread if the token is valid AND its rows still
   * exist and still belong to this account.
   *
   * The existence re-check is not paranoia: a token outlives the data it
   * points at. A contact deleted from the CRM, or a conversation removed
   * with its account, leaves a perfectly-signed token addressing nothing
   * — and every downstream write would then fail a foreign key instead of
   * quietly starting a fresh chat.
   */
  private async tryResume(
    input: StartSessionInput,
    secret: string,
  ): Promise<StartSessionResult | null> {
    if (!input.existingToken) return null;

    try {
      const claims = await verifyVisitorToken(input.existingToken, secret);
      if (claims.accountId !== input.accountId) return null;

      const conversation = await this.prisma.conversations.findFirst({
        where: {
          id: claims.conversationId,
          account_id: input.accountId,
          channel: 'web',
        },
        select: {
          id: true,
          contact_id: true,
          contacts: {
            select: { name: true, phone: true },
          },
        },
      });
      if (!conversation) return null;

      // If the contact lacks a valid name or phone, invalidate the session to force the pre-chat form.
      if (
        !conversation.contacts?.name?.trim() ||
        !conversation.contacts?.phone?.trim()
      ) {
        return null;
      }

      await this.touchSession({
        accountId: input.accountId,
        visitorId: claims.visitorId,
        contactId: conversation.contact_id,
        conversationId: conversation.id,
        pageUrl: input.pageUrl,
      });

      if (input.profile) {
        await this.applyProfile(
          input.accountId,
          conversation.contact_id,
          input.profile,
        );
      }

      return {
        // Re-issued rather than echoed back, so an active visitor's
        // session never expires mid-conversation.
        sessionToken: await signVisitorToken(
          {
            accountId: input.accountId,
            visitorId: claims.visitorId,
            conversationId: conversation.id,
            contactId: conversation.contact_id,
            ...(claims.verifiedIdentity
              ? { verifiedIdentity: claims.verifiedIdentity }
              : {}),
          },
          secret,
        ),
        conversationId: conversation.id,
        contactId: conversation.contact_id,
        visitorId: claims.visitorId,
        isNew: false,
      };
    } catch (err) {
      if (err instanceof VisitorTokenError) return null;
      throw err;
    }
  }

  private async createSession(
    input: StartSessionInput,
    secret: string,
  ): Promise<StartSessionResult> {
    if (!input.profile?.name?.trim() || !input.profile?.phone?.trim()) {
      throw new BadRequestException(
        'Name and mobile number are required to start a chat.',
      );
    }

    const verifiedIdentity = this.verifyIdentity(input.identity, secret);
    const visitorId = generateVisitorId();

    // One transaction: a contact with no conversation is a row the widget
    // can never reach again, because the next load mints a new visitor id
    // and never finds it.
    const created = await this.prisma.$transaction(async (tx) => {
      const contact = await tx.contacts.create({
        data: {
          account_id: input.accountId,
          user_id: input.ownerUserId,
          web_visitor_id: visitorId,
          name: input.profile?.name ?? null,
          email: input.profile?.email ?? null,
          phone: input.profile?.phone ?? null,
        },
        select: { id: true },
      });

      const conversation = await tx.conversations.create({
        data: {
          account_id: input.accountId,
          user_id: input.ownerUserId,
          contact_id: contact.id,
          channel: 'web',
          status: 'open',
        },
        select: { id: true },
      });

      return { contactId: contact.id, conversationId: conversation.id };
    });

    await this.recordSession({
      accountId: input.accountId,
      visitorId,
      contactId: created.contactId,
      conversationId: created.conversationId,
      pageUrl: input.pageUrl,
      referrer: input.referrer,
      utm: input.utm,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return {
      sessionToken: await signVisitorToken(
        {
          accountId: input.accountId,
          visitorId,
          conversationId: created.conversationId,
          contactId: created.contactId,
          ...(verifiedIdentity ? { verifiedIdentity } : {}),
        },
        secret,
      ),
      conversationId: created.conversationId,
      contactId: created.contactId,
      visitorId,
      isNew: true,
    };
  }

  /**
   * Confirm the customer's server vouched for this visitor.
   *
   * Without this, a visitor on the customer's site could claim to be any
   * of that customer's users simply by editing the JS — and since the
   * widget shows conversation history, that would read someone else's
   * chat. The HMAC can only be computed by something holding the account's
   * secret, i.e. the customer's own backend.
   *
   * Failure is silent-but-unverified rather than an error: an
   * incorrectly-configured integration should degrade to an anonymous
   * chat, not break the widget entirely.
   */
  private verifyIdentity(
    identity: StartSessionInput['identity'],
    secret: string,
  ): string | null {
    if (!identity?.external_id || !identity.hmac) return null;

    const expected = createHmac('sha256', secret)
      .update(identity.external_id)
      .digest('hex');
    const provided = identity.hmac.toLowerCase();

    if (expected.length !== provided.length) return null;
    const ok = timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(provided, 'utf8'),
    );
    if (!ok) {
      this.logger.warn(
        `identity verification failed for external_id ${identity.external_id}`,
      );
      return null;
    }
    return identity.external_id;
  }

  /**
   * Fill in details the visitor volunteered, without overwriting what we
   * already know.
   *
   * Only-if-empty on purpose: an agent may have corrected a name in the
   * CRM, and a later pre-chat submission with a stale value must not undo
   * that. Deliberate identity *merging* (a phone that matches an existing
   * contact) is the form resolver's job, not this one's.
   */
  private async applyProfile(
    accountId: string,
    contactId: string,
    profile: NonNullable<StartSessionInput['profile']>,
  ): Promise<void> {
    const current = await this.prisma.contacts.findFirst({
      where: { id: contactId, account_id: accountId },
      select: { name: true, email: true, phone: true },
    });
    if (!current) return;

    const data: Record<string, string> = {};
    if (!current.name && profile.name) data.name = profile.name;
    if (!current.email && profile.email) data.email = profile.email;
    if (!current.phone && profile.phone) data.phone = profile.phone;
    if (Object.keys(data).length === 0) return;

    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { ...data, updated_at: new Date() },
    });
  }

  private async recordSession(args: {
    accountId: string;
    visitorId: string;
    contactId: string;
    conversationId: string;
    pageUrl?: string;
    referrer?: string;
    utm?: Record<string, unknown>;
    userAgent?: string;
    ip?: string;
  }): Promise<void> {
    try {
      await this.prisma.web_sessions.create({
        data: {
          account_id: args.accountId,
          visitor_id: args.visitorId,
          contact_id: args.contactId,
          conversation_id: args.conversationId,
          page_url: truncate(args.pageUrl, 2000),
          referrer: truncate(args.referrer, 2000),
          utm: (args.utm ?? undefined) as Prisma.InputJsonValue | undefined,
          user_agent: truncate(args.userAgent, 500),
          ip_hash: hashIp(args.ip),
        },
      });
    } catch (err) {
      // Analytics must never block a chat from starting.
      this.logger.warn(`could not record web session: ${String(err)}`);
    }
  }

  private async touchSession(args: {
    accountId: string;
    visitorId: string;
    contactId: string;
    conversationId: string;
    pageUrl?: string;
  }): Promise<void> {
    try {
      const latest = await this.prisma.web_sessions.findFirst({
        where: {
          account_id: args.accountId,
          visitor_id: args.visitorId,
          ended_at: null,
        },
        orderBy: { started_at: 'desc' },
        select: { id: true },
      });

      if (latest) {
        await this.prisma.web_sessions.update({
          where: { id: latest.id },
          data: {
            last_seen_at: new Date(),
            pages_viewed: { increment: 1 },
          },
        });
        return;
      }

      // A returning visitor whose previous session was closed out starts
      // a new session row against the same contact — that is what makes
      // "visits before converting" answerable.
      await this.prisma.web_sessions.create({
        data: {
          account_id: args.accountId,
          visitor_id: args.visitorId,
          contact_id: args.contactId,
          conversation_id: args.conversationId,
          page_url: truncate(args.pageUrl, 2000),
        },
      });
    } catch (err) {
      this.logger.warn(`could not touch web session: ${String(err)}`);
    }
  }
}

/**
 * Salted SHA-256. The salt is what stops the hash being a lookup table
 * over the whole IPv4 space — an unsalted hash of an IP is barely more
 * private than the IP.
 */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.WEB_IP_HASH_SALT ?? process.env.ENCRYPTION_KEY ?? '';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
