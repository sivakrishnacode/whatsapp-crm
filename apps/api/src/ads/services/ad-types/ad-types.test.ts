import { afterEach, describe, expect, it } from 'vitest';

import { AD_TYPES, AD_TYPE_ORDER, isAdTypeId } from './index';
import { buildTargeting } from './shared';
import type { AdBuildContext, AdBuildInput } from './types';
import { hashAudienceIdentifier } from '../../marketing-audiences.util';
import { groupGeoResults } from '../../marketing-targeting.util';

/**
 * Read a creative's `link_data` / `video_data` without casting to `any`.
 *
 * `objectStorySpec` is `Record<string, unknown>` because its shape is
 * Meta's and differs per ad type; these helpers narrow at the point of
 * assertion so the tests stay type-checked.
 */
interface CallToAction {
  type?: string;
  value?: Record<string, string>;
}
interface StoryData {
  call_to_action?: CallToAction;
  message?: string;
  name?: string;
}

function storyData(
  spec: Record<string, unknown>,
  key: 'link_data' | 'video_data',
): StoryData {
  return (spec[key] ?? {}) as StoryData;
}

/**
 * Builders are pure, so they are cheap to test — and worth testing more
 * than almost anything else here, because the failure modes are:
 *
 *   * a wrong `destination_type` → the ad opens a web page instead of a
 *     WhatsApp chat, and nobody notices until the leads do not arrive
 *   * a wrong `optimization_goal` → Meta happily spends the budget
 *     bidding for the wrong action
 *   * a missing `promoted_object` → publish fails at the ad-set call,
 *     after the campaign already exists
 */

const CONTEXT: AdBuildContext = {
  adAccountId: '123',
  pageId: 'page_1',
  whatsappPhoneNumberId: 'wa_1',
  whatsappDisplayNumber: '+919876543210',
  pixelId: 'pixel_1',
  currency: 'INR',
  timezoneName: 'Asia/Kolkata',
  instagramActorId: null,
};

function input(overrides: Partial<AdBuildInput> = {}): AdBuildInput {
  return {
    campaignName: 'Test campaign',
    specialAdCategories: [],
    optimizationGoal: 'CONVERSATIONS',
    budget: { mode: 'daily', amountMinor: 50_000 },
    targeting: {
      geoLocations: { countries: ['IN'] },
      ageMin: 18,
      ageMax: 65,
      publisherPlatforms: ['facebook'],
    },
    creative: {
      adName: 'Test ad',
      primaryText: 'Hello',
      imageHash: 'hash_1',
    },
    ...overrides,
  };
}

describe('the registry', () => {
  it('lists every builder under its own id, in card order', () => {
    expect(AD_TYPE_ORDER).toHaveLength(5);
    for (const id of AD_TYPE_ORDER) {
      expect(AD_TYPES[id].id).toBe(id);
    }
  });

  it('recognises only real ad type ids', () => {
    expect(isAdTypeId('click_to_whatsapp')).toBe(true);
    expect(isAdTypeId('carousel')).toBe(false);
    expect(isAdTypeId(undefined)).toBe(false);
  });

  it('gives every type exactly one default performance goal', () => {
    for (const id of AD_TYPE_ORDER) {
      const defaults = AD_TYPES[id].performanceGoals.filter((g) => g.isDefault);
      // Zero means the wizard has nothing to preselect; two means it
      // silently picks whichever comes first.
      expect(defaults).toHaveLength(1);
    }
  });

  it('gives every type at least one call to action', () => {
    for (const id of AD_TYPE_ORDER) {
      expect(AD_TYPES[id].callToActions.length).toBeGreaterThan(0);
    }
  });
});

describe('click_to_whatsapp', () => {
  const builder = AD_TYPES.click_to_whatsapp;

  it('sets the three things that make an ad a CTWA ad', () => {
    const built = builder.build(input(), CONTEXT);

    // 1 — the ad set routes the click into WhatsApp
    expect(built.adSet.destinationType).toBe('WHATSAPP');
    // 2 — the promoted object names the page whose number receives it
    expect(built.adSet.promotedObject).toEqual({ page_id: 'page_1' });
    // 3 — the creative's CTA opens the chat
    const linkData = storyData(built.creative.objectStorySpec, 'link_data');
    expect(linkData.call_to_action?.type).toBe('WHATSAPP_MESSAGE');
    expect(linkData.call_to_action?.value?.app_destination).toBe('WHATSAPP');
  });

  it('uses OUTCOME_ENGAGEMENT, not a conversion objective', () => {
    // A conversion objective would optimise toward a pixel event that a
    // WhatsApp-based business never fires.
    expect(builder.build(input(), CONTEXT).campaign.objective).toBe(
      'OUTCOME_ENGAGEMENT',
    );
  });

  it('is unavailable with a reason when no WhatsApp number is linked', () => {
    const reason = builder.unavailableReason({
      ...CONTEXT,
      whatsappPhoneNumberId: null,
    });
    expect(reason).toMatch(/Link a WhatsApp number/);
    expect(builder.unavailableReason(CONTEXT)).toBeNull();
  });

  it('refuses to build an ad with no media', () => {
    expect(() =>
      builder.build(
        input({ creative: { adName: 'a', primaryText: 'b' } }),
        CONTEXT,
      ),
    ).toThrow(/image or a video/);
  });

  it('builds video_data instead of link_data for a video', () => {
    const built = builder.build(
      input({
        creative: {
          adName: 'a',
          primaryText: 'b',
          videoId: 'vid_1',
          videoThumbnailUrl: 'https://example.com/t.jpg',
        },
      }),
      CONTEXT,
    );
    const spec = built.creative.objectStorySpec;
    expect(spec.video_data).toBeDefined();
    expect(spec.link_data).toBeUndefined();
  });

  it('refuses a video with no thumbnail', () => {
    // Meta rejects the creative, with a generic error, after the campaign
    // and ad set already exist.
    expect(() =>
      builder.build(
        input({
          creative: { adName: 'a', primaryText: 'b', videoId: 'vid_1' },
        }),
        CONTEXT,
      ),
    ).toThrow(/thumbnail/);
  });
});

describe('lead_form', () => {
  const builder = AD_TYPES.lead_form;

  it('opens the form in-place and optimises for leads', () => {
    const built = builder.build(
      input({
        optimizationGoal: 'LEAD_GENERATION',
        creative: {
          adName: 'a',
          primaryText: 'b',
          imageHash: 'h',
          leadFormId: 'form_1',
        },
      }),
      CONTEXT,
    );

    expect(built.campaign.objective).toBe('OUTCOME_LEADS');
    expect(built.adSet.destinationType).toBe('ON_AD');
    const linkData = storyData(built.creative.objectStorySpec, 'link_data');
    expect(linkData.call_to_action?.value?.lead_gen_form_id).toBe('form_1');
  });

  it('refuses to build without a form', () => {
    expect(() =>
      builder.build(input({ optimizationGoal: 'LEAD_GENERATION' }), CONTEXT),
    ).toThrow(/lead form/i);
  });
});

describe('website', () => {
  const builder = AD_TYPES.website;

  it('switches objective to OUTCOME_SALES for a conversion goal', () => {
    // The one builder whose objective is not fixed: OFFSITE_CONVERSIONS
    // under OUTCOME_TRAFFIC is rejected by Meta.
    const traffic = builder.build(
      input({
        optimizationGoal: 'LINK_CLICKS',
        creative: {
          adName: 'a',
          primaryText: 'b',
          imageHash: 'h',
          link: 'https://example.com',
        },
      }),
      CONTEXT,
    );
    expect(traffic.campaign.objective).toBe('OUTCOME_TRAFFIC');
    expect(traffic.adSet.promotedObject).toBeUndefined();

    const conversions = builder.build(
      input({
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        creative: {
          adName: 'a',
          primaryText: 'b',
          imageHash: 'h',
          link: 'https://example.com',
        },
      }),
      CONTEXT,
    );
    expect(conversions.campaign.objective).toBe('OUTCOME_SALES');
    expect(conversions.adSet.promotedObject).toMatchObject({
      pixel_id: 'pixel_1',
    });
  });

  it('demands a pixel for a conversion goal, with an actionable message', () => {
    expect(() =>
      builder.build(
        input({
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          creative: {
            adName: 'a',
            primaryText: 'b',
            imageHash: 'h',
            link: 'https://example.com',
          },
        }),
        { ...CONTEXT, pixelId: null },
      ),
    ).toThrow(/Meta Pixel/);
  });

  it('rejects a missing or malformed link', () => {
    const goal = 'LINK_CLICKS';
    expect(() =>
      builder.build(input({ optimizationGoal: goal }), CONTEXT),
    ).toThrow(/web address/);
    expect(() =>
      builder.build(
        input({
          optimizationGoal: goal,
          creative: {
            adName: 'a',
            primaryText: 'b',
            imageHash: 'h',
            link: 'not a url',
          },
        }),
        CONTEXT,
      ),
    ).toThrow(/not valid|https/);
  });
});

describe('website_to_whatsapp', () => {
  const builder = AD_TYPES.website_to_whatsapp;

  it('does NOT set a WhatsApp destination — the click goes to the site', () => {
    const built = builder.build(
      input({
        optimizationGoal: 'LANDING_PAGE_VIEWS',
        creative: {
          adName: 'a',
          primaryText: 'b',
          imageHash: 'h',
          link: 'https://example.com',
        },
      }),
      CONTEXT,
    );

    // Setting destinationType here would silently turn this into a
    // Click-to-WhatsApp ad and the website would never be seen.
    expect(built.adSet.destinationType).toBeUndefined();
    expect(built.campaign.objective).toBe('OUTCOME_TRAFFIC');
  });
});

describe('whatsapp_status', () => {
  const builder = AD_TYPES.whatsapp_status;
  const original = process.env.ADS_WHATSAPP_STATUS_ENABLED;

  afterEach(() => {
    process.env.ADS_WHATSAPP_STATUS_ENABLED = original;
  });

  it('is unavailable by default, with an honest reason', () => {
    delete process.env.ADS_WHATSAPP_STATUS_ENABLED;
    const reason = builder.unavailableReason(CONTEXT);
    // The placement is unverified — the card must say so rather than
    // letting a user build an ad that fails at publish.
    expect(reason).toMatch(/not enabled|rolled out/i);
  });

  it('becomes available once the flag is on', () => {
    process.env.ADS_WHATSAPP_STATUS_ENABLED = 'true';
    expect(builder.unavailableReason(CONTEXT)).toBeNull();
  });

  it('pins the placement to WhatsApp Status and clears the others', () => {
    process.env.ADS_WHATSAPP_STATUS_ENABLED = 'true';
    const built = builder.build(
      input({
        optimizationGoal: 'REACH',
        targeting: {
          publisherPlatforms: ['facebook', 'instagram'],
          facebookPositions: ['feed'],
          instagramPositions: ['stream'],
        },
      }),
      CONTEXT,
    );

    const targeting = built.adSet.targeting;
    expect(targeting.publisher_platforms).toEqual(['whatsapp']);
    expect(targeting.whatsapp_positions).toEqual(['status']);
    // Leaving these alongside a whatsapp-only platform list is a 400.
    expect(targeting.facebook_positions).toBeUndefined();
    expect(targeting.instagram_positions).toBeUndefined();
  });
});

describe('buildTargeting', () => {
  it('makes a saved audience exclusive of hand-built fields', () => {
    // Meta rejects the combination, with an error naming neither.
    const targeting = buildTargeting({
      savedAudienceId: 'saved_1',
      geoLocations: { countries: ['IN'] },
      ageMin: 25,
      publisherPlatforms: ['facebook'],
    });

    expect(targeting.saved_audience_id).toBe('saved_1');
    expect(targeting.geo_locations).toBeUndefined();
    expect(targeting.age_min).toBeUndefined();
    // Placements are the one thing a saved audience does not cover, so
    // they survive.
    expect(targeting.publisher_platforms).toEqual(['facebook']);
  });

  it('clamps age to 18 even when a lower value is supplied', () => {
    // Defence in depth: the DTO rejects <18, and a crafted payload that
    // bypassed it still cannot target minors.
    expect(buildTargeting({ ageMin: 13 }).age_min).toBe(18);
  });

  it('omits positions for a platform that was not selected', () => {
    const targeting = buildTargeting({
      publisherPlatforms: ['facebook'],
      facebookPositions: ['feed'],
      instagramPositions: ['stream'],
    });
    expect(targeting.facebook_positions).toEqual(['feed']);
    // Sending IG positions without `instagram` in the platform list is a 400.
    expect(targeting.instagram_positions).toBeUndefined();
  });

  it('omits an empty gender list rather than sending []', () => {
    expect(buildTargeting({ genders: [] }).genders).toBeUndefined();
    expect(buildTargeting({ genders: [1] }).genders).toEqual([1]);
  });

  it('always states the advantage_audience setting explicitly', () => {
    expect(buildTargeting({}).targeting_automation).toEqual({
      advantage_audience: 0,
    });
    expect(
      buildTargeting({ audienceExpansion: true }).targeting_automation,
    ).toEqual({ advantage_audience: 1 });
  });
});

describe('groupGeoResults', () => {
  it('shapes each location type the way Meta wants it', () => {
    // The inconsistency this exists for: countries are bare strings,
    // everything else is { key }.
    const grouped = groupGeoResults([
      { key: 'IN', type: 'country' },
      { key: '3159', type: 'region' },
      { key: '2696', type: 'city' },
      { key: '560001', type: 'zip' },
    ]);

    expect(grouped.countries).toEqual(['IN']);
    expect(grouped.regions).toEqual([{ key: '3159' }]);
    expect(grouped.cities).toEqual([
      { key: '2696', radius: 25, distance_unit: 'kilometer' },
    ]);
    expect(grouped.zips).toEqual([{ key: '560001' }]);
  });

  it('honours a custom city radius', () => {
    const grouped = groupGeoResults([
      { key: '2696', type: 'city', radius: 10 },
    ]);
    expect((grouped.cities as Array<{ radius: number }>)[0].radius).toBe(10);
  });

  it('omits empty groups entirely', () => {
    const grouped = groupGeoResults([{ key: 'IN', type: 'country' }]);
    expect(Object.keys(grouped)).toEqual(['countries']);
  });
});

describe('hashAudienceIdentifier', () => {
  it('normalises a phone number to digits before hashing', () => {
    // Meta matches on the hash, so "+91 98765 43210" and "919876543210"
    // must produce the same one or the audience matches nobody.
    const a = hashAudienceIdentifier('PHONE', '+91 98765 43210');
    const b = hashAudienceIdentifier('PHONE', '919876543210');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('lowercases and trims an email before hashing', () => {
    expect(hashAudienceIdentifier('EMAIL', '  Person@Example.COM ')).toBe(
      hashAudienceIdentifier('EMAIL', 'person@example.com'),
    );
  });

  it('never returns a hash of an unusable identifier', () => {
    // Hashing an empty string would produce a valid-looking hash that
    // matches nobody, and inflate the "uploaded" count.
    expect(hashAudienceIdentifier('PHONE', '')).toBeNull();
    expect(hashAudienceIdentifier('PHONE', '12345')).toBeNull();
    expect(hashAudienceIdentifier('EMAIL', 'not-an-email')).toBeNull();
    expect(hashAudienceIdentifier('EMAIL', '')).toBeNull();
  });

  it('never returns the raw identifier', () => {
    const raw = '919876543210';
    const hashed = hashAudienceIdentifier('PHONE', raw);
    expect(hashed).not.toContain(raw);
  });
});
