import { describe, expect, it } from 'vitest';
import { triggerMatches } from './automation-trigger-match.util';

describe('triggerMatches', () => {
  it('passes unconditionally for non-keyword_match trigger types', () => {
    expect(
      triggerMatches('new_message_received', {}, { message_text: 'anything' }),
    ).toBe(true);
    expect(triggerMatches('first_inbound_message', {}, undefined)).toBe(true);
  });

  it('rejects keyword_match with no keywords configured', () => {
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: [] },
        { message_text: 'hello' },
      ),
    ).toBe(false);
    expect(triggerMatches('keyword_match', {}, { message_text: 'hello' })).toBe(
      false,
    );
  });

  it('rejects keyword_match when there is no message text', () => {
    expect(
      triggerMatches('keyword_match', { keywords: ['hi'] }, undefined),
    ).toBe(false);
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['hi'] },
        { message_text: '' },
      ),
    ).toBe(false);
  });

  it('matches "contains" case-insensitively by default', () => {
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['PRICING'], match_type: 'contains' },
        { message_text: 'ask about pricing please' },
      ),
    ).toBe(true);
  });

  it('matches "exact" only on the whole message', () => {
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['hi'], match_type: 'exact' },
        { message_text: 'hi there' },
      ),
    ).toBe(false);
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['hi'], match_type: 'exact' },
        { message_text: 'hi' },
      ),
    ).toBe(true);
  });

  it('respects case_sensitive', () => {
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['Pricing'], match_type: 'contains', case_sensitive: true },
        { message_text: 'ask about pricing' },
      ),
    ).toBe(false);
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['pricing'], match_type: 'contains', case_sensitive: true },
        { message_text: 'ask about pricing' },
      ),
    ).toBe(true);
  });

  it('matches if any of multiple keywords hits', () => {
    expect(
      triggerMatches(
        'keyword_match',
        { keywords: ['quote', 'buy', 'pricing'], match_type: 'contains' },
        { message_text: 'can I buy this?' },
      ),
    ).toBe(true);
  });
});
