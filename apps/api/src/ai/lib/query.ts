import type { ChatMessage } from './types';

/**
 * The text knowledge retrieval runs against: the customer's most recent
 * message. Tool turns are skipped — a tool result is our own text, and
 * retrieving against it would search the knowledge base for whatever an
 * API happened to return.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  const lastSpoken = [...messages].reverse().find((m) => m.role !== 'tool');
  return lastSpoken?.content ?? '';
}

/** Trim the handoff trigger phrases and match them case-insensitively. */
export function matchesHandoffPhrase(
  text: string,
  phrases: string[],
): string | null {
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    const needle = phrase.trim().toLowerCase();
    if (needle && haystack.includes(needle)) return phrase.trim();
  }
  return null;
}
