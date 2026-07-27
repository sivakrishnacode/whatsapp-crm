import { describe, expect, it } from 'vitest';
import {
  isLimitWebhookField,
  parseLimitWebhookValue,
} from './limit-webhook.util';

describe('isLimitWebhookField', () => {
  it('accepts both fields Meta may deliver limit data on', () => {
    expect(isLimitWebhookField('business_capability_update')).toBe(true);
    expect(isLimitWebhookField('phone_number_quality_update')).toBe(true);
  });

  it('ignores unrelated change fields', () => {
    expect(isLimitWebhookField('messages')).toBe(false);
    expect(isLimitWebhookField('message_template_status_update')).toBe(false);
  });
});

describe('parseLimitWebhookValue', () => {
  it('reads an explicit tier string', () => {
    expect(parseLimitWebhookValue({ current_limit: 'TIER_10K' })).toMatchObject(
      {
        tier: 'TIER_10K',
      },
    );
  });

  it('uppercases and trims a tier string', () => {
    expect(
      parseLimitWebhookValue({ current_limit: '  tier_1k ' }),
    ).toMatchObject({
      tier: 'TIER_1K',
    });
  });

  it('maps a numeric daily cap back onto a known tier', () => {
    expect(
      parseLimitWebhookValue({ max_daily_conversation_per_phone: 10000 }),
    ).toMatchObject({ tier: 'TIER_10K' });
  });

  it('accepts a numeric cap delivered as a string', () => {
    expect(
      parseLimitWebhookValue({ max_daily_conversation_per_phone: '1000' }),
    ).toMatchObject({ tier: 'TIER_1K' });
  });

  it('drops an unmappable numeric cap rather than guessing a tier', () => {
    // A wrong tier is worse than none — it drives the pre-flight warning.
    expect(
      parseLimitWebhookValue({ max_daily_conversation_per_phone: 7777 }),
    ).toMatchObject({ tier: null });
  });

  it('prefers the explicit tier string over the numeric cap', () => {
    expect(
      parseLimitWebhookValue({
        current_limit: 'TIER_100K',
        max_daily_conversation_per_phone: 1000,
      }),
    ).toMatchObject({ tier: 'TIER_100K' });
  });

  it('reads a quality rating from any of the three key spellings', () => {
    expect(
      parseLimitWebhookValue({ current_quality_rating: 'GREEN' }),
    ).toMatchObject({
      qualityRating: 'GREEN',
    });
    expect(parseLimitWebhookValue({ quality_rating: 'yellow' })).toMatchObject({
      qualityRating: 'YELLOW',
    });
    expect(parseLimitWebhookValue({ event: 'RED' })).toMatchObject({
      qualityRating: 'RED',
    });
  });

  it('accepts NA, which is what Meta sends for an unrated number', () => {
    expect(parseLimitWebhookValue({ quality_rating: 'NA' })).toMatchObject({
      qualityRating: 'NA',
    });
  });

  it('ignores FLAGGED / UNFLAGGED events, which are not ratings', () => {
    expect(parseLimitWebhookValue({ event: 'FLAGGED' })).toMatchObject({
      qualityRating: null,
    });
    expect(parseLimitWebhookValue({ event: 'ONBOARDING' })).toMatchObject({
      qualityRating: null,
    });
  });

  it('extracts phone_number_id when the payload carries metadata', () => {
    expect(
      parseLimitWebhookValue({
        current_limit: 'TIER_1K',
        metadata: { phone_number_id: 'pn-9' },
      }),
    ).toMatchObject({ phoneNumberId: 'pn-9' });
  });

  it('returns all-nulls for an empty or malformed payload', () => {
    expect(parseLimitWebhookValue(undefined)).toEqual({
      tier: null,
      qualityRating: null,
      phoneNumberId: null,
    });
    expect(parseLimitWebhookValue({})).toEqual({
      tier: null,
      qualityRating: null,
      phoneNumberId: null,
    });
  });
});
