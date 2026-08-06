import { describe, expect, it } from 'vitest';

import {
  parseBudgetMinor,
  parseFloatOrNull,
  parseSpendMinor,
} from './marketing-api.util';
import { resultCount } from './marketing-insights.util';
import { inferAdType } from './services/ads-sync.service';
import { resolveRange } from './controllers/ads-insights.controller';

/**
 * Meta sends money in two different units on the same surface:
 * budgets are MINOR ("50000" = ₹500), insights spend is MAJOR
 * ("500.00" = ₹500). Both are strings. Confusing them is a 100× error on
 * a real customer's card, so both directions are pinned here.
 */

describe('parseBudgetMinor — budgets are already minor units', () => {
  it('passes a minor-unit string straight through', () => {
    // "50000" from Meta means ₹500.00, i.e. 50000 minor units.
    expect(parseBudgetMinor('50000')).toBe(50000);
  });

  it('does NOT multiply by 100', () => {
    // The bug this exists to prevent: treating a budget like a spend
    // would make ₹500/day into ₹50,000/day.
    expect(parseBudgetMinor('50000')).not.toBe(5_000_000);
  });

  it('tolerates the ".0" Meta sometimes appends', () => {
    expect(parseBudgetMinor('50000.0')).toBe(50000);
  });

  it('distinguishes absent from zero', () => {
    expect(parseBudgetMinor(null)).toBeNull();
    expect(parseBudgetMinor(undefined)).toBeNull();
    expect(parseBudgetMinor('')).toBeNull();
    // 0 is a real value (a cleared campaign budget), not "missing".
    expect(parseBudgetMinor('0')).toBe(0);
  });

  it('returns null for junk rather than NaN', () => {
    // NaN would reach a BIGINT column and throw at insert time, far from
    // the cause.
    expect(parseBudgetMinor('not-a-number')).toBeNull();
  });
});

describe('parseSpendMinor — insights spend is major units', () => {
  it('converts a major-unit decimal string to minor units', () => {
    expect(parseSpendMinor('500.00')).toBe(50000);
    expect(parseSpendMinor('12.34')).toBe(1234);
  });

  it('rounds AFTER multiplying, so no paisa is lost to float error', () => {
    // Meta reports spend to 2 decimal places, and many of those values
    // are not exactly representable in IEEE 754: 0.29 * 100 is
    // 28.999999999999996 and 1.13 * 100 is 112.99999999999999. A
    // truncating cast stores 28 and 112 — a paisa lost per row, on
    // every row, forever.
    expect(parseSpendMinor('0.29')).toBe(29);
    expect(parseSpendMinor('1.13')).toBe(113);
    expect(parseSpendMinor('0.57')).toBe(57);
    expect(parseSpendMinor('500.00')).toBe(50000);
    // Proof the naive version really is wrong, so this test cannot be
    // "simplified" back into it.
    expect(Math.trunc(0.29 * 100)).toBe(28);
    expect(Math.trunc(1.13 * 100)).toBe(112);
  });

  it('treats absent spend as zero, not null', () => {
    // A day with no delivery genuinely spent nothing, and the column is
    // NOT NULL DEFAULT 0.
    expect(parseSpendMinor(null)).toBe(0);
    expect(parseSpendMinor('')).toBe(0);
  });

  it('handles large amounts without precision loss', () => {
    // ₹1,23,456.78 → 12345678 minor. Well inside MAX_SAFE_INTEGER.
    expect(parseSpendMinor('123456.78')).toBe(12345678);
  });
});

describe('parseFloatOrNull', () => {
  it('keeps ratios as floats and junk as null', () => {
    expect(parseFloatOrNull('1.234')).toBeCloseTo(1.234);
    expect(parseFloatOrNull('')).toBeNull();
    expect(parseFloatOrNull('abc')).toBeNull();
    expect(parseFloatOrNull('0')).toBe(0);
  });
});

describe('resultCount', () => {
  const actions = [
    { action_type: 'link_click', value: '40' },
    {
      action_type: 'onsite_conversion.messaging_conversation_started_7d',
      value: '9',
    },
    {
      action_type: 'onsite_conversion.total_messaging_connection',
      value: '11',
    },
  ];

  it('takes the FIRST matching action type, never the sum', () => {
    // The candidates are alternative names and attribution windows for
    // the same event. Summing them would report 20 conversations where
    // 9 happened.
    expect(resultCount(actions, 'click_to_whatsapp')).toBe(9);
  });

  it('falls through to the next candidate when the preferred one is absent', () => {
    const partial = actions.filter(
      (a) =>
        a.action_type !== 'onsite_conversion.messaging_conversation_started_7d',
    );
    expect(resultCount(partial, 'click_to_whatsapp')).toBe(11);
  });

  it('uses a different action type per ad type', () => {
    expect(resultCount(actions, 'website_to_whatsapp')).toBe(40);
    expect(
      resultCount([{ action_type: 'lead', value: '3' }], 'lead_form'),
    ).toBe(3);
  });

  it('returns 0 for no actions or an unknown ad type', () => {
    expect(resultCount(null, 'click_to_whatsapp')).toBe(0);
    expect(resultCount([], 'click_to_whatsapp')).toBe(0);
    expect(resultCount(actions, 'not_a_real_type')).toBe(0);
  });
});

describe('inferAdType', () => {
  it('maps objectives to our closest ad type', () => {
    expect(inferAdType('OUTCOME_LEADS')).toBe('lead_form');
    expect(inferAdType('OUTCOME_ENGAGEMENT')).toBe('click_to_whatsapp');
    expect(inferAdType('OUTCOME_AWARENESS')).toBe('whatsapp_status');
    expect(inferAdType('OUTCOME_TRAFFIC')).toBe('website');
  });

  it('falls back rather than throwing on an unknown or missing objective', () => {
    // Meta adds objectives; a sync must not fail on one it has not met.
    expect(inferAdType(null)).toBe('website');
    expect(inferAdType('OUTCOME_SOMETHING_NEW')).toBe('website');
  });

  it('only ever produces a value the CHECK constraint allows', () => {
    const allowed = new Set([
      'click_to_whatsapp',
      'whatsapp_status',
      'website_to_whatsapp',
      'website',
      'lead_form',
    ]);
    for (const objective of [
      'OUTCOME_LEADS',
      'OUTCOME_ENGAGEMENT',
      'OUTCOME_SALES',
      'OUTCOME_AWARENESS',
      'OUTCOME_APP_PROMOTION',
      'OUTCOME_TRAFFIC',
      null,
    ]) {
      // A value outside this set violates meta_ads_campaigns_ad_type_chk
      // and fails the insert, which would break the whole sync.
      expect(allowed.has(inferAdType(objective))).toBe(true);
    }
  });
});

describe('resolveRange', () => {
  it('defaults to a 7-day window ending today', () => {
    const range = resolveRange({});
    const span =
      (Date.parse(`${range.until}T00:00:00Z`) -
        Date.parse(`${range.since}T00:00:00Z`)) /
      86_400_000;
    expect(span).toBe(6); // inclusive of both ends = 7 days
  });

  it('passes an explicit range through untouched', () => {
    expect(resolveRange({ since: '2026-01-01', until: '2026-01-31' })).toEqual({
      since: '2026-01-01',
      until: '2026-01-31',
    });
  });

  it('swaps a reversed range instead of erroring', () => {
    // A date-picker slip should render something, not a validation wall.
    expect(resolveRange({ since: '2026-02-01', until: '2026-01-01' })).toEqual({
      since: '2026-01-01',
      until: '2026-02-01',
    });
  });

  it('clamps an absurd window to the cap, keeping `until`', () => {
    const range = resolveRange({ since: '2000-01-01', until: '2026-01-01' });
    expect(range.until).toBe('2026-01-01');
    const span =
      (Date.parse(`${range.until}T00:00:00Z`) -
        Date.parse(`${range.since}T00:00:00Z`)) /
        86_400_000 +
      1;
    expect(span).toBe(400);
  });
});
