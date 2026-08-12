import type { Conversation, Contact, Tag, SenderType } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

/**
 * The unread count a conversation row should carry once `senderType`'s
 * message lands in it.
 *
 * ONLY A CUSTOMER MESSAGE COUNTS. The server already agrees: every
 * inbound path bumps `unread_count` (whatsapp-webhook.service.ts,
 * instagram-webhook.service.ts, web-inbound.service.ts) and no outbound
 * path touches it. So incrementing on an `agent` or `bot` message
 * invents a badge that no conversation UPDATE will ever come along to
 * clear — it survives until a full refetch.
 *
 * That is a shared-inbox bug specifically, and it compounds: the rule
 * fires on every teammate's open tab, so one agent working through a
 * queue silently adds a phantom unread to every other agent's list for
 * each reply they send, and the AI auto-reply bot does the same on
 * threads nobody has touched. The badge is the one number an agent
 * triages by, so inflating it is worse than showing nothing.
 *
 * `isActive` short-circuits to 0: a message arriving in the thread the
 * agent is looking at right now has been read by definition.
 */
export function nextUnreadCount({
  current,
  senderType,
  isActive,
}: {
  current: number;
  senderType: SenderType;
  isActive: boolean;
}): number {
  if (isActive) return 0;
  return senderType === "customer" ? current + 1 : current;
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
