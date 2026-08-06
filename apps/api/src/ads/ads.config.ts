/**
 * Ads Manager configuration and feature flags.
 *
 * Read lazily through functions rather than captured as module-level
 * constants: this module is part of Nest's synchronous graph, which is
 * built before `ConfigModule.forRoot()` loads `.env`. A top-level
 * `process.env.X` here would permanently capture `undefined` — the same
 * trap documented in common/security/encryption.util.ts.
 */

/**
 * Master switch. Off (the default) → every `/ads/*` route 404s.
 *
 * Off by default because the surface cannot work until the Meta app has
 * App Review approval for `ads_management`, and a half-connected ads
 * screen on a paying customer's dashboard is worse than no screen.
 */
export function adsEnabled(): boolean {
  return process.env.ADS_MANAGER_ENABLED === 'true';
}

/**
 * Serve fixtures instead of calling Meta.
 *
 * Mirrors the `isDemo` path already in
 * integrations/controllers/facebook.controller.ts. Exists so the whole
 * flow — connect, pick assets, list campaigns, read insights — is
 * walkable before App Review, which is what the review screencast
 * itself needs.
 */
export function adsSandbox(): boolean {
  return process.env.ADS_MANAGER_SANDBOX === 'true';
}

/**
 * App credentials.
 *
 * Falls back to the existing `META_APP_*` pair on purpose: the customer
 * has already granted that app Pages and WhatsApp access, so adding ads
 * scopes is an incremental permission request rather than a second full
 * login. Setting `META_ADS_APP_*` splits ads onto its own app if that
 * is ever wanted — see docs/meta-ads-manager-requirements.md §1.1.
 */
export function adsAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.META_ADS_APP_ID ?? process.env.META_APP_ID;
  const appSecret =
    process.env.META_ADS_APP_SECRET ?? process.env.META_APP_SECRET;

  const missing = [
    !appId && 'META_ADS_APP_ID (or META_APP_ID)',
    !appSecret && 'META_ADS_APP_SECRET (or META_APP_SECRET)',
  ].filter(Boolean);

  if (missing.length) {
    // Named specifically because Meta's error for a wrong/absent app id
    // is unhelpful, and the fallback makes "which var did I forget"
    // genuinely ambiguous.
    throw new Error(
      `Meta Ads Manager is not configured on this server. Missing: ${missing.join(
        ', ',
      )}. These come from Meta → your app → App Settings → Basic.`,
    );
  }

  return { appId: appId!, appSecret: appSecret! };
}

/** Where Meta sends the browser back after consent. Must match the dashboard exactly. */
export function adsRedirectUri(): string | null {
  return process.env.META_ADS_REDIRECT_URI ?? null;
}

/**
 * The scopes we ask for.
 *
 * `granted_scopes` on `meta_ads_config` records what Meta actually gave
 * us, because the consent dialog lets a user decline individual
 * permissions while still returning a token — see `debugToken`.
 */
export const ADS_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_ads',
  'leads_retrieval',
] as const;

/** Scopes without which the surface cannot function at all. */
export const ADS_REQUIRED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
] as const;

/**
 * WhatsApp Status ads — off by default, and deliberately its own flag
 * rather than riding on `ADS_MANAGER_ENABLED`.
 *
 * The `whatsapp_positions: ['status']` placement is new, market-gated,
 * has no example in Meta's Postman collection, and we have not confirmed
 * it against a real ad account. Every other ad type can ship without
 * this one, so it gets a switch of its own: the card renders disabled
 * with a reason until someone verifies the placement exists for the
 * target ad accounts (docs/meta-ads-manager-requirements.md §4).
 */
export function whatsappStatusAdsEnabled(): boolean {
  return process.env.ADS_WHATSAPP_STATUS_ENABLED === 'true';
}

/**
 * Server-side daily-budget ceiling, in MINOR units of the ad account's
 * currency (1_000_000 = ₹10,000/day).
 *
 * A backstop, not a product limit. Budgets travel as minor units all
 * the way from the wizard to Graph, so a single missed conversion is a
 * 100× overspend on a real customer's card. The UI validates, the DTO
 * validates, and this catches whatever gets past both.
 */
export function adsMaxDailyBudgetMinor(): number {
  const raw = Number(process.env.ADS_MAX_DAILY_BUDGET_MINOR);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
}
