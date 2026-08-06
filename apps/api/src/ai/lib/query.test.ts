import { describe, expect, it } from 'vitest';

import { latestUserMessage, matchesHandoffPhrase } from './query';

describe('latestUserMessage', () => {
  it('returns the most recent customer turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second');
  });

  it('ignores tool turns — retrieval must not search for an API response', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'where is my order' },
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'status: shipped', toolCallId: 'c1' },
      ]),
    ).toBe('where is my order');
  });

  it('falls back to the last spoken turn, never a tool result', () => {
    expect(
      latestUserMessage([
        { role: 'assistant', content: 'anyone there?' },
        { role: 'tool', content: 'raw json', toolCallId: 'c1' },
      ]),
    ).toBe('anyone there?');
    expect(latestUserMessage([])).toBe('');
  });
});

describe('matchesHandoffPhrase', () => {
  it('matches anywhere in the message, ignoring case', () => {
    expect(
      matchesHandoffPhrase('Can I TALK TO A HUMAN please', ['talk to a human']),
    ).toBe('talk to a human');
  });

  it('returns null when nothing matches', () => {
    expect(matchesHandoffPhrase('what are your hours', ['human'])).toBeNull();
    expect(matchesHandoffPhrase('anything', [])).toBeNull();
  });

  it('ignores blank phrases, which would otherwise match everything', () => {
    expect(matchesHandoffPhrase('hello', ['   ', ''])).toBeNull();
  });
});
