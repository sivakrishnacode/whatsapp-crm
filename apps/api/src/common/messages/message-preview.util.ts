/**
 * One-line summary of a message for `conversations.last_message_text`.
 *
 * The conversation list has one line per thread and no renderer — it
 * shows this string verbatim. So a message with no text of its own
 * (a photo, a voice note, a sticker) needs a label written *here*, at
 * insert time; there is nowhere later to derive one.
 *
 * Previously the fallback was `[${message.type}]`, which put Meta's
 * wire vocabulary in front of agents: a voice note previewed as
 * "[audio]" and a shared contact card as "[contacts]".
 */

/** Labels for messages that carry no text. Written for a human. */
const TYPE_LABELS: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎤 Voice message',
  document: '📄 Document',
  sticker: 'Sticker',
  location: '📍 Location',
  contacts: '👤 Contact shared',
  order: '🛒 Cart submitted',
  unsupported: 'Unsupported message',
  system: 'Contact details changed',
};

/**
 * Build the preview line.
 *
 * `contentText` wins whenever there is one — an image's caption says
 * more than "📷 Photo", and for text messages it IS the message.
 * Newlines are collapsed because the list renders a single line and a
 * raw `\n` would silently truncate the preview at the first break.
 *
 * @param type    the inbound Meta type, or the stored content_type
 * @param contentText the message's own text, if it has any
 */
export function buildMessagePreview(
  type: string,
  contentText?: string | null,
): string {
  const text = contentText?.replace(/\s+/g, ' ').trim();
  if (text) return text;
  return TYPE_LABELS[type] ?? 'New message';
}
