import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { toE164 } from '../../common/phone/phone.util';
import { resolveAccountCountry } from '../../common/phone/account-country.util';
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

    // The widget's phone field is free text, so this is where bare
    // local numbers entered the CRM ("9791766444" with no country
    // code). Rejecting is right here and not on the form paths: the
    // visitor is at the keyboard and can fix it, whereas a form
    // submission is fire-and-forget.
    const canonicalPhone = toE164(
      input.profile.phone,
      await resolveAccountCountry(this.prisma, input.accountId),
    );
    if (!canonicalPhone) {
      throw new BadRequestException(
        'That mobile number does not look right. Include your country code, e.g. +91.',
      );
    }

    const verifiedIdentity = this.verifyIdentity(input.identity, secret);
    const visitorId = generateVisitorId();

    let created: { contactId: string; conversationId: string };
    try {
      created = await this.openThread(input, visitorId, canonicalPhone);
    } catch (err) {
      // Two first-time visits with the same number can both see "no
      // contact" and both insert; the loser gets P2002. Retried whole,
      // not inside the transaction — a failed statement aborts a
      // Postgres transaction, so nothing further can run in it. On the
      // second pass the winner's row exists and the lookup path takes
      // over.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      created = await this.openThread(input, visitorId, canonicalPhone);
    }

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
   * The contact + conversation pair, in one transaction.
   *
   * One transaction because a contact with no conversation is a row the
   * widget can never reach again: the next load mints a new visitor id
   * and never finds it.
   */
  private openThread(
    input: StartSessionInput,
    visitorId: string,
    canonicalPhone: string,
  ): Promise<{ contactId: string; conversationId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const contactId = await this.resolveContact(tx, {
        accountId: input.accountId,
        ownerUserId: input.ownerUserId,
        visitorId,
        phone: canonicalPhone,
        name: input.profile?.name?.trim(),
        email: input.profile?.email?.trim(),
      });

      // ALWAYS a new conversation, never a reattachment to an existing
      // web thread. The widget is unauthenticated, so a phone number is
      // a claim and not proof — resuming someone's previous chat because
      // a stranger typed their number would hand over its history.
      const conversation = await tx.conversations.create({
        data: {
          account_id: input.accountId,
          user_id: input.ownerUserId,
          contact_id: contactId,
          channel: 'web',
          status: 'open',
        },
        select: { id: true },
      });

      return { contactId, conversationId: conversation.id };
    });
  }

  /**
   * Find the contact this phone already belongs to, or create one.
   *
   * WHY THIS EXISTS
   *   `contacts` carries a partial UNIQUE index on
   *   (account_id, phone_normalized). A visitor who already reached the
   *   business on WhatsApp and then types the same number into the
   *   widget used to hit a blind `contacts.create()`, violate that
   *   index, and get "Could not start the chat" — the number being
   *   *known* to the business made the widget unusable, which is exactly
   *   backwards.
   *
   *   One human is one contact row here. `contacts_identity_chk` was
   *   written for precisely this: phone, ig_scoped_id and
   *   web_visitor_id coexist on a single row, and the channel lives on
   *   the conversation rather than on the person.
   *
   * WHAT IT WILL NOT DO
   *   Overwrite anything. The widget is public and unauthenticated, so
   *   every value it supplies is an unverified claim — a stranger who
   *   guesses a customer's number must not be able to rename them or
   *   change their email. Only blank fields are filled, matching
   *   FormContactResolverService.enrich.
   *
   *   Move an existing `web_visitor_id`. If the contact already has one,
   *   a second browser gets a session whose visitor id lives only in its
   *   signed token and in `web_sessions` — which is enough, because
   *   resume is keyed on the token's `conversationId`, never on the
   *   contact's visitor id. Overwriting would fight the partial unique
   *   index for no gain.
   */
  private async resolveContact(
    tx: Prisma.TransactionClient,
    args: {
      accountId: string;
      ownerUserId: string;
      visitorId: string;
      phone: string;
      name?: string;
      email?: string;
    },
  ): Promise<string> {
    // Match on the same normalisation the index uses
    // (`regexp_replace(phone, '\D', '', 'g')`), so a lookup and an
    // insert agree about what counts as the same number. Comparing raw
    // `phone` would miss "+91 98765 43210" vs "919876543210" and then
    // fail the constraint on insert anyway.
    const normalized = args.phone.replace(/\D/g, '');

    const existing = normalized
      ? await tx.contacts.findFirst({
          where: { account_id: args.accountId, phone_normalized: normalized },
          select: { id: true, name: true, email: true, web_visitor_id: true },
        })
      : null;

    if (!existing) {
      const created = await tx.contacts.create({
        data: {
          account_id: args.accountId,
          user_id: args.ownerUserId,
          web_visitor_id: args.visitorId,
          name: args.name ?? null,
          email: args.email ?? null,
          phone: args.phone,
          source: 'web',
        },
        select: { id: true },
      });
      return created.id;
    }

    const patch: Prisma.contactsUncheckedUpdateInput = {};
    if (!existing.name?.trim() && args.name) patch.name = args.name;
    if (!existing.email?.trim() && args.email) patch.email = args.email;
    // Their first visit through the widget. `source` is deliberately
    // left alone — this contact was earned on whichever channel found
    // them first, and rewriting it would lose that attribution.
    if (existing.web_visitor_id === null) {
      patch.web_visitor_id = args.visitorId;
    }

    if (Object.keys(patch).length > 0) {
      await tx.contacts.update({
        where: { id: existing.id },
        data: { ...patch, updated_at: new Date() },
      });
    }

    return existing.id;
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
    if (!current.phone && profile.phone) {
      // Unlike createSession this cannot reject: the visitor is mid-
      // conversation and their session must survive a phone we cannot
      // parse. Leaving the field empty keeps them reachable on the web
      // channel and lets a later submission fill it in properly.
      const canonical = toE164(
        profile.phone,
        await resolveAccountCountry(this.prisma, accountId),
      );
      if (canonical) data.phone = canonical;
    }
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
