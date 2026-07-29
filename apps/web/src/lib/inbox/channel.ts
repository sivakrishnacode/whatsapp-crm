import type { Conversation, ConversationChannel } from "@/types";

/**
 * Every channel a conversation may live on. Mirrors `CHANNELS` in
 * apps/api's `common/messaging/channel.ts`, which is the authority.
 */
const CHANNELS: readonly ConversationChannel[] = [
  "whatsapp",
  "instagram",
  "web",
];

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
 *
 * Membership-checked rather than compared against one known value: with
 * three channels, an `=== "instagram" ? … : "whatsapp"` shape would
 * quietly relabel every web thread as WhatsApp, and the inbox would
 * offer a template picker for a channel that has no templates.
 */
export function conversationChannel(
  conversation: Pick<Conversation, "channel">,
): ConversationChannel {
  const { channel } = conversation;
  return channel && CHANNELS.includes(channel) ? channel : "whatsapp";
}

/** True when replies to this thread go out over Instagram. */
export function isInstagramConversation(
  conversation: Pick<Conversation, "channel">,
): boolean {
  return conversationChannel(conversation) === "instagram";
}

/** True when replies to this thread go out over the website widget. */
export function isWebConversation(
  conversation: Pick<Conversation, "channel">,
): boolean {
  return conversationChannel(conversation) === "web";
}
