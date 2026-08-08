import { describe, expect, it } from 'vitest';

import { withDraftNudge } from './context';
import { latestUserMessage } from './query';
import type { ChatMessage } from './types';

/**
 * The bug this pins: the inbox draft button sent a transcript ending on
 * the business's own message, so the model was asked to continue its own
 * turn with nothing new to answer. Gemini returns an unusable candidate
 * for that shape (empty text with `finishReason: STOP`, or
 * `MALFORMED_RESPONSE`), which surfaced as "Couldn't draft a reply."
 */
describe('withDraftNudge', () => {
  it('leaves a transcript that already ends on the customer alone', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'do you do logos?' },
    ];
    expect(withDraftNudge(messages)).toEqual(messages);
  });

  it('appends a user turn when the business spoke last', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello test' },
    ];
    const out = withDraftNudge(messages);

    expect(out).toHaveLength(3);
    expect(out.slice(0, 2)).toEqual(messages);
    expect(out[2].role).toBe('user');
    expect(out[2].content).toContain('Write the next message');
  });

  it('leaves a pending tool result alone — the model owes an answer to it', () => {
    const afterTool: ChatMessage[] = [
      { role: 'user', content: 'where is my order' },
      { role: 'assistant', content: '', toolCalls: [] },
      { role: 'tool', content: 'status: shipped', toolCallId: 'c1' },
    ];
    expect(withDraftNudge(afterTool)).toEqual(afterTool);
  });

  it('does not mutate the transcript it was given', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'hello' }];
    withDraftNudge(messages);
    expect(messages).toHaveLength(1);
  });

  it('returns an empty transcript untouched', () => {
    expect(withDraftNudge([])).toEqual([]);
  });

  /**
   * Ordering constraint, not a nicety: `assemble()` retrieves knowledge
   * with `latestUserMessage()`, so nudging before retrieval would search
   * the knowledge base for our own instruction text.
   */
  it('would poison knowledge retrieval if applied before assemble', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do you do packaging design' },
      { role: 'assistant', content: 'hello test' },
    ];
    expect(latestUserMessage(messages)).toBe('do you do packaging design');
    expect(latestUserMessage(withDraftNudge(messages))).not.toBe(
      'do you do packaging design',
    );
  });
});
