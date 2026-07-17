import type { ChatMessage } from './types';

export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return messages.length > 0 ? messages[messages.length - 1].content : '';
}
