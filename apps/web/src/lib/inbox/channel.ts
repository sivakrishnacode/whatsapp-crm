import type { Conversation, ConversationChannel } from "@/types";

/**
 * The channel a conversation lives on, with the safe default applied.
 *
 * `conversations.channel` is NOT NULL with a `whatsapp` default in the
 * database, but the field is optional on the client for two reasons:
 * Supabase Realtime payloads are assembled from the changed columns and
 * can omit it, and a client holding rows fetched before a schema
 * refresh will not have it either.
 *
 * Reading it through this helper — rather than `c.channel` directly —
 * means a missing value renders as WhatsApp (which every pre-Instagram
 * row is) instead of `undefined` leaking into a badge or a filter
 * comparison.
 */
export function conversationChannel(
  conversation: Pick<Conversation, "channel">,
): ConversationChannel {
  return conversation.channel === "instagram" ? "instagram" : "whatsapp";
}

/** True when replies to this thread go out over Instagram. */
export function isInstagramConversation(
  conversation: Pick<Conversation, "channel">,
): boolean {
  return conversationChannel(conversation) === "instagram";
}
