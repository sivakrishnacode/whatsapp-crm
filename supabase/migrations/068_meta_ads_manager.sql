-- ============================================================
-- 068_meta_ads_manager.sql — Meta Ads Manager.
--
-- WHAT THIS IS
--   Tables behind a new primary-rail surface that connects a
--   customer's own Meta ad account (Marketing API) and lets them
--   create and monitor ads: Click-to-WhatsApp, WhatsApp Status,
--   Website→WhatsApp, Website, and Lead Form ads.
--   Plan: docs/meta-ads-manager.md
--
-- THE CUSTOMER'S AD ACCOUNT, NOT OURS
--   There is deliberately NO wallet, no ad-credit ledger and no
--   payments table here. Ads run on the customer's own ad account with
--   their own funding source; Meta bills them directly and no money
--   passes through us. What replaces a credit balance is
--   meta_ads_config.account_status / funding_ok, read from Meta at
--   connect time — a publish is blocked when the ad account cannot
--   spend. If reselling ad credit is ever revisited, it is a new
--   migration and a new surface, not a column here.
--
-- WHY A LOCAL MIRROR OF META'S OBJECTS
--   Every campaign / ad set / ad / insight row here also exists in
--   Meta. We mirror rather than proxy for three reasons:
--     * ad_type. Meta has no field for "this is a Click-to-WhatsApp
--       ad" — that concept is a *combination* of objective,
--       destination_type, promoted_object and creative CTA. Without
--       storing our own discriminator we could not render the list, or
--       re-open a draft in the right wizard.
--     * Joins. "spend → conversations → deals" needs insights next to
--       ctwa_clicks and deals in one query. Impossible across an HTTP
--       boundary.
--     * Rate limits. Marketing API limits are per ad account and
--       shared by every user in the workspace; a dashboard that hit
--       Graph on every page load would throttle the account for the
--       automation paths too.
--   Meta stays authoritative: sync reconciles effective_status, so an
--   ad paused in Meta's own Ads Manager does not read as active here.
--
-- MONEY IS STORED IN MINOR UNITS
--   Every budget/bid/spend column is BIGINT minor units of the ad
--   account's currency (₹500 → 50000), which is what the Marketing API
--   itself takes and returns. No DECIMAL anywhere: a float rupee that
--   round-trips through a JSON body and back is exactly how a 100×
--   overspend happens. The currency lives next to the number.
--
-- TENANT SCOPING
--   Every table is account_id-scoped with RLS. Note this protects the
--   browser only: apps/api connects as the database owner and Prisma
--   bypasses RLS entirely, so the ads services must scope by
--   account_id themselves — and here the cost of forgetting is not a
--   data leak, it is spending another tenant's money.
--
-- WRITES ARE admin+, READS ARE viewer+
--   Stricter than the 'agent' default used for funnels/automations.
--   Connecting an ad account authorises spending, and publishing an ad
--   spends. Insights are readable by anyone in the workspace.
-- ============================================================


-- ============================================================
-- 1) meta_ads_config — one connected ad account per workspace
--
-- Shaped like whatsapp_config / instagram_config: account_id UNIQUE,
-- encrypted token, status. Deliberately NOT an extension of
-- facebook_connections, which is user_id-scoped and stores its token
-- in plaintext — an ads token can spend money and must be encrypted,
-- and the connection belongs to the workspace rather than to whoever
-- happened to click Connect.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_config (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Who connected it. Kept for the audit trail; the connection
  -- survives this user leaving (hence no ON DELETE CASCADE to a
  -- profile — the workspace still owns the ad account).
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Meta identity -------------------------------------------------
  fb_user_id               TEXT NOT NULL,
  fb_user_name             TEXT,
  -- AES-256-GCM via common/security/encryption.util. Long-lived
  -- (~60 day) user token carrying the ads scopes.
  access_token             TEXT NOT NULL,
  token_expires_at         TIMESTAMPTZ,
  -- What Meta actually granted, which is not what we asked for: a user
  -- can decline individual permissions in the consent dialog. Stored so
  -- a missing scope becomes "reconnect to grant ads_management" instead
  -- of an opaque Graph error three screens later.
  granted_scopes           TEXT[] NOT NULL DEFAULT '{}',

  -- The selected assets ------------------------------------------
  business_id              TEXT,
  business_name            TEXT,
  -- Stored WITHOUT the `act_` prefix. The API needs `act_<id>` in
  -- paths but returns a bare id in some fields and a prefixed one in
  -- others; normalising on the way in means exactly one place ever
  -- has to think about it (see toActPath in marketing-api.util.ts).
  ad_account_id            TEXT,
  ad_account_name          TEXT,
  currency                 TEXT,
  timezone_name            TEXT,
  -- Meta's numeric account_status (1 = ACTIVE). Anything else and the
  -- account cannot deliver ads.
  account_status           INTEGER,
  -- Whether a usable funding source exists. This is the honest
  -- replacement for the reference product's "Ad Credit: ₹0.00" —
  -- we are not the payer, so the only question is whether *they* can pay.
  funding_ok               BOOLEAN NOT NULL DEFAULT FALSE,

  page_id                  TEXT,
  page_name                TEXT,
  -- Encrypted, like the user token. Needed to act on behalf of the
  -- page (lead forms, some creative operations).
  page_access_token        TEXT,

  -- Click-to-WhatsApp destination. Resolved from whatsapp_config
  -- rather than typed by the user, but denormalised here because the
  -- ad set's promoted_object is built from it and must not silently
  -- change under a live ad.
  whatsapp_phone_number_id TEXT,
  whatsapp_display_number  TEXT,

  -- Website Ads optimising for conversions need a pixel.
  pixel_id                 TEXT,
  pixel_name               TEXT,

  -- Lead Form ads cannot be created until the page has accepted Meta's
  -- Lead Ads ToS. Recorded so the Setup checklist can show it done.
  lead_terms_accepted_at   TIMESTAMPTZ,

  status                   TEXT NOT NULL DEFAULT 'disconnected',
  last_error               TEXT,
  connected_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_ads_config_status_chk
    CHECK (status IN ('disconnected', 'pending_setup', 'connected', 'error')),
  -- `act_` must be stripped before insert. A prefixed value here would
  -- build `act_act_123` paths that 400 with a generic error.
  CONSTRAINT meta_ads_config_ad_account_bare_chk
    CHECK (ad_account_id IS NULL OR ad_account_id NOT LIKE 'act\_%')
);

COMMENT ON TABLE meta_ads_config IS
  'One connected Meta ad account per workspace. Tokens are AES-256-GCM encrypted. ad_account_id is stored WITHOUT the act_ prefix. funding_ok/account_status are read from Meta and gate publishing — we are not the payer, so the only money question is whether the customer can pay.';

CREATE INDEX IF NOT EXISTS idx_meta_ads_config_account
  ON meta_ads_config (account_id);
-- Partial: the token-refresh job only cares about rows that have one.
CREATE INDEX IF NOT EXISTS idx_meta_ads_config_token_expires
  ON meta_ads_config (token_expires_at)
  WHERE token_expires_at IS NOT NULL;

ALTER TABLE meta_ads_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_config_select ON meta_ads_config;
CREATE POLICY meta_ads_config_select ON meta_ads_config FOR SELECT
  USING (is_account_member(account_id));

-- admin+, not agent: this row is what authorises spending money.
DROP POLICY IF EXISTS meta_ads_config_write ON meta_ads_config;
CREATE POLICY meta_ads_config_write ON meta_ads_config FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 2) meta_ads_campaigns — the mirror, plus our ad_type
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meta_campaign_id      TEXT NOT NULL UNIQUE,

  -- OUR discriminator, not Meta's. See the header note: the five ad
  -- types the wizard offers are combinations of objective +
  -- destination_type + promoted_object + creative CTA, and nothing in
  -- the Graph response reconstructs which one the user picked.
  ad_type               TEXT NOT NULL,

  name                  TEXT NOT NULL,
  objective             TEXT NOT NULL,
  -- Meta has two: `status` is what we set, `effective_status` is what
  -- Meta computes (a campaign can be ACTIVE while its ad set is
  -- rejected). Both are mirrored; the UI shows effective_status,
  -- because that is the one that answers "is this actually running".
  status                TEXT,
  effective_status      TEXT,
  buying_type           TEXT,

  -- Minor units. See header.
  daily_budget          BIGINT,
  lifetime_budget       BIGINT,

  -- Mandatory on create and legally significant: housing, credit,
  -- employment and social-issue ads have restricted targeting. An
  -- empty array is a real answer ("none of these"), not a default we
  -- may assume, so the wizard asks explicitly.
  special_ad_categories TEXT[] NOT NULL DEFAULT '{}',

  start_time            TIMESTAMPTZ,
  stop_time             TIMESTAMPTZ,

  -- Who published it. Ads spend money; the trail matters.
  created_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  synced_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_ads_campaigns_ad_type_chk
    CHECK (ad_type IN (
      'click_to_whatsapp',
      'whatsapp_status',
      'website_to_whatsapp',
      'website',
      'lead_form'
    ))
);

COMMENT ON COLUMN meta_ads_campaigns.ad_type IS
  'Our own discriminator for the five wizard ad types. Meta has no equivalent field — the type is a combination of objective, destination_type, promoted_object and creative CTA, which cannot be reversed out of a Graph response.';
COMMENT ON COLUMN meta_ads_campaigns.effective_status IS
  'Meta-computed delivery state, as opposed to `status` which is what we set. The UI shows this one: it is what answers "is this actually running".';

CREATE INDEX IF NOT EXISTS idx_meta_ads_campaigns_account_created
  ON meta_ads_campaigns (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ads_campaigns_account_type
  ON meta_ads_campaigns (account_id, ad_type);

ALTER TABLE meta_ads_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_campaigns_select ON meta_ads_campaigns;
CREATE POLICY meta_ads_campaigns_select ON meta_ads_campaigns FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_ads_campaigns_write ON meta_ads_campaigns;
CREATE POLICY meta_ads_campaigns_write ON meta_ads_campaigns FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 3) meta_ads_adsets — budget, schedule, targeting, destination
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_adsets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id       uuid NOT NULL REFERENCES meta_ads_campaigns(id) ON DELETE CASCADE,
  meta_adset_id     TEXT NOT NULL UNIQUE,

  name              TEXT NOT NULL,
  optimization_goal TEXT,
  billing_event     TEXT,
  bid_strategy      TEXT,
  bid_amount        BIGINT,
  daily_budget      BIGINT,
  lifetime_budget   BIGINT,

  -- WHATSAPP for Click-to-WhatsApp, ON_AD for instant lead forms,
  -- NULL/WEBSITE otherwise. This is the field that makes a CTWA ad a
  -- CTWA ad.
  destination_type  TEXT,

  -- The whole targeting spec as Meta returns it: geo_locations,
  -- genders, age_min/max, publisher_platforms, positions,
  -- flexible_spec, custom_audiences, targeting_automation. Kept as
  -- jsonb rather than exploded into columns because it is Meta's
  -- schema, not ours — they add and rename fields (advantage_audience
  -- alone has been renamed twice) and a column per key would need a
  -- migration each time. We only ever read it back to re-open the
  -- wizard or to diff, never to filter on.
  targeting         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { page_id } / { pixel_id, custom_event_type } / etc.
  promoted_object   jsonb,
  -- Day-parting blocks, when a custom schedule is used.
  adset_schedule    jsonb,

  status            TEXT,
  effective_status  TEXT,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN meta_ads_adsets.targeting IS
  'Meta''s targeting spec verbatim. jsonb rather than columns because the schema is theirs and churns (advantage_audience has been renamed twice); we read it to re-open the wizard, never to filter on.';

CREATE INDEX IF NOT EXISTS idx_meta_ads_adsets_campaign
  ON meta_ads_adsets (campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_adsets_account
  ON meta_ads_adsets (account_id);

ALTER TABLE meta_ads_adsets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_adsets_select ON meta_ads_adsets;
CREATE POLICY meta_ads_adsets_select ON meta_ads_adsets FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_ads_adsets_write ON meta_ads_adsets;
CREATE POLICY meta_ads_adsets_write ON meta_ads_adsets FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 4) meta_ads_ads — the ad and its creative
--
-- No separate creatives table: a creative is 1:1 with an ad here
-- because the wizard never reuses one across ads. Storing it as jsonb
-- on the ad keeps the object_story_spec — whose shape differs per ad
-- type — out of a column set that would be mostly NULL.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_ads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  adset_id          uuid NOT NULL REFERENCES meta_ads_adsets(id) ON DELETE CASCADE,
  meta_ad_id        TEXT NOT NULL UNIQUE,
  meta_creative_id  TEXT,

  name              TEXT NOT NULL,
  creative          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT,
  effective_status  TEXT,
  -- Meta's own rendered preview, when we have one. Short-lived URLs,
  -- so treat as a cache and re-fetch rather than trust.
  preview_url       TEXT,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_ads_adset
  ON meta_ads_ads (adset_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_ads_account
  ON meta_ads_ads (account_id);

ALTER TABLE meta_ads_ads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_ads_select ON meta_ads_ads;
CREATE POLICY meta_ads_ads_select ON meta_ads_ads FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_ads_ads_write ON meta_ads_ads;
CREATE POLICY meta_ads_ads_write ON meta_ads_ads FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 5) meta_ads_insights — daily performance, one grain
--
-- Daily rows (time_increment=1) rather than a rollup, because every
-- range the UI offers (today / 7d / 30d / custom) is then a SUM over
-- the same table, and a range that crosses a sync boundary stays
-- correct.
--
-- The trailing week is re-fetched every night, not just yesterday:
-- Meta restates attributed conversions for up to ~28 days, so a row
-- written once is wrong later. Hence the UNIQUE upsert key.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_insights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Which Meta object this row measures. Not an FK: insights arrive
  -- for objects we may not have mirrored yet (an ad created in Meta's
  -- own Ads Manager), and dropping those rows would silently
  -- understate spend.
  level         TEXT NOT NULL,
  object_id     TEXT NOT NULL,

  date_start    DATE NOT NULL,

  -- Minor units, same currency as the ad account.
  spend         BIGINT NOT NULL DEFAULT 0,
  impressions   BIGINT NOT NULL DEFAULT 0,
  reach         BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  -- Ratios Meta computes. Stored rather than derived because Meta's
  -- definitions (unique vs total clicks, attribution windows) do not
  -- match a naive clicks/impressions, and a figure that disagrees with
  -- Meta's own dashboard is worse than no figure.
  ctr           DOUBLE PRECISION,
  cpc           DOUBLE PRECISION,
  cpm           DOUBLE PRECISION,
  frequency     DOUBLE PRECISION,

  -- The `actions` / `action_values` arrays, verbatim. Which action
  -- type is "the result" depends on the objective — for CTWA it is
  -- onsite_conversion.messaging_conversation_started_7d, for a lead
  -- form it is `lead`. Keeping the raw arrays means a new objective
  -- needs no migration.
  actions       jsonb,
  action_values jsonb,

  currency      TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_ads_insights_level_chk
    CHECK (level IN ('account', 'campaign', 'adset', 'ad')),
  CONSTRAINT meta_ads_insights_unique_grain
    UNIQUE (account_id, level, object_id, date_start)
);

COMMENT ON TABLE meta_ads_insights IS
  'Daily-grain ad performance. The trailing ~7 days are re-fetched nightly and upserted on (account_id, level, object_id, date_start) because Meta restates attributed conversions for up to 28 days — a row written once is wrong later.';
COMMENT ON COLUMN meta_ads_insights.object_id IS
  'Meta object id. Deliberately not an FK: insights arrive for objects created outside our wizard, and dropping those rows would understate spend.';

CREATE INDEX IF NOT EXISTS idx_meta_ads_insights_lookup
  ON meta_ads_insights (account_id, level, date_start DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ads_insights_object
  ON meta_ads_insights (object_id, date_start DESC);

ALTER TABLE meta_ads_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_insights_select ON meta_ads_insights;
CREATE POLICY meta_ads_insights_select ON meta_ads_insights FOR SELECT
  USING (is_account_member(account_id));

-- No client write policy at all. Every row comes from the sync job on
-- the server; a browser-writable spend table is a browser-writable
-- invoice.


-- ============================================================
-- 6) meta_ads_media — the creative picker's library
--
-- Meta's /act_<id>/adimages is the durable store (an image_hash never
-- expires); this is a local index so the picker does not page the
-- Graph API every time it opens. Losing a row loses a thumbnail, not
-- an asset.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,

  -- Exactly one of these is set, per the check below.
  meta_image_hash TEXT,
  meta_video_id   TEXT,

  name            TEXT,
  width           INTEGER,
  height          INTEGER,
  permalink_url   TEXT,
  uploaded_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_ads_media_kind_chk CHECK (kind IN ('image', 'video')),
  CONSTRAINT meta_ads_media_identity_chk CHECK (
    (kind = 'image' AND meta_image_hash IS NOT NULL AND meta_video_id IS NULL) OR
    (kind = 'video' AND meta_video_id   IS NOT NULL AND meta_image_hash IS NULL)
  )
);

-- An image_hash is unique per ad account, not globally.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ads_media_image
  ON meta_ads_media (account_id, meta_image_hash)
  WHERE meta_image_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ads_media_video
  ON meta_ads_media (account_id, meta_video_id)
  WHERE meta_video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_ads_media_account_created
  ON meta_ads_media (account_id, created_at DESC);

ALTER TABLE meta_ads_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_media_select ON meta_ads_media;
CREATE POLICY meta_ads_media_select ON meta_ads_media FOR SELECT
  USING (is_account_member(account_id));

-- Uploading a creative is ordinary marketing work, so 'agent' here —
-- unlike the spend-authorising tables above. An asset costs nothing
-- until an ad references it.
DROP POLICY IF EXISTS meta_ads_media_write ON meta_ads_media;
CREATE POLICY meta_ads_media_write ON meta_ads_media FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));


-- ============================================================
-- 7) meta_lead_forms — Meta instant forms
--
-- NOT the same thing as the `forms` table, which is this product's own
-- hosted web-form builder. A Meta instant form is rendered by Facebook
-- inside the ad and its submissions arrive on the existing
-- /webhooks/facebook-leads endpoint. Same word, different system —
-- hence the surface is labelled "Lead Forms" and lives at
-- /ads/lead-forms, not /forms.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_lead_forms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id            TEXT NOT NULL,
  meta_form_id       TEXT NOT NULL UNIQUE,

  name               TEXT NOT NULL,
  status             TEXT,
  -- Meta's question spec. jsonb for the same reason as targeting: the
  -- field-type vocabulary is theirs and grows.
  questions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  privacy_policy_url TEXT,
  thank_you          jsonb,
  leads_count        INTEGER NOT NULL DEFAULT 0,
  synced_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE meta_lead_forms IS
  'Meta instant (lead-gen) forms — rendered by Facebook inside an ad. Unrelated to the `forms` table, which is this product''s own hosted web-form builder. Submissions arrive via /webhooks/facebook-leads.';

CREATE INDEX IF NOT EXISTS idx_meta_lead_forms_account
  ON meta_lead_forms (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_lead_forms_page
  ON meta_lead_forms (page_id);

ALTER TABLE meta_lead_forms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_lead_forms_select ON meta_lead_forms;
CREATE POLICY meta_lead_forms_select ON meta_lead_forms FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_lead_forms_write ON meta_lead_forms;
CREATE POLICY meta_lead_forms_write ON meta_lead_forms FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 8) meta_ad_audiences — custom / lookalike / saved
--
-- `origin` is the reference product's two tabs: audiences we pushed up
-- from CRM contacts vs ones that already existed in the ad account.
-- The distinction matters because only 'crm' ones can be refreshed
-- from a segment — a 'meta' one has no local source to rebuild from.
--
-- Unrelated to the existing retargeting_audiences table, which is
-- campaign_schedule-scoped and belongs to WhatsApp broadcast
-- retargeting.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ad_audiences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meta_audience_id    TEXT NOT NULL UNIQUE,

  name                TEXT NOT NULL,
  subtype             TEXT NOT NULL,
  origin              TEXT NOT NULL DEFAULT 'meta',

  -- Meta refuses to report an exact size below a privacy threshold, so
  -- this is genuinely approximate and must be labelled as such in the UI.
  approximate_count   BIGINT,
  delivery_status     TEXT,

  -- For origin='crm': the contact filter this audience was built from,
  -- so it can be re-uploaded when the segment changes.
  filter_criteria     jsonb,
  -- For lookalikes: the seed audience.
  source_audience_id  TEXT,

  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_ad_audiences_subtype_chk
    CHECK (subtype IN ('CUSTOM', 'LOOKALIKE', 'WEBSITE', 'ENGAGEMENT', 'SAVED')),
  CONSTRAINT meta_ad_audiences_origin_chk
    CHECK (origin IN ('crm', 'meta'))
);

COMMENT ON COLUMN meta_ad_audiences.origin IS
  '"crm" = built by us from a contact segment and refreshable; "meta" = already existed in the ad account and has no local source to rebuild from. These are the reference product''s two audience tabs.';

CREATE INDEX IF NOT EXISTS idx_meta_ad_audiences_account
  ON meta_ad_audiences (account_id, created_at DESC);

ALTER TABLE meta_ad_audiences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ad_audiences_select ON meta_ad_audiences;
CREATE POLICY meta_ad_audiences_select ON meta_ad_audiences FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_ad_audiences_write ON meta_ad_audiences;
CREATE POLICY meta_ad_audiences_write ON meta_ad_audiences FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));


-- ============================================================
-- 9) meta_ads_audit — who spent what, on whose behalf
--
-- Separate from `notifications` (user-facing) on purpose: this is an
-- append-only record that exists to answer "who turned this ad on".
-- Every write to Meta goes through it, including the ones that fail —
-- a rejected publish attempt is exactly the thing you want to see when
-- money is involved.
--
-- No UPDATE or DELETE policy for anyone, including admins. An audit
-- log an admin can edit answers nothing.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_ads_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  action       TEXT NOT NULL,
  -- Which Meta objects the action touched.
  object_type  TEXT,
  object_id    TEXT,
  -- Request/response detail, budget at the time, and the Meta error on
  -- failure. Redacted of tokens before writing.
  detail       jsonb,
  succeeded    BOOLEAN NOT NULL DEFAULT TRUE,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_audit_account_created
  ON meta_ads_audit (account_id, created_at DESC);

ALTER TABLE meta_ads_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_ads_audit_select ON meta_ads_audit;
CREATE POLICY meta_ads_audit_select ON meta_ads_audit FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Deliberately no INSERT/UPDATE/DELETE policy. Rows are written by the
-- server (which bypasses RLS) and are immutable to every client.
