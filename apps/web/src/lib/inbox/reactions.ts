import type { ConversationChannel } from "@/types";

/**
 * Reactions are NOT one feature with three transports — each channel
 * has its own vocabulary, its own endpoint and its own request shape.
 *
 * WhatsApp takes ANY emoji and addresses the contact by phone number.
 * Instagram takes one of SIX FIXED NAMES and addresses the contact by
 * IGSID. The web widget has no reaction transport at all — nothing in
 * the API writes `message_reactions` for it.
 *
 * Everything here exists because the inbox used to POST every
 * reaction to `/api/whatsapp/react` regardless of channel. On an
 * Instagram thread that endpoint looks up `contacts.phone`, which an
 * Instagram contact does not have, and every react failed with
 * "Contact phone number not found".
 */

/**
 * ⚠️ MIRROR of `IG_REACTIONS` + `emojiFor()` in
 * `apps/api/src/instagram/services/instagram-send.service.ts`, which is
 * the authority. The API rejects any name not in its own list, and the
 * emoji it persists is the one on the right — so these pairs must stay
 * byte-identical or the optimistic pill will differ from the pill that
 * comes back from the database a moment later.
 */
const IG_REACTION_BY_EMOJI = {
  "👍": "like",
  "❤️": "love",
  "😂": "laugh",
  "😮": "wow",
  "😢": "sad",
  "😡": "angry",
} as const;

export type IgReaction =
  (typeof IG_REACTION_BY_EMOJI)[keyof typeof IG_REACTION_BY_EMOJI];

/** The named Instagram reaction for an emoji, or null if it has none. */
export function igReactionFor(emoji: string): IgReaction | null {
  return (
    IG_REACTION_BY_EMOJI[emoji as keyof typeof IG_REACTION_BY_EMOJI] ?? null
  );
}

/**
 * The quick-reaction bar, per channel.
 *
 * WhatsApp's own bar starts with these six, so picking the same set
 * keeps the affordance familiar without pulling in a 300KB emoji
 * library. Instagram's set is not a style choice: it is exactly the
 * six the API accepts, listed so that nothing on offer can fail. 🙏 is
 * absent there for that reason, and 😡 is present for the same one.
 *
 * An EMPTY list means the channel cannot react at all, and the button
 * is hidden rather than shown-and-then-failing.
 */
const QUICK_EMOJIS: Record<ConversationChannel, readonly string[]> = {
  whatsapp: ["👍", "❤️", "😂", "😮", "😢", "🙏"],
  instagram: Object.keys(IG_REACTION_BY_EMOJI),
  web: [],
};

export function quickEmojisFor(
  channel: ConversationChannel,
): readonly string[] {
  return QUICK_EMOJIS[channel];
}

/** Whether this channel has a reaction transport at all. */
export function channelSupportsReactions(
  channel: ConversationChannel,
): boolean {
  return QUICK_EMOJIS[channel].length > 0;
}

/**
 * The request the channel's own react endpoint expects.
 *
 * Returns null when the emoji cannot be expressed on the channel —
 * the caller must not fall back to another endpoint, which is the bug
 * this module exists to prevent.
 */
export function buildReactionRequest(args: {
  channel: ConversationChannel;
  conversationId: string;
  messageId: string;
  /** "" removes the agent's reaction. */
  emoji: string;
}): { path: string; body: Record<string, string> } | null {
  const { channel, conversationId, messageId, emoji } = args;

  if (channel === "whatsapp") {
    return {
      path: "/api/whatsapp/react",
      body: { message_id: messageId, emoji },
    };
  }

  if (channel === "instagram") {
    // An absent `reaction` is how the API spells "remove", matching the
    // WhatsApp endpoint's empty emoji.
    if (emoji === "") {
      return {
        path: "/api/instagram/react",
        body: { conversation_id: conversationId, message_id: messageId },
      };
    }
    const reaction = igReactionFor(emoji);
    if (!reaction) return null;
    return {
      path: "/api/instagram/react",
      body: {
        conversation_id: conversationId,
        message_id: messageId,
        reaction,
      },
    };
  }

  return null;
}
