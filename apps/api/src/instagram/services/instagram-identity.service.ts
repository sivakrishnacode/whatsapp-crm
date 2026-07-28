import { Injectable, Logger } from '@nestjs/common';
import type { contacts, conversations } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getUserProfile } from '../ig-api.util';

export interface IgContactOutcome {
  contact: contacts;
  wasCreated: boolean;
}

export interface IgConversationOutcome {
  conversation: conversations;
  created: boolean;
}

/**
 * Resolves Instagram users and threads onto the shared
 * contacts / conversations tables.
 *
 * IDENTITY IS BY IGSID, AND ONLY BY IGSID
 *   An Instagram-scoped ID is the only stable handle we get. Usernames
 *   change; there is no phone, no email, nothing to cross-reference.
 *   Two consequences that shape everything here:
 *
 *   1. Instagram contacts are created with `phone: null`. That is why
 *      migration 050 dropped the NOT NULL and added
 *      `contacts_identity_chk` in its place.
 *
 *   2. We do NOT attempt to match an Instagram user to an existing
 *      WhatsApp contact. There is no signal that would make such a
 *      match correct, and a wrong one merges two different people's
 *      conversation histories. The same human on both channels is two
 *      contacts until someone explicitly merges them.
 *
 * IGSIDs ARE APP-SCOPED
 *   The same Instagram user has a different IGSID under a different
 *   Meta app. These values do not survive an app migration — worth
 *   knowing before anyone proposes splitting the app.
 */
@Injectable()
export class InstagramIdentityService {
  private readonly logger = new Logger(InstagramIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find or create the contact behind an IGSID.
   *
   * The profile lookup (name, @handle, avatar) is best-effort and only
   * happens on first sight — it costs a Graph round trip, and a
   * failure must never cost us the message. An unresolvable profile
   * leaves the contact named by its IGSID, which the UI renders and a
   * later message can upgrade.
   */
  async findOrCreateContact(args: {
    accountId: string;
    ownerUserId: string;
    igsid: string;
    accessToken: string;
    /** Username from the webhook, when one came with it (comments do). */
    knownUsername?: string;
  }): Promise<IgContactOutcome | null> {
    const existing = await this.prisma.contacts.findFirst({
      where: { account_id: args.accountId, ig_scoped_id: args.igsid },
    });

    if (existing) {
      // Usernames change. Keep the cached handle fresh when a webhook
      // happens to carry one, but never spend an API call on it.
      if (args.knownUsername && args.knownUsername !== existing.ig_username) {
        try {
          const updated = await this.prisma.contacts.update({
            where: { id: existing.id },
            data: { ig_username: args.knownUsername, updated_at: new Date() },
          });
          return { contact: updated, wasCreated: false };
        } catch (err) {
          this.logger.warn(`Could not refresh ig_username: ${String(err)}`);
        }
      }
      return { contact: existing, wasCreated: false };
    }

    const profile = await this.fetchProfileQuietly(
      args.igsid,
      args.accessToken,
    );
    const username = profile?.username ?? args.knownUsername;
    const displayName =
      profile?.name || (username ? `@${username}` : args.igsid);

    try {
      const created = await this.prisma.contacts.create({
        data: {
          account_id: args.accountId,
          user_id: args.ownerUserId,
          // No phone. See the class comment — this is the whole reason
          // contacts.phone became nullable.
          phone: null,
          ig_scoped_id: args.igsid,
          ig_username: username ?? null,
          name: displayName,
          avatar_url: profile?.profilePictureUrl ?? null,
        },
      });
      return { contact: created, wasCreated: true };
    } catch (err) {
      // Two webhooks for the same new user can land concurrently. The
      // partial unique index on (account_id, ig_scoped_id) turns the
      // loser into P2002 — re-read rather than dropping the message.
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await this.prisma.contacts.findFirst({
          where: { account_id: args.accountId, ig_scoped_id: args.igsid },
        });
        if (raced) return { contact: raced, wasCreated: false };
      }
      this.logger.error(
        `Could not create an Instagram contact for ${args.igsid}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  private async fetchProfileQuietly(igsid: string, accessToken: string) {
    try {
      return await getUserProfile({ igsid, accessToken });
    } catch (err) {
      // Expected in development mode (profiles only resolve for users
      // who have messaged the business) and whenever Meta rate-limits.
      this.logger.debug(
        `Instagram profile lookup failed for ${igsid}: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * The Instagram thread for a contact.
   *
   * `channel: 'instagram'` is mandatory on both the lookup and the
   * create — a contact can own one thread per channel, and an
   * unfiltered lookup would append Instagram messages to a WhatsApp
   * conversation.
   */
  async findOrCreateConversation(args: {
    accountId: string;
    ownerUserId: string;
    contactId: string;
  }): Promise<IgConversationOutcome | null> {
    const existing = await this.prisma.conversations.findFirst({
      where: {
        account_id: args.accountId,
        contact_id: args.contactId,
        channel: 'instagram',
      },
    });

    if (existing) return { conversation: existing, created: false };

    try {
      const created = await this.prisma.conversations.create({
        data: {
          account_id: args.accountId,
          user_id: args.ownerUserId,
          contact_id: args.contactId,
          channel: 'instagram',
        },
      });
      return { conversation: created, created: true };
    } catch (err) {
      this.logger.error(
        `Could not create an Instagram conversation for contact ${args.contactId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }
}
