import { describe, expect, it } from 'vitest';

import {
  computeFieldVisibility,
  matchesCondition,
  splitIntoPages,
  type FieldCondition,
} from './visibility';

/**
 * These cases mirror the ones in
 * apps/api/src/forms/form-validate.test.ts. When the two files disagree,
 * a form becomes unsubmittable: the browser hides a required field, the
 * server demands it, and the error is painted onto an input that is not
 * on screen. Change both or neither.
 */

const rule = (over: Partial<FieldCondition> = {}): FieldCondition => ({
  field_key: 'how',
  operator: 'equals',
  value: 'other',
  ...over,
});

describe('matchesCondition', () => {
  it('compares equality as strings', () => {
    expect(matchesCondition(rule(), 'other')).toBe(true);
    expect(matchesCondition(rule(), 'friend')).toBe(false);
  });

  it('handles not_equals', () => {
    expect(matchesCondition(rule({ operator: 'not_equals' }), 'friend')).toBe(
      true,
    );
  });

  it('treats a multiselect as "is one of the ticked boxes"', () => {
    expect(matchesCondition(rule(), ['other', 'friend'])).toBe(true);
    expect(matchesCondition(rule(), ['friend'])).toBe(false);
    expect(
      matchesCondition(rule({ operator: 'not_equals' }), ['friend']),
    ).toBe(true);
  });

  it('handles emptiness without a value', () => {
    expect(matchesCondition(rule({ operator: 'is_empty' }), '')).toBe(true);
    expect(matchesCondition(rule({ operator: 'is_empty' }), [])).toBe(true);
    expect(matchesCondition(rule({ operator: 'is_not_empty' }), 'x')).toBe(
      true,
    );
  });

  it('never matches a blank answer for a value-based operator', () => {
    expect(matchesCondition(rule(), '')).toBe(false);
    expect(matchesCondition(rule({ operator: 'not_equals' }), '')).toBe(false);
  });

  it('compares numerically for greater_than / less_than', () => {
    expect(
      matchesCondition(rule({ operator: 'greater_than', value: '10' }), 20),
    ).toBe(true);
    expect(
      matchesCondition(rule({ operator: 'less_than', value: '10' }), 20),
    ).toBe(false);
  });

  it('returns false rather than throwing on a nonsense numeric compare', () => {
    expect(
      matchesCondition(rule({ operator: 'greater_than', value: 'ten' }), 'x'),
    ).toBe(false);
  });

  it('matches contains case-insensitively', () => {
    expect(
      matchesCondition(rule({ operator: 'contains', value: 'ACME' }), 'acme ltd'),
    ).toBe(true);
  });
});

describe('computeFieldVisibility', () => {
  const fields = [
    { field_key: 'how' },
    { field_key: 'detail', visible_when: rule() },
  ];

  it('shows a field with no rule', () => {
    expect(computeFieldVisibility([{ field_key: 'a' }], {})).toEqual({
      a: true,
    });
  });

  it('hides a field whose rule does not hold', () => {
    expect(computeFieldVisibility(fields, { how: 'friend' }).detail).toBe(
      false,
    );
  });

  it('hides a field whose parent is itself hidden, despite a stale answer', () => {
    const chained = [
      ...fields,
      {
        field_key: 'deeper',
        visible_when: rule({ field_key: 'detail', operator: 'is_not_empty' }),
      },
    ];
    const result = computeFieldVisibility(chained, {
      how: 'friend',
      detail: 'left over',
    });
    expect(result.detail).toBe(false);
    expect(result.deeper).toBe(false);
  });

  it('shows a field whose rule points at something unknown', () => {
    // A field nobody can see is the worse of the two failures.
    const result = computeFieldVisibility(
      [{ field_key: 'q', visible_when: rule({ field_key: 'gone' }) }],
      {},
    );
    expect(result.q).toBe(true);
  });
});

describe('splitIntoPages', () => {
  it('returns one page when there is no break', () => {
    const pages = splitIntoPages([{ type: 'text' }, { type: 'email' }]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(2);
  });

  it('splits on a break and drops the marker', () => {
    const pages = splitIntoPages([
      { type: 'text' },
      { type: 'page_break' },
      { type: 'email' },
    ]);
    expect(pages).toHaveLength(2);
    expect(pages.flat().some((f) => f.type === 'page_break')).toBe(false);
  });

  it('always returns at least one page, so n=1 needs no special case', () => {
    expect(splitIntoPages([])).toEqual([[]]);
  });
});
