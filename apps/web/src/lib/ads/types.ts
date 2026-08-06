/**
 * Wire types for the Ads Manager, mirroring the API's own interfaces.
 *
 * Hand-mirrored rather than generated because the API and the web app
 * are separate builds with no shared package for DTOs — the same
 * arrangement every other surface here uses (`WebStatus` in
 * web-config.tsx, `InstagramConnectionStatus`). Keep in sync with
 * apps/api/src/ads/services/ads-config.service.ts.
 *
 * Money is MINOR UNITS of `adAccount.currency` everywhere, matching the
 * database and the Marketing API. Nothing in this app should divide by
 * 100 except at the moment of display — see `formatMinor`.
 */

/** One row of the Setup checklist. */
export interface AdsSetupStep {
  id: string;
  label: string;
  done: boolean;
  /** Why this step cannot be completed yet, when it can't. */
  blocked: string | null;
}

export interface AdsSetupStatus {
  sandbox: boolean;
  connected: boolean;
  status: 'disconnected' | 'pending_setup' | 'connected' | 'error';
  fbUserName: string | null;
  /** Permissions we asked for and Meta did not grant. */
  missingScopes: string[];
  tokenExpiresAt: string | null;
  business: { id: string; name: string | null } | null;
  adAccount: {
    id: string;
    name: string | null;
    currency: string | null;
    timezoneName: string | null;
    /** Meta's numeric status. 1 = ACTIVE. */
    accountStatus: number | null;
    /** False when the account has no usable payment method. */
    fundingOk: boolean;
  } | null;
  page: { id: string; name: string | null } | null;
  whatsapp: { phoneNumberId: string; displayNumber: string | null } | null;
  pixel: { id: string; name: string | null } | null;
  leadTermsAcceptedAt: string | null;
  steps: AdsSetupStep[];
  /** Every hard requirement for publishing is satisfied. */
  canPublish: boolean;
  maxDailyBudgetMinor: number;
}

export interface AdsBusiness {
  id: string;
  name: string;
}

export interface AdsAdAccount {
  id: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  accountStatus: number | null;
  fundingOk: boolean;
  disableReason: number | null;
}

export interface AdsPage {
  id: string;
  name: string;
  tasks: string[];
  instagramActorId: string | null;
  /** The page grants this user the ADVERTISE task. */
  canAdvertise: boolean;
}

export interface AdsPixel {
  id: string;
  name: string;
  lastFiredAt: string | null;
}

// ============================================================
// Read surface (M2)
// ============================================================

/** The five ad types the wizard offers. Mirrors the CHECK in migration 068. */
export type AdType =
  | 'click_to_whatsapp'
  | 'whatsapp_status'
  | 'website_to_whatsapp'
  | 'website'
  | 'lead_form';

/**
 * Human labels, and what each type's "results" column actually counts.
 *
 * The result label is per-type on purpose: "9 results" is meaningless,
 * "9 conversations" and "9 leads" are not. The API decides which action
 * type to count (`RESULT_ACTION_TYPES`); this decides what to call it.
 */
export const AD_TYPE_META: Record<
  AdType,
  { label: string; resultLabel: string; resultLabelSingular: string }
> = {
  click_to_whatsapp: {
    label: 'Click to WhatsApp',
    resultLabel: 'Conversations',
    resultLabelSingular: 'conversation',
  },
  whatsapp_status: {
    label: 'WhatsApp Status',
    resultLabel: 'Clicks',
    resultLabelSingular: 'click',
  },
  website_to_whatsapp: {
    label: 'Website to WhatsApp',
    resultLabel: 'Visits',
    resultLabelSingular: 'visit',
  },
  website: {
    label: 'Website',
    resultLabel: 'Conversions',
    resultLabelSingular: 'conversion',
  },
  lead_form: {
    label: 'Lead Form',
    resultLabel: 'Leads',
    resultLabelSingular: 'lead',
  },
};

export function adTypeLabel(adType: string): string {
  return AD_TYPE_META[adType as AdType]?.label ?? adType;
}

export function resultLabel(adType: string): string {
  return AD_TYPE_META[adType as AdType]?.resultLabel ?? 'Results';
}

export interface AdsTotals {
  /** Minor units. */
  spend: number;
  impressions: number;
  /** Sum of daily reach — see the note in ads-insights.service.ts. */
  reach: number;
  clicks: number;
  results: number;
  /** Percent, e.g. 1.42 for 1.42%. */
  ctr: number | null;
  /** Minor units. */
  cpc: number | null;
  cpm: number | null;
  costPerResult: number | null;
}

export interface AdsTimeseriesPoint {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
}

export interface AdsCampaignRow {
  id: string;
  metaCampaignId: string;
  name: string;
  adType: string;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  adCount: number;
  totals: AdsTotals;
}

export interface AdsOverview {
  currency: string | null;
  range: { since: string; until: string };
  totals: AdsTotals;
  timeseries: AdsTimeseriesPoint[];
  campaigns: AdsCampaignRow[];
  lastSyncedAt: string | null;
}

export interface AdsAdRow {
  id: string;
  metaAdId: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  adsetName: string;
  previewUrl: string | null;
  totals: AdsTotals;
}

/**
 * Is this object actually delivering?
 *
 * Reads `effective_status` (Meta's computed state), never `status` (what
 * we asked for). A campaign can be ACTIVE while its ad is in review or
 * its ad set is paused, and telling the user their ad is live when it
 * is not is the single most misleading thing this screen could do.
 */
export function isDelivering(effectiveStatus: string | null): boolean {
  return effectiveStatus === 'ACTIVE';
}

/**
 * `effective_status` → a short human label.
 *
 * Meta's vocabulary is wide and mostly self-explanatory in SCREAMING_CASE;
 * the ones worth translating are those a user would otherwise misread.
 */
export function statusLabel(
  effectiveStatus: string | null,
  status: string | null,
): string {
  const value = effectiveStatus ?? status;
  if (!value) return 'Unknown';
  const map: Record<string, string> = {
    ACTIVE: 'Active',
    PAUSED: 'Paused',
    CAMPAIGN_PAUSED: 'Campaign paused',
    ADSET_PAUSED: 'Ad set paused',
    IN_PROCESS: 'In review',
    PENDING_REVIEW: 'In review',
    PENDING_BILLING_INFO: 'Needs payment method',
    DISAPPROVED: 'Rejected by Meta',
    WITH_ISSUES: 'Has issues',
    ARCHIVED: 'Archived',
    DELETED: 'Deleted',
  };
  return (
    map[value] ??
    value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
  );
}

/** Percent → display string. Null-safe, and never shows "0.00%" for no data. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

/** Plain integer with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

// ============================================================
// Wizard (M3)
// ============================================================

export interface PerformanceGoal {
  value: string;
  label: string;
  description: string;
  isDefault?: boolean;
}

export interface AdTypeInfo {
  id: AdType;
  label: string;
  description: string;
  objective: string;
  performanceGoals: PerformanceGoal[];
  callToActions: Array<{ value: string; label: string }>;
  needsLink: boolean;
  needsWhatsApp: boolean;
  needsLeadForm: boolean;
  needsPixel: boolean;
  /** Non-null means the card is disabled, and this is why. */
  unavailableReason: string | null;
}

export interface AdTypeCatalogue {
  specialAdCategories: string[];
  adTypes: AdTypeInfo[];
  /** Meta standard events a conversion-optimised website ad can bid for. */
  pixelEvents: Array<{ value: string; label: string }>;
  /** Whether this workspace has selected a pixel in Setup. */
  pixelSelected: boolean;
}

export type GeoType = 'country' | 'region' | 'city' | 'zip';

export interface GeoResult {
  key: string;
  name: string;
  type: GeoType;
  context: string | null;
  countryCode: string | null;
}

export interface TargetingCategory {
  id: string;
  name: string;
  category: 'interests' | 'behaviors' | 'demographics';
  audienceSize: number | null;
  path: string[];
  description: string | null;
}

export interface ReachEstimate {
  lowerBound: number | null;
  upperBound: number | null;
  unavailableReason: string | null;
}

export interface AdMediaItem {
  id: string;
  kind: string;
  imageHash: string | null;
  videoId: string | null;
  name: string | null;
  url: string | null;
}

export interface MetaLeadFormSummary {
  id: string;
  name: string;
  status: string | null;
  questions: Array<{ key: string; type: string; label: string | null }>;
  privacyPolicyUrl: string | null;
  leadsCount: number;
}

export interface AdAudience {
  id: string;
  name: string;
  subtype: string | null;
  approximateCount: number | null;
  deliveryStatus: string | null;
  sourceAudienceId: string | null;
  description: string | null;
}

/**
 * Facebook and Instagram placements, as the reference product lists them
 * (11 and 8 respectively).
 *
 * Hardcoded with a caveat: Meta's position vocabulary changes, and there
 * is no stable public endpoint that enumerates it. So this is a
 * best-effort list, and an unknown value from Meta is simply not offered
 * rather than breaking the form. The API does not validate against this
 * list — it length-checks the strings and lets Meta reject an unknown
 * position, which is the only authority that actually knows.
 */
export const FACEBOOK_POSITIONS = [
  { value: 'feed', label: 'Feed' },
  { value: 'right_hand_column', label: 'Right column' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'video_feeds', label: 'Video feeds' },
  { value: 'story', label: 'Stories' },
  { value: 'search', label: 'Search' },
  { value: 'instream_video', label: 'In-stream video' },
  { value: 'facebook_reels', label: 'Reels' },
  { value: 'facebook_reels_overlay', label: 'Reels overlay' },
  { value: 'profile_feed', label: 'Profile feed' },
  { value: 'notification', label: 'Notification' },
] as const;

export const INSTAGRAM_POSITIONS = [
  { value: 'stream', label: 'Feed' },
  { value: 'story', label: 'Stories' },
  { value: 'explore', label: 'Explore' },
  { value: 'explore_home', label: 'Explore home' },
  { value: 'reels', label: 'Reels' },
  { value: 'profile_feed', label: 'Profile feed' },
  { value: 'ig_search', label: 'Search' },
  { value: 'profile_reels', label: 'Profile reels' },
] as const;

/** Meta's special ad categories, with the plain-words version. */
export const SPECIAL_AD_CATEGORY_LABELS: Record<string, string> = {
  HOUSING: 'Housing',
  CREDIT: 'Credit',
  EMPLOYMENT: 'Employment',
  ISSUES_ELECTIONS_POLITICS: 'Social issues, elections or politics',
  ONLINE_GAMBLING_AND_GAMING: 'Online gambling and gaming',
  FINANCIAL_PRODUCTS_SERVICES: 'Financial products and services',
};

/** Compact audience-size display: 1_900_000 → "1.9M". */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

/**
 * Major-unit input → minor units.
 *
 * The ONE place the wizard converts, and it rounds rather than truncating:
 * `parseFloat('12.34') * 100` is 1233.9999999999998, and `Math.trunc`
 * would bill ₹12.33 for an ad the user set to ₹12.34.
 */
export function toMinorUnits(major: string | number): number {
  const n = typeof major === 'number' ? major : Number(major);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** Minor units → the value a number input should show. */
export function fromMinorUnits(minor: number): string {
  return (minor / 100).toString();
}

/**
 * Minor units → a display string.
 *
 * Uses the AD ACCOUNT's currency, not a workspace setting and not the
 * browser's guess: the ad account's currency is fixed by Meta and is
 * what the customer is actually billed in. Falls back to a bare number
 * rather than assuming a currency, because labelling ₹ as $ is worse
 * than labelling nothing.
 */
export function formatMinor(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined) return '—';
  const major = minor / 100;
  if (!currency) {
    return major.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  try {
    return major.toLocaleString(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    // An unknown ISO code would throw; show the code beside the number.
    return `${major.toLocaleString()} ${currency}`;
  }
}
