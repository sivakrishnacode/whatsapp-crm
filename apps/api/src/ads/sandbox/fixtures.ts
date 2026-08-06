/**
 * Sandbox fixtures — what the Ads Manager serves when
 * `ADS_MANAGER_SANDBOX=true`.
 *
 * WHY THIS EXISTS
 *   `ads_management` needs App Review, and App Review needs a
 *   screencast of the feature working. Without fixtures that is a
 *   deadlock. This is the same escape hatch the Facebook lead-ads
 *   integration already has (`isDemo` in
 *   integrations/controllers/facebook.controller.ts), generalised.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT
 *   It proves OUR code paths: the connect state machine, the setup
 *   checklist's completion logic, tenant scoping, the UI. It proves
 *   nothing about Meta's parameter validation, which is where the real
 *   surprises live — so a sandbox pass is not a green light, it is a
 *   precondition for testing against a real ad account.
 *
 * IDS ARE OBVIOUSLY FAKE ON PURPOSE
 *   Every id is prefixed `sandbox_`. A fixture id must never be
 *   mistakable for a real Meta id in a log, a bug report, or a database
 *   row someone finds in six months — and the prefix is also what lets
 *   the write paths refuse to call Graph with one.
 */

import type {
  MetaAdAccount,
  MetaBusiness,
  MetaPage,
  MetaPixel,
  MetaUserProfile,
} from '../marketing-api.util';
import type {
  MetaAd,
  MetaAdSet,
  MetaCampaign,
} from '../marketing-objects.util';
import type { MetaInsightRow } from '../marketing-insights.util';

export const SANDBOX_PREFIX = 'sandbox_';

/** True for any id this module minted. Write paths must never send one to Meta. */
export function isSandboxId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(SANDBOX_PREFIX));
}

export const SANDBOX_PROFILE: MetaUserProfile = {
  id: `${SANDBOX_PREFIX}fb_user`,
  name: 'Sandbox Advertiser',
};

export const SANDBOX_BUSINESSES: MetaBusiness[] = [
  { id: `${SANDBOX_PREFIX}biz_1`, name: 'Acme Retail (Sandbox)' },
];

export const SANDBOX_AD_ACCOUNTS: MetaAdAccount[] = [
  {
    id: `${SANDBOX_PREFIX}act_1`,
    name: 'Acme Retail — Primary (Sandbox)',
    currency: 'INR',
    timezoneName: 'Asia/Kolkata',
    accountStatus: 1,
    fundingOk: true,
    disableReason: null,
  },
  {
    // Deliberately unfundable, so the "this account cannot spend" branch
    // of the Setup screen is reachable in sandbox. That branch replaces
    // the reference product's ad-credit warning and would otherwise
    // never be seen before production.
    id: `${SANDBOX_PREFIX}act_2`,
    name: 'Acme Retail — No Payment Method (Sandbox)',
    currency: 'INR',
    timezoneName: 'Asia/Kolkata',
    accountStatus: 2,
    fundingOk: false,
    disableReason: 1,
  },
];

export const SANDBOX_PAGES: MetaPage[] = [
  {
    id: `${SANDBOX_PREFIX}page_1`,
    name: 'Acme Retail (Sandbox)',
    accessToken: `${SANDBOX_PREFIX}page_token_1`,
    tasks: ['ADVERTISE', 'MANAGE', 'CREATE_CONTENT'],
    instagramActorId: `${SANDBOX_PREFIX}ig_1`,
  },
  {
    // No ADVERTISE task — the Setup screen must refuse to select this
    // one, and that rule needs a fixture to be testable.
    id: `${SANDBOX_PREFIX}page_2`,
    name: 'Acme Careers (Sandbox, no ad rights)',
    accessToken: `${SANDBOX_PREFIX}page_token_2`,
    tasks: ['CREATE_CONTENT'],
    instagramActorId: null,
  },
];

export const SANDBOX_PIXELS: MetaPixel[] = [
  {
    id: `${SANDBOX_PREFIX}pixel_1`,
    name: 'Acme Site Pixel (Sandbox)',
    lastFiredAt: null,
  },
];

/** Everything Meta grants us in sandbox — i.e. assume App Review passed. */
export const SANDBOX_GRANTED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_ads',
  'leads_retrieval',
];

// ============================================================
// Objects — two campaigns, so the Overview list has something with
// structure: one delivering Click-to-WhatsApp ad and one paused lead
// form ad. Enough to exercise grouping, status badges and the
// per-ad-type result labels without pretending to be a real account.
// ============================================================

export const SANDBOX_CAMPAIGNS: MetaCampaign[] = [
  {
    id: `${SANDBOX_PREFIX}camp_1`,
    name: 'Monsoon Sale — Click to WhatsApp',
    objective: 'OUTCOME_ENGAGEMENT',
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    buyingType: 'AUCTION',
    dailyBudget: null,
    lifetimeBudget: null,
    specialAdCategories: [],
    startTime: new Date('2026-07-20T00:00:00Z'),
    stopTime: null,
  },
  {
    id: `${SANDBOX_PREFIX}camp_2`,
    name: 'Demo Requests — Lead Form',
    objective: 'OUTCOME_LEADS',
    status: 'PAUSED',
    effectiveStatus: 'PAUSED',
    buyingType: 'AUCTION',
    dailyBudget: null,
    lifetimeBudget: null,
    specialAdCategories: [],
    startTime: new Date('2026-07-01T00:00:00Z'),
    stopTime: new Date('2026-07-31T00:00:00Z'),
  },
];

export const SANDBOX_ADSETS: MetaAdSet[] = [
  {
    id: `${SANDBOX_PREFIX}adset_1`,
    campaignId: `${SANDBOX_PREFIX}camp_1`,
    name: 'India · 18-45 · Feed + Reels',
    optimizationGoal: 'CONVERSATIONS',
    billingEvent: 'IMPRESSIONS',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    bidAmount: null,
    // ₹500/day in minor units. Written as the product to make the unit
    // unmistakable — a bare 50000 next to a "spend" of 12345 is exactly
    // the ambiguity that causes 100× bugs.
    dailyBudget: 500 * 100,
    lifetimeBudget: null,
    destinationType: 'WHATSAPP',
    targeting: {
      geo_locations: { countries: ['IN'] },
      age_min: 18,
      age_max: 45,
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed', 'reels'],
      instagram_positions: ['stream', 'reels'],
    },
    promotedObject: { page_id: `${SANDBOX_PREFIX}page_1` },
    adsetSchedule: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
  },
  {
    id: `${SANDBOX_PREFIX}adset_2`,
    campaignId: `${SANDBOX_PREFIX}camp_2`,
    name: 'Lookalike · Metro cities',
    optimizationGoal: 'LEAD_GENERATION',
    billingEvent: 'IMPRESSIONS',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    bidAmount: null,
    dailyBudget: 250 * 100,
    lifetimeBudget: null,
    destinationType: 'ON_AD',
    targeting: {
      geo_locations: { countries: ['IN'] },
      age_min: 25,
      age_max: 55,
      publisher_platforms: ['facebook'],
    },
    promotedObject: { page_id: `${SANDBOX_PREFIX}page_1` },
    adsetSchedule: null,
    status: 'PAUSED',
    effectiveStatus: 'CAMPAIGN_PAUSED',
  },
];

export const SANDBOX_ADS: MetaAd[] = [
  {
    id: `${SANDBOX_PREFIX}ad_1`,
    adsetId: `${SANDBOX_PREFIX}adset_1`,
    name: 'Monsoon Sale — square image',
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    creativeId: `${SANDBOX_PREFIX}creative_1`,
    creative: {
      page_id: `${SANDBOX_PREFIX}page_1`,
      link_data: {
        message: 'Monsoon sale is live. Message us for today’s price list.',
        name: 'Up to 40% off',
        call_to_action: {
          type: 'WHATSAPP_MESSAGE',
          value: { app_destination: 'WHATSAPP' },
        },
      },
    },
    thumbnailUrl: null,
  },
  {
    id: `${SANDBOX_PREFIX}ad_2`,
    adsetId: `${SANDBOX_PREFIX}adset_2`,
    name: 'Demo request — lead form',
    status: 'PAUSED',
    effectiveStatus: 'CAMPAIGN_PAUSED',
    creativeId: `${SANDBOX_PREFIX}creative_2`,
    creative: {
      page_id: `${SANDBOX_PREFIX}page_1`,
      link_data: {
        message: 'See it in action. Book a 20-minute demo.',
        name: 'Book a demo',
        call_to_action: {
          type: 'SIGN_UP',
          value: { lead_gen_form_id: `${SANDBOX_PREFIX}form_1` },
        },
      },
    },
    thumbnailUrl: null,
  },
];

export const SANDBOX_LEAD_FORMS = [
  {
    id: `${SANDBOX_PREFIX}form_1`,
    name: 'Demo request (Sandbox)',
    status: 'ACTIVE',
    questions: [
      { key: 'full_name', type: 'FULL_NAME', label: 'Full name' },
      { key: 'phone_number', type: 'PHONE', label: 'Phone number' },
      { key: 'email', type: 'EMAIL', label: 'Email' },
    ],
    privacyPolicyUrl: 'https://example.com/privacy',
    leadsCount: 12,
  },
];

export const SANDBOX_AUDIENCES = [
  {
    id: `${SANDBOX_PREFIX}aud_1`,
    name: 'All customers (from CRM)',
    subtype: 'CUSTOM',
    approximateCount: 4200,
    deliveryStatus: 'ready',
    sourceAudienceId: null,
  },
  {
    id: `${SANDBOX_PREFIX}aud_2`,
    name: 'Lookalike 1% — All customers',
    subtype: 'LOOKALIKE',
    approximateCount: 1900000,
    deliveryStatus: 'ready',
    sourceAudienceId: `${SANDBOX_PREFIX}aud_1`,
  },
];

/**
 * Deterministic daily insight rows for the sandbox.
 *
 * Deterministic, NOT random: a dashboard whose numbers change on every
 * reload is impossible to eyeball for correctness, and a test that
 * asserts on them would be flaky. The values come from a fixed sequence
 * seeded by the day offset, so a given day always reports the same spend.
 *
 * The spend figures are already MINOR units here, because these bypass
 * `parseSpendMinor` — the fixture stands in for the *parsed* result, not
 * for Meta's major-unit wire format.
 */
export function sandboxInsightRows(
  level: 'account' | 'campaign' | 'adset' | 'ad',
  days: number,
): MetaInsightRow[] {
  const objectIds =
    level === 'campaign'
      ? SANDBOX_CAMPAIGNS.map((c) => c.id)
      : level === 'adset'
        ? SANDBOX_ADSETS.map((a) => a.id)
        : level === 'ad'
          ? SANDBOX_ADS.map((a) => a.id)
          : [`${SANDBOX_PREFIX}act_1`];

  const rows: MetaInsightRow[] = [];
  const today = new Date();

  for (let offset = 0; offset < days; offset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateStart = date.toISOString().slice(0, 10);

    objectIds.forEach((objectId, index) => {
      // A gentle sawtooth so the chart has shape. Second object spends
      // less, and the paused one earns nothing after its stop date.
      const base = index === 0 ? 42000 : 9000;
      const wobble = ((offset * 7 + index * 13) % 11) * 800;
      const spend = index === 1 && offset < 3 ? 0 : base + wobble;
      const impressions = spend * 4;
      const clicks = Math.round(spend / 900);
      const results = Math.round(clicks / 3);

      rows.push({
        level,
        objectId,
        dateStart,
        spend,
        impressions,
        reach: Math.round(impressions * 0.72),
        clicks,
        ctr: impressions ? (clicks / impressions) * 100 : 0,
        cpc: clicks ? Math.round(spend / clicks) : null,
        cpm: impressions ? Math.round((spend / impressions) * 1000) : null,
        frequency: 1.38,
        actions: [
          { action_type: 'link_click', value: String(clicks) },
          {
            action_type:
              index === 1
                ? 'lead'
                : 'onsite_conversion.messaging_conversation_started_7d',
            value: String(results),
          },
        ],
        actionValues: null,
      });
    });
  }

  return rows;
}
