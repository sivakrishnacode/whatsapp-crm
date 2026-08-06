# Meta Ads Manager — implementation plan

Status: **M0–M6 built.** Every milestone in §11 is implemented and verified
against sandbox fixtures; submission to Meta App Review is the remaining
gate. Milestone table, what is walkable today, and the open items:
[meta-ads-manager-requirements.md](meta-ads-manager-requirements.md) §6.
App Review pack: [meta-ads-app-review.md](meta-ads-app-review.md).

Where the plan and the build differ, recorded here so this file stays honest
rather than aspirational:

- **WhatsApp Status ads ship gated off** behind their own
  `ADS_WHATSAPP_STATUS_ENABLED` flag, exactly as §6 flagged. The builder is
  written and reviewable; the card renders disabled with a reason until the
  placement is confirmed against a real ad account.
- **Meta's real preview is used, but not embedded.** The wizard shows a
  hand-rolled mock plus a *"See Meta's exact preview"* link that opens
  `/generatepreviews`' iframe `src` in a new tab — the real rendering with no
  CSP `frame-src` change. See §12 item 8.
- **`?type=` and `?step=` are in the URL; the rest of the draft is not.**
  §7 asked for "state in the URL"; the whole draft would be kilobytes of
  base64 in the address bar and still not shareable (media hashes are
  ad-account-scoped). Navigation state is in the URL, recovery state is in
  `sessionStorage`. See `use-wizard-persistence.ts`.
- **A data-deletion callback was missing and is now built**
  (`/ads/privacy/data-deletion`). It was not in the original plan at all —
  writing the App Review pack surfaced it as a hard requirement.

Target: a new primary-rail surface that
connects a customer's own Meta ad account and lets them create and monitor the
five ad types in the reference product (`app.aisensy.com/.../advertisement/*`).

Reference material in-repo: `notes/Facebook Marketing API (MAPI).postman_collection.json`
(campaigns / ad sets / ads / creatives / insights / targeting / pixel). It does
**not** cover Click-to-WhatsApp destinations, lead-gen forms, or custom
audiences — those come from Meta's own docs. See [Verification list](#12-verification-list).

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| v1 scope | **Full wizard, all five ad types** + read/insights surface |
| Who pays Meta | **The customer's own ad account.** No wallet, no ad credits, no money through us. The reference's "Ad Credit / Buy Credits" header is deliberately omitted. |
| Nav placement | **New primary-rail row that owns a secondary panel** |
| Meta app permissions | **Not approved yet** — whole surface behind a flag, with a sandbox path |

Consequences worth stating up front:

- **No `ad_wallets` table, no top-up checkout, no spend reconciliation.** What
  replaces the credit check in the reference's budget step (screenshot 3,
  *"You don't have sufficient credit…"*) is a **funding-source check** on the
  connected ad account: read `funding_source_details` / `account_status` at
  connect time and block publish with a link to Meta's payment settings if the
  account can't spend.
- Because the customer's card is the funding source, **a bug in our publish
  path spends their real money.** Section 10 is not optional.

---

## 2. What already exists (reuse, don't duplicate)

| Existing | Reuse how |
|---|---|
| `facebook_connections` / `facebook_pages` ([facebook.controller.ts](apps/api/src/integrations/controllers/facebook.controller.ts)) | Page list + the `isDemo` sandbox idiom. **Do not extend this table** — it's `user_id`-scoped and stores tokens in plaintext. New ads tables are `account_id`-scoped and encrypted. |
| `FacebookLeadsWebhookController` (same file) | Lead-form leads already flow Meta → contact → deal → conversation, with HMAC verification. Lead Form ads plug straight into it; only the form *creation* side is new. |
| `ctwa_campaigns` / `ctwa_clicks` (+ [ctwa.controller.ts](apps/api/src/campaigns/controllers/ctwa.controller.ts)) | `ctwa_campaigns.meta_ad_id` already exists. Publishing a Click-to-WhatsApp ad writes a `ctwa_campaigns` row, so click/conversion attribution and the existing `/channels/whatsapp/ctwa` page keep working with no changes. |
| `whatsapp_config` | Source of the WABA phone number for the CTWA "Link WhatsApp Number" step. |
| [encryption.util.ts](apps/api/src/common/security/encryption.util.ts) (`encrypt`/`decrypt`, AES-256-GCM) | Every ads token at rest. |
| `formatMetaError` in [meta-api.util.ts](apps/api/src/whatsapp/meta-api.util.ts) | Marketing API returns the same `error_user_title` / `error_user_msg` shape. Extract it to `common/messaging/meta-errors.ts` (already exists) rather than copying. |
| `QueueModule` (BullMQ) | Insights sync + audience upload jobs. |
| `is_account_member(account_id[, role])` RLS helper | Every new table's policies. |

Nothing here calls for a second Prisma schema — `packages/database` stays the
only one.

---

## 3. Nav & IA

### 3.1 The rail row

Append to `RAIL_WORKSPACE` in [nav-config.ts](apps/web/src/lib/nav/nav-config.ts),
after `agents`, icon `Megaphone`:

```
┌────────────┬──────────────┬─────────
│ Home       │ ADS MANAGER  │
│ Inbox      │  Overview    │  page
│ Contacts   │  Create Ad   │
│ Pipelines  │  Leads       │
│ Automations│  Lead Forms  │
│ Agents     │  Audiences   │
│▸Ads Manager│  Events      │
├────────────┤  Setup       │
│ WhatsApp   │              │
│ Instagram  │              │
│ Web        │              │
```

`Lead Forms`, not `Forms` — `/forms` is already the web form builder and the two
are unrelated things.

### 3.2 Generalising the panel owner (the one structural change)

Today only two things own a secondary panel: a channel, and Settings. Both are
special-cased in `resolveNavContext`. Rather than adding a third special case:

- Add `panel?: PanelGroup[]` and `panelTitle?: string` to the `RailItem`
  interface.
- In step 3 of `resolveNavContext` (the "plain rail destination" branch), if the
  matched rail item carries a panel, resolve the active row with the existing
  `findPanelItem()` and return `panel` / `panelTitle` / `breadcrumb` instead of
  `...empty`.

That is ~10 lines and makes any future rail row panel-capable. `PrimaryRail`
needs the mobile-drawer inline panel (currently only rendered for the active
channel) extended to a panel-owning rail row — same markup, hoisted into
`renderRailItem`.

New file `apps/web/src/lib/nav/ads.ts` exports `ADS_PANEL` and `ADS_RAIL_ITEM`,
matching how `channels.ts` and `settings-sections.ts` own their own panels.

### 3.3 Routes

```
apps/web/src/app/(dashboard)/ads/
  page.tsx            Overview — campaign/ad tables + insights
  create/page.tsx     The wizard (?type=&step=)
  leads/page.tsx      Leads from CTWA + lead forms
  lead-forms/page.tsx Meta instant forms
  audiences/page.tsx  Custom / lookalike / saved
  events/page.tsx     Pixel + events
  setup/page.tsx      The connect checklist (screenshot 1)
```

`channelLandingHref`'s reasoning applies here too: the rail row must point at a
real page — `/ads` (Overview), which redirects to `/ads/setup` until the account
is connected.

### 3.4 Tests

Extend [nav-config.test.ts](apps/web/src/lib/nav/nav-config.test.ts): the rail
row resolves with a panel, each panel row highlights, `/agents` does **not**
resolve to the ads panel (the same regression the Web-channel Knowledge-Base row
caused), and the row is absent when the flag is off.

---

## 4. Data model — migration `068_meta_ads_manager.sql`

All tables `public`, `account_id`-scoped, RLS on, policies mirroring
`064_instagram_comment_funnels.sql`: `SELECT` = `is_account_member(account_id)`,
writes = `is_account_member(account_id, 'agent')` except where noted. Then
`npm run db:generate`.

**`meta_ads_config`** — one row per account (`account_id` UNIQUE), the
`whatsapp_config` pattern.

```
account_id UNIQUE, user_id            -- who connected it
fb_user_id, fb_user_name
access_token            encrypted     -- long-lived user token
token_expires_at, granted_scopes text[]
business_id, business_name
ad_account_id, ad_account_name        -- stored WITHOUT the act_ prefix
currency, timezone_name, account_status, funding_ok bool
page_id, page_name, page_access_token encrypted
whatsapp_phone_number_id, whatsapp_display_number
pixel_id
lead_terms_accepted_at
status, connected_at, created_at, updated_at
```

Write policy `'admin'`, not `'agent'` — connecting an ad account is an
account-level act, and it is the object that authorises spending.

**`meta_ads_campaigns`** — local mirror + our own metadata:
`account_id, meta_campaign_id UNIQUE, name, ad_type` (our 5-way discriminator —
Meta has no field for it), `objective, status, effective_status, buying_type,
daily_budget, lifetime_budget, special_ad_categories text[], start_time,
stop_time, created_by_user_id, synced_at`.

**`meta_ads_adsets`** — `account_id, campaign_id FK, meta_adset_id UNIQUE, name,
optimization_goal, billing_event, bid_strategy, bid_amount, daily_budget,
lifetime_budget, destination_type, targeting jsonb, promoted_object jsonb,
adset_schedule jsonb, status, effective_status, synced_at`.

**`meta_ads_ads`** — `account_id, adset_id FK, meta_ad_id UNIQUE,
meta_creative_id, name, creative jsonb, status, effective_status,
preview_url, synced_at`.

Creatives stay as `jsonb` on the ad — a separate table buys nothing while we
never reuse a creative across ads.

**`meta_ads_insights`** — daily grain, `UNIQUE (account_id, level, object_id, date_start)`:
`level ('account'|'campaign'|'adset'|'ad'), object_id, date_start, spend,
impressions, reach, frequency, clicks, ctr, cpc, cpm, actions jsonb,
action_values jsonb, currency, synced_at`. Server-write only — no client INSERT
policy, same reasoning as `instagram_comment_funnel_runs`.

**`meta_ads_media`** — the "media library": `account_id, kind ('image'|'video'),
meta_image_hash, meta_video_id, name, width, height, permalink_url, created_at`.
Meta's `/act_{id}/adimages` is itself the durable store; this is a local index so
the picker doesn't page the Graph API on every open.

**`meta_lead_forms`** — `account_id, page_id, meta_form_id UNIQUE, name, status,
questions jsonb, privacy_policy_url, thank_you jsonb, leads_count, synced_at`.

**`meta_ad_audiences`** — `account_id, meta_audience_id UNIQUE, name, subtype
('CUSTOM'|'LOOKALIKE'|'WEBSITE'|'SAVED'), origin ('crm'|'meta'), approximate_count,
filter_criteria jsonb, source_audience_id, delivery_status, last_synced_at`.
`origin` is what the reference calls "AiSensy Audiences" vs "Fetched Audiences":
ones we pushed from CRM contacts vs ones that already existed in Meta.

The existing `retargeting_audiences` is `schedule_id`-scoped and belongs to
campaign schedules — unrelated, leave it.

---

## 5. Backend — `apps/api/src/ads/` (new `AdsModule`)

Structured to mirror `WebModule` / `InstagramModule` so the modules stay
diffable.

```
ads.module.ts
marketing-api.util.ts          Graph wrappers. Named-options objects only.
marketing-api.util.test.ts
ads-sync.processor.ts          BullMQ: insights + object sync
controllers/
  ads-connect.controller.ts      OAuth, business/ad-account/page/WA/pixel pick, disconnect
  ads-campaigns.controller.ts    list / publish / pause / resume / delete
  ads-insights.controller.ts     account + per-object insights, date presets
  ads-targeting.controller.ts    geo + interest search, delivery estimate
  ads-audiences.controller.ts
  ads-lead-forms.controller.ts
  ads-media.controller.ts        upload → adimages / advideos
services/
  ads-config.service.ts          THE only place a token is decrypted
  ads-connect.service.ts
  ad-publish.service.ts          orchestrates campaign → adset → creative → ad
  ad-types/
    index.ts                     AD_TYPES registry
    click-to-whatsapp.builder.ts
    whatsapp-status.builder.ts
    website-to-whatsapp.builder.ts
    website.builder.ts
    lead-form.builder.ts
  ads-sync.service.ts
  ads-insights.service.ts
  ads-audiences.service.ts
  ads-lead-forms.service.ts
dto/                             class-validator DTOs, one per ad type
sandbox/fixtures.ts
```

`@Controller('ads/...')` → internal dashboard surface → `SupabaseAuthGuard` +
`@CurrentAccount()`. Add to `AppModule`, and one rewrite line in
[next.config.ts](apps/web/next.config.ts) `beforeFiles`:

```ts
{ source: "/api/ads/:path*", destination: `${nestApiUrl}/ads/:path*` },
```

**API version:** pin `v23.0` in a single `META_MARKETING_VERSION` constant. This
is a *third* pinned version (WhatsApp `v21.0`, FB Pages `v20.0`); note it in
CLAUDE.md rather than quietly adding it. Marketing API deprecates versions on a
schedule, so the pin needs an owner.

**The builder contract.** Each ad type is one file exporting:

```ts
interface AdTypeBuilder {
  id: AdType;                       // 'click_to_whatsapp' | ...
  label: string;
  schema: ZodType;                  // shared with the web wizard
  campaign(input): CampaignParams;  // objective, special_ad_categories
  adset(input, ctx): AdSetParams;   // optimization_goal, destination_type,
                                    // promoted_object, targeting
  creative(input, ctx): CreativeParams;  // object_story_spec
}
```

`AdPublishService` is then type-agnostic: pick the builder, run the three
builders, execute the sequence in section 7.4. Adding a sixth ad type is one
file plus a registry line.

---

## 6. The five ad types → Marketing API

Meta's hierarchy: **Ad Account** → **Campaign** (objective) → **Ad Set** (budget,
schedule, targeting, optimisation, destination) → **Ad** → **Ad Creative**.

⚠ = confirm against Meta docs before coding; the Postman collection has no
example.

| UI type | Campaign `objective` | Ad set | Creative |
|---|---|---|---|
| **Click to WhatsApp** | `OUTCOME_ENGAGEMENT` (also valid: `OUTCOME_SALES`, `OUTCOME_LEADS`) | `destination_type: WHATSAPP` ⚠, `optimization_goal: CONVERSATIONS`, `promoted_object: { page_id }` ⚠ | `link_data.call_to_action: { type: WHATSAPP_MESSAGE, value: { app_destination: WHATSAPP } }` ⚠ |
| **WhatsApp Status Ad** | `OUTCOME_AWARENESS` / `OUTCOME_ENGAGEMENT` | `publisher_platforms: ['whatsapp']`, `whatsapp_positions: ['status']` ⚠⚠ | `link_data` or `video_data` |
| **Website to WhatsApp** | `OUTCOME_TRAFFIC` | `optimization_goal: LINK_CLICKS` / `LANDING_PAGE_VIEWS` | `link_data.link = website`, CTA `WHATSAPP_MESSAGE` — the click lands on the site, the site carries a wa.me button |
| **Website Ad** | `OUTCOME_TRAFFIC` or `OUTCOME_SALES` | `LINK_CLICKS` / `OFFSITE_CONVERSIONS` + `promoted_object: { pixel_id, custom_event_type }` | `link_data` |
| **Lead Form Ads** | `OUTCOME_LEADS` | `destination_type: ON_AD`, `optimization_goal: LEAD_GENERATION`, `promoted_object: { page_id }` | `link_data.call_to_action: { type: SIGN_UP, value: { lead_gen_form_id } }` ⚠ |

Two hard notes:

- **WhatsApp Status Ads (⚠⚠) are the riskiest item in the plan.** Availability
  is market- and eligibility-gated and the placement is new. Verify it exists
  for the target ad accounts *before* M4, and be prepared to ship the type as a
  disabled card with a "not available for your account" reason rather than a
  broken flow.
- **`special_ad_categories` is mandatory on campaign create** and legally
  significant (housing / credit / employment / social issues restrict
  targeting). It must be an explicit question in the wizard, not a hardcoded
  `[]`.

---

## 7. The wizard, field by field

Route `/ads/create?type=<ad_type>&step=<n>`. State in the URL so a refresh or a
back-button press doesn't lose a half-built ad. Zod schema per ad type, shared
between the wizard and the API DTO so client and server can't disagree.

Layout matches the reference: accordion steps on the left, sticky
preview + reach estimate on the right.

### 7.1 Step 1 — destination & objective (screenshot 2)

Five cards → `ad_type`. Selecting one fixes **Ad Objective** (read-only, derived)
and offers the valid **Performance Goals** for that objective — i.e. the ad set's
`optimization_goal`, filtered by the builder. Never a free-text objective field;
the objective/goal/destination triple is the thing Meta rejects most often.

### 7.2 Step 2 — targeting & audience (screenshot 4)

| UI control | Maps to |
|---|---|
| Use Saved Audiences | `GET /act_{id}/saved_audiences` → `targeting.saved_audience_id`. Mutually exclusive with hand-built targeting — enforce it, Meta errors otherwise. |
| Custom / Lookalike (multi) + Exclude | `targeting.custom_audiences[]` / `excluded_custom_audiences[]` |
| Create Custom or Lookalike | Opens the M5 audience dialog |
| Locations + Exclude Locations | `GET /search?type=adgeolocation&location_types=[…]` → `geo_locations` / `excluded_geo_locations`; supports `cities`, `regions`, `countries`, `zips` (the "pin codes" in the placeholder) |
| Gender ALL / Male / Female | `genders: []` / `[1]` / `[2]` |
| Age 18 → 65 | `age_min` / `age_max`. Floor at 18 — Meta requires it for several objectives and for restricted categories. |
| Platforms & Placements | `publisher_platforms` + `facebook_positions` (11 in the ref: feed, right_hand_column, marketplace, video_feeds, story, search, instream_video, reels, facebook_reels_overlay, profile_feed, notification) + `instagram_positions` (8: stream, story, explore, explore_home, reels, profile_feed, ig_search, profile_reels). Source the lists from the Graph API where possible; hardcoded position lists rot. |
| Advanced Targeting chips (Interests / Demographics / Behaviours, colour-coded) | `GET /search?type=adinterest&q=` → `flexible_spec[].interests` / `.behaviors` / `.demographics`. The colour is the returned `type`. |
| Audience expansion toggle | `targeting_automation.advantage_audience: 0\|1` ⚠ |
| Save Audience | `POST /act_{id}/saved_audiences`, mirrored into `meta_ad_audiences` with `subtype='SAVED'` |

Reach estimate: `GET /act_{id}/delivery_estimate` with the built targeting spec,
debounced. The reference shows "Unable To Fetch" — worth actually getting right,
it's the only feedback a user has that the targeting is sane.

### 7.3 Step 3 — budget & schedule (screenshot 3)

- **Daily Budget | Lifetime Budget** dropdown + amount → `daily_budget` /
  `lifetime_budget`, **in minor units** (₹500 → `50000`). Getting this wrong is
  a 100× overspend; assert it in a unit test.
- Validate against Meta's per-currency minimum daily budget and against the ad
  account's `currency` from `meta_ads_config` — reject client-side *and*
  server-side.
- Start date; optional end date (`start_time` / `stop_time`, ISO with the ad
  account's timezone offset, not the browser's). Lifetime budget **requires**
  `stop_time`.
- **Run Ads on a Custom Schedule** toggle → week × hour grid →
  `adset_schedule[]` + `pacing_type: ['day_parting']`, plus the
  viewer-timezone vs ad-account-timezone selector
  (`schedule_type` ⚠). Day-parting requires a lifetime budget on some
  configurations — verify.
- **In place of the reference's credit check:** show the ad account's funding
  state. If `account_status !== 1` or there's no funding source, block Publish
  with a deep link to Meta's billing settings.

### 7.4 Step 4 — creative (screenshot 5), then publish

| UI | Maps to |
|---|---|
| Ad Name (255) | `ad.name` |
| Primary Text (2200) | `object_story_spec.link_data.message` |
| Headline (40) | `…link_data.name` |
| Description (30) | `…link_data.description` |
| Lead Form select + Create New | `lead_gen_form_id` (Lead Form type only) |
| CTA Button dropdown | `…link_data.call_to_action.type`, options filtered per ad type |
| Media: Image / Video, URL or upload | `POST /act_{id}/adimages` → `image_hash`; `POST /act_{id}/advideos` → `video_id` (+ required `image_url` thumbnail). Mirror into `meta_ads_media`. |
| "Generate Your Creatives with AI" | **Out of v1.** See section 12. |

Enforce the character limits client-side — Meta's rejection for an over-long
headline is a generic "Invalid parameter".

**Publish sequence — the part that must not be naive.** Creating an ad is 4+
non-atomic Graph calls. A failure at step 4 otherwise leaves an orphaned
campaign and ad set, and in the worst ordering a *live* ad set with a budget.

```
1. POST /act_{id}/campaigns          status=PAUSED
2. POST /act_{id}/adsets             status=PAUSED
3. POST /act_{id}/adimages|advideos  (if new media)
4. POST /act_{id}/adcreatives
5. POST /act_{id}/ads                status=PAUSED
6. mirror all five into our tables, in one Prisma transaction
7. only now: POST /{campaign_id} status=ACTIVE  (+ adset, ad)
```

On failure at any step: delete what this run created, in reverse order, and
surface `formatMetaError`. Every created object id is recorded before the next
call so the rollback has something to work from. Publish is idempotent per
client-supplied request id, so a double-click can't buy two campaigns.

---

## 8. Sync & insights

- `ads-sync.processor.ts`, BullMQ, two jobs:
  - **objects** — `GET /act_{id}/campaigns|adsets|ads` with `fields=` mirroring
    our columns; reconciles `effective_status` (a user can pause an ad in Meta's
    own Ads Manager and we must not show it as active).
  - **insights** — `GET /act_{id}/insights` with
    `level=ad&time_increment=1&breakdowns=` for the trailing 7 days each night,
    upserted on `(account_id, level, object_id, date_start)`. Re-fetch the
    trailing week rather than only yesterday: Meta restates attributed
    conversions for up to ~28 days.
- On-demand refresh from the Overview page, rate-limited per account.
- For long ranges use the **async insights** pattern the collection shows
  (`async=true` → poll the report id) instead of a synchronous call that will
  time out.
- Respect per-ad-account rate limits: read `X-Business-Use-Case-Usage` and back
  off. One shared token per account means one bad loop throttles the whole
  workspace.

`ctwa_clicks` already attributes conversations to a `ctwa_campaigns` row; joining
that to `meta_ads_insights` on `meta_ad_id` is what makes the Leads page able to
say *"₹4,200 spend → 38 conversations → 9 deals"*, which is the actual reason to
build this inside a CRM rather than sending people to Meta's Ads Manager.

---

## 9. Feature flag & sandbox

| Var | Where | Effect |
|---|---|---|
| `ADS_MANAGER_ENABLED` | api | Off → every `ads/*` route 404s |
| `NEXT_PUBLIC_ADS_MANAGER_ENABLED` | web | Off → rail row and routes hidden |
| `ADS_MANAGER_SANDBOX` | api | On → `marketing-api.util` is swapped for `sandbox/fixtures.ts`: a fake ad account, two campaigns, plausible insights. Mirrors the existing `isDemo` path in `facebook.controller.ts`. |

Default all three off. The flag is checked in a guard on the controllers, not
just in the UI — a hidden rail row is not access control.

---

## 10. Security rules (non-negotiable)

1. **Never take `ad_account_id`, `page_id`, `audience_id` or `form_id` from the
   request.** Resolve every one from `meta_ads_config` for
   `@CurrentAccount().accountId`. This is exactly the shape of the two
   cross-tenant leaks already removed from this repo (`subscription/admin/users`,
   the `targetUserId` writes): Prisma connects as the DB owner, so RLS is not
   protecting these queries — and here the consequence isn't a data leak, it's
   spending another tenant's money.
2. **Encrypt every token at rest** via `encryption.util`. `facebook_connections`
   stores its token in plaintext today; do not copy that. (Worth a separate
   follow-up to fix the existing table — an ads-scoped token is far more
   dangerous than a leads-scoped one.)
3. **Request the minimum scopes**, and store `granted_scopes` so a missing one
   produces "reconnect to grant ads_management" instead of an opaque Graph
   error.
4. **Ad-account writes are `admin`+ in the UI and in RLS.** Reads can be agent.
5. **Audit every write**: who published/paused/deleted what, with the Meta ids.
   Spending money needs a trail. `notifications` is the wrong table; add
   `meta_ads_audit` or reuse an existing audit surface if one is added.
6. **Server-side budget ceiling** (env-configurable, e.g. `ADS_MAX_DAILY_BUDGET`)
   as a backstop against a UI bug or a minor-units mistake.
7. Publish is **PAUSED-then-ACTIVE with rollback** (section 7.4).
8. If we embed Meta's real ad preview iframe (`/{ad_id}/previews`), the CSP in
   `next.config.ts` needs a `frame-src` entry — and it's currently
   report-only, so it will silently work in dev and break when enforced.

---

## 11. Milestones

| # | Deliverable | Notes |
|---|---|---|
| **M0** | Flags, migration 068, Prisma models, `AdsModule` skeleton, `marketing-api.util` (auth, error mapping, rate-limit backoff), sandbox fixtures | No UI. Ends with a green `npm run typecheck` + util tests. |
| **M1** | Connect & Setup: FB Login with ads scopes → business → ad account → page → WhatsApp number → pixel → lead ToS. `/ads/setup` matching screenshot 1. Rail row + panel + `RailItem.panel` generalisation + nav tests. | First user-visible slice. Sandbox-testable end to end. |
| **M2** | Read surface: object + insights sync, `/ads` Overview (campaign/adset/ad tables, spend / reach / results, date-range picker), nightly BullMQ job. | Useful on its own even before creation exists. |
| **M3** | Wizard core + **Click to WhatsApp**: builder registry, `AdPublishService` with the PAUSED→ACTIVE + rollback sequence, all four steps, live preview, delivery estimate, media upload. Writes a `ctwa_campaigns` row so the existing CTWA page and click attribution light up. | The big one. Everything after it is additive. |
| **M4** | The other four types: **Lead Form** (incl. `POST /{page_id}/leadgen_forms` + list, leads landing via the existing webhook), **Website**, **Website→WhatsApp**, **WhatsApp Status** (or a disabled card with a reason, per section 6). | One builder file each. |
| **M5** | Audiences & Events: CRM segment → hashed custom-audience upload, lookalikes, fetched list, saved audiences; pixel + events page. | `/ads/audiences`, `/ads/events`. |
| **M6** | App Review pack, then flip the flag. | See below. |

M6 is the schedule risk, not the code. `ads_management` needs **App Review +
Business Verification**, and the Marketing API additionally has access tiers
(Development → Basic → Standard) with their own review. Budget weeks, and start
the submission in parallel with M1 rather than after M5.

**App Review checklist** — permissions to request: `ads_management`, `ads_read`,
`business_management`, `pages_show_list`, `pages_read_engagement`,
`pages_manage_ads`, `leads_retrieval` (held), `whatsapp_business_management`
(held), `instagram_basic` (only if IG placements ship). Each needs use-case copy
and a screencast walking a test user from connect → publish → insights, which is
why M1–M3 must be demoable in sandbox before submission.

---

## 12. Verification list

Read before writing the corresponding code — the Postman collection is silent on
all of these:

1. Click-to-WhatsApp: exact `destination_type`, `promoted_object` and
   `call_to_action` shape, and which objectives currently permit it.
2. WhatsApp Status placement: does it exist for the target accounts at all
   (`whatsapp_positions`), and what eligibility gates it. **Confirm before
   promising this ad type.**
3. `leadgen_forms` create payload: question types, privacy policy, thank-you
   screen, and whether form creation needs `pages_manage_ads` or a
   page-scoped token.
4. `targeting_automation.advantage_audience` field name and current
   Advantage+ defaults (Meta renames these frequently).
5. Custom audience upload: required SHA-256 normalisation of phone/email, and
   the `customer_file_source` value that matches "collected by us with consent".
6. Per-currency minimum daily budget, and whether day-parting forces a lifetime
   budget.
7. ~~Facebook/Instagram position enums — prefer reading them from the API
   over hardcoding the 11 + 8 from the reference.~~ **Resolved: not
   possible.** There is no public Graph endpoint that enumerates valid
   `facebook_positions` / `instagram_positions`; the values are documented
   prose only. They are therefore hardcoded in `lib/ads/types.ts` with that
   noted, and the API deliberately does NOT validate against the same list —
   it length-checks the strings and lets Meta reject an unknown position,
   since Meta is the only authority that actually knows. A renamed position
   costs one chip in the UI, not a broken publish.
8. ~~Whether `/{ad_id}/previews` iframes are embeddable under our CSP, or
   whether we hand-roll the preview like the reference does.~~ **Resolved:
   both.** The wizard shows a hand-rolled mock (instant, no Graph call, good
   enough to judge copy length) plus a *"See Meta's exact preview"* link that
   fetches `/generatepreviews`, extracts the iframe `src`, verifies it is a
   facebook.com URL, and opens it in a new tab. That gets the real rendering
   with no `frame-src` change and no iframe — so nothing breaks when the CSP
   stops being Report-Only.

**Deliberately out of v1**, flagged so it's a decision and not an omission:

- **AI creative generation** (screenshot 5's "Generate Your Creatives with AI",
  product/logo upload, aspect ratio, tone, N free generations). The `ai` module
  does text and knowledge retrieval only — this needs an image-generation
  provider, a quota ledger, and a moderation story. Its own project.
- **Ad credits / wallet** — excluded by the funding decision in section 1.
- **Campaign Budget Optimisation**, multiple ad sets per campaign, A/B tests,
  dynamic creative, catalogue/Advantage+ shopping campaigns. The wizard builds
  exactly one campaign → one ad set → one ad.
