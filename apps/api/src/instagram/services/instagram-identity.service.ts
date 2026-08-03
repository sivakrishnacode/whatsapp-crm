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

  /**
   * IGSID → time of the last profile lookup that came back with nothing.
   *
   * Without it, a contact whose profile is permanently unresolvable would
   * spend a Graph call on every inbound message. Deliberately in-process
   * and lost on restart: this only paces a best-effort upgrade, so the
   * cost of forgetting is one extra call.
   */
  private readonly lastEmptyProfileLookup = new Map<string, number>();
  private static readonly PROFILE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
  private static readonly MAX_TRACKED_LOOKUPS = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find or create the contact behind an IGSID.
   *
   * The profile lookup (name, @handle, avatar) is best-effort and only
   * happens on first sight — it costs a Graph round trip, and a
   * failure must never cost us the message. An unresolvable profile
   * leaves the contact named by its IGSID, which the UI renders until
   * `upgradePlaceholderName` gets a second chance on a later inbound
   * message.
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

    // `paceRetries: false` is load-bearing. A contact created from the
    // echo of our own outbound DM CANNOT have a resolvable profile yet —
    // Meta answers 230 "user consent is required" until the person has
    // messaged us, and they have not, or we would not be creating them
    // from an echo. Stamping the cooldown on that guaranteed failure is
    // what used to suppress the retry on their very first reply, 90
    // seconds later, leaving them named by their IGSID for good.
    //
    // Nothing is lost by not pacing here: creation happens once per
    // contact, so there is no per-message call to protect against. The
    // cooldown exists for `upgradePlaceholderName`, which runs on every
    // inbound.
    const profile = await this.fetchProfileQuietly(
      args.igsid,
      args.accessToken,
      { paceRetries: false },
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
          source: 'instagram',
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

  /**
   * Second (and later) chance at a real name for a contact still wearing
   * its IGSID as a display name.
   *
   * The profile API answers only for users who have a messaging
   * relationship with the business, so a contact first seen through the
   * echo of an outbound DM *we* sent cannot be resolved at creation time
   * — that is where the bare numbers in the inbox come from. Their first
   * reply is the moment the lookup starts working, so callers run this on
   * inbound messages.
   *
   * A name that is no longer the IGSID is left untouched: it was either
   * resolved already or renamed by an agent, and neither should be
   * clobbered. Returns the contact to use — upgraded, or the original.
   */
  async upgradePlaceholderName(args: {
    contact: contacts;
    accessToken: string;
  }): Promise<contacts> {
    const { contact, accessToken } = args;
    const igsid = contact.ig_scoped_id;
    if (!igsid || contact.name !== igsid) return contact;
    if (this.inLookupCooldown(igsid)) return contact;

    const profile = await this.fetchProfileQuietly(igsid, accessToken);
    const username = profile?.username ?? contact.ig_username ?? null;
    const displayName = profile?.name || (username ? `@${username}` : null);
    if (!displayName) {
      // The call succeeded but carried no name — same practical outcome
      // as a failure, so pace the next attempt the same way.
      this.noteEmptyLookup(igsid);
      return contact;
    }

    try {
      return await this.prisma.contacts.update({
        where: { id: contact.id },
        data: {
          name: displayName,
          ig_username: username,
          // Never trade an avatar we already have for nothing.
          avatar_url: profile?.profilePictureUrl ?? contact.avatar_url,
          updated_at: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not upgrade IGSID-named contact ${contact.id}: ${String(err)}`,
      );
      return contact;
    }
  }

  /**
   * @param paceRetries Whether a failure should start the retry
   *   cooldown. True for the per-inbound upgrade path, which would
   *   otherwise spend a Graph call per message on someone permanently
   *   unresolvable. False for one-off callers, where there is no repeat
   *   to pace and a stamp only sabotages the next genuine attempt.
   */
  private async fetchProfileQuietly(
    igsid: string,
    accessToken: string,
    opts: { paceRetries?: boolean } = {},
  ) {
    try {
      const profile = await getUserProfile({ igsid, accessToken });
      this.lastEmptyProfileLookup.delete(igsid);
      return profile;
    } catch (err) {
      // Expected in development mode (profiles only resolve for users
      // who have messaged the business) and whenever Meta rate-limits.
      if (opts.paceRetries !== false) this.noteEmptyLookup(igsid);
      this.logger.debug(
        `Instagram profile lookup failed for ${igsid}: ${String(err)}`,
      );
      return null;
    }
  }

  private inLookupCooldown(igsid: string): boolean {
    const last = this.lastEmptyProfileLookup.get(igsid);
    if (last === undefined) return false;
    return (
      Date.now() - last < InstagramIdentityService.PROFILE_RETRY_COOLDOWN_MS
    );
  }

  private noteEmptyLookup(igsid: string): void {
    // Bound the map by evicting the oldest entry. Reaching the cap means
    // thousands of distinct users are unresolvable, and the penalty for
    // forgetting one is a single extra Graph call.
    if (
      this.lastEmptyProfileLookup.size >=
      InstagramIdentityService.MAX_TRACKED_LOOKUPS
    ) {
      const oldest = this.lastEmptyProfileLookup.keys().next().value;
      if (oldest !== undefined) this.lastEmptyProfileLookup.delete(oldest);
    }
    this.lastEmptyProfileLookup.set(igsid, Date.now());
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
