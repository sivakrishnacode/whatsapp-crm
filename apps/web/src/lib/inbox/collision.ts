// ============================================================
// Collision helpers — pure, unit-testable, no I/O.
//
// Turns the raw Realtime presence state for an account's inbox (see
// use-inbox-presence.ts and migration 079) into the two questions the
// UI actually asks:
//
//   "who else is in THIS conversation?"        → viewersOf()
//   "which conversations have somebody in them?" → occupiedConversationIds()
//
// `now` is injected rather than read from the clock, matching
// lib/presence.ts, so staleness and formatting stay deterministic.
// ============================================================

/** What each open inbox tab broadcasts about itself. */
export interface InboxPresence {
  userId: string;
  name: string;
  /** The thread they have open, or null if they're on the empty state. */
  conversationId: string | null;
  /** They have focus in the composer for `conversationId`. */
  typing: boolean;
  /** Epoch ms, stamped by the sender when it last tracked. */
  at: number;
}

/**
 * A presence entry older than this is ignored.
 *
 * Realtime removes an entry when its socket closes, so this is not the
 * primary cleanup — it is the backstop for the case that actually
 * misleads people: a laptop suspended mid-thread whose socket has not
 * yet been reaped. "Anil is viewing" pinned to a thread Anil left an
 * hour ago is worse than showing nothing, because the whole feature
 * exists to be trusted in the second before you start typing.
 */
export const PRESENCE_STALE_AFTER_MS = 90_000;

/**
 * One entry per person, newest wins.
 *
 * Realtime keys presence by connection, not by user, so the same person
 * with the inbox open in two tabs — or mid-reconnect, when the old
 * entry has not yet been reaped — appears more than once. Collapsing on
 * userId is what stops the header reading "Anil, Anil is also here".
 * The newest entry wins because it is the one describing the tab they
 * are actually looking at.
 */
export function dedupeByUser(entries: InboxPresence[]): InboxPresence[] {
  const byUser = new Map<string, InboxPresence>();
  for (const e of entries) {
    const seen = byUser.get(e.userId);
    if (!seen || e.at > seen.at) byUser.set(e.userId, e);
  }
  return [...byUser.values()];
}

/**
 * Everyone *except* me who currently has `conversationId` open.
 *
 * Excluding self is not cosmetic: my own tab is always in the presence
 * state, so without this every thread would claim to be occupied and
 * the warning would mean nothing.
 */
export function viewersOf(
  entries: InboxPresence[],
  conversationId: string | null,
  selfUserId: string | null,
  now: number,
): InboxPresence[] {
  if (!conversationId) return [];
  return dedupeByUser(
    entries.filter(
      (e) =>
        e.conversationId === conversationId &&
        e.userId !== selfUserId &&
        now - e.at <= PRESENCE_STALE_AFTER_MS,
    ),
  ).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Conversation ids somebody other than me is currently in, for marking
 * rows in the list before the agent clicks into one.
 */
export function occupiedConversationIds(
  entries: InboxPresence[],
  selfUserId: string | null,
  now: number,
): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.userId === selfUserId) continue;
    if (!e.conversationId) continue;
    if (now - e.at > PRESENCE_STALE_AFTER_MS) continue;
    ids.add(e.conversationId);
  }
  return ids;
}

/**
 * The sentence shown in the thread header.
 *
 * Typing outranks viewing, and is named separately, because they carry
 * different urgency: someone *viewing* the thread is a reason to
 * coordinate, someone *typing* in it is a reason to stop. Names are
 * spelled out up to two — past that the list is longer than the warning
 * and the count is the useful part.
 */
export function collisionLabel(viewers: InboxPresence[]): string | null {
  if (viewers.length === 0) return null;

  const typing = viewers.filter((v) => v.typing);
  const people = typing.length > 0 ? typing : viewers;
  const verb = typing.length > 0 ? "replying" : "viewing";

  const names =
    people.length === 1
      ? people[0].name
      : people.length === 2
        ? `${people[0].name} and ${people[1].name}`
        : `${people[0].name} and ${people.length - 1} others`;

  const isAre = people.length === 1 ? "is" : "are";
  return `${names} ${isAre} also ${verb}`;
}
