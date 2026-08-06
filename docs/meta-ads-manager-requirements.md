# Meta Ads Manager — what I need from you

Companion to [meta-ads-manager.md](meta-ads-manager.md) (the plan). This file is
the **inbox**: everything the implementation is blocked on, or where I picked a
default you may want to override.

I am building around every item below, so nothing here blocks me starting — but
the surface cannot be switched on for a real account until §1 and §2 are done.

Legend: 🔴 blocks go-live · 🟡 blocks a specific milestone · 🟢 just confirm my default

---

## 1. Meta app configuration 🔴

### 1.1 Which app?

This repo already talks to Meta through **two** app identities:

| Env pair | Used by |
|---|---|
| `META_APP_ID` / `META_APP_SECRET` | WhatsApp Cloud API, Facebook Pages / lead ads |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram Login |

**Question:** do ads go on the existing `META_APP_*` app, or a new one?

- **My default:** reuse `META_APP_*`. The customer has already granted it Pages
  and WhatsApp access, so the ads consent dialog becomes an incremental
  permission request instead of a second full login. I've written the code to
  read `META_ADS_APP_ID` / `META_ADS_APP_SECRET` and **fall back** to
  `META_APP_ID` / `META_APP_SECRET`, so reusing means setting nothing.
- Reason to split: App Review for `ads_management` is scoped to an app. If the
  ads review stalls, a shared app is not affected (permissions are reviewed
  individually), so this is a weak reason. Splitting also means two consent
  dialogs and two tokens per customer.

**→ Tell me if you want a separate app.** Otherwise I proceed on the shared one.

### 1.2 In the Meta dashboard, please do

- [ ] Add the **Marketing API** product to the app.
- [ ] App Settings → Basic → confirm the app is **Business**-type and linked to
      the right Business Portfolio.
- [ ] **Facebook Login for Business** → Valid OAuth Redirect URIs → add:
      - `https://<your-api-domain>/ads/oauth/callback`
      - `http://localhost:8001/ads/oauth/callback` (local dev)
      - **I need the exact API domain** to give you the production string.
- [ ] App Settings → Basic → **Data Deletion Request URL**:
      `https://<your-api-domain>/ads/privacy/data-deletion`
- [ ] App Settings → Basic → **Deauthorize Callback URL**:
      `https://<your-api-domain>/ads/privacy/deauthorize`
      (Both are implemented and tested — Meta checks them during review.)
- [ ] Confirm **Business Verification** status. `ads_management` cannot reach
      advanced access without it.

### 1.3 Permissions to request in App Review 🔴

| Permission | Why | Already held? |
|---|---|---|
| `ads_management` | create/edit campaigns, ad sets, ads, creatives | ❌ |
| `ads_read` | insights / reporting | ❌ |
| `business_management` | list the customer's businesses + ad accounts | ❌ |
| `pages_show_list` | pick the page the ad runs from | ✅ |
| `pages_read_engagement` | page name/avatar for the preview | ✅ |
| `pages_manage_ads` | run ads on behalf of the page | ❌ |
| `leads_retrieval` | pull lead-form submissions | ✅ |
| `whatsapp_business_management` | link the WABA number for Click-to-WhatsApp | ✅ |
| `instagram_basic` | only if Instagram placements ship | ❓ |

Plus, separately from permissions: **Marketing API access tier**. New apps sit
in *Development* (limited to ad accounts you own). *Standard* access needs its
own review. Please check which tier the app is on — it changes whether we can
test against a customer's real ad account.

### 1.4 A test ad account for development 🟡 (blocks M2/M3 verification)

I need **one** of:

- a Meta **test user + test ad account** (App → Roles → Test Users), or
- a real ad account with a tiny budget that I may create **PAUSED** campaigns in,
  and the FB user id that admins it.

Without either, M0–M3 are only verifiable against the sandbox fixtures I'm
writing (which prove our code paths, not Meta's).

---

## 2. Environment variables 🔴

I'm adding these. `.env.local.example` / the api `.env` get documented entries;
**values are yours to fill.**

```bash
# --- apps/api/.env ---

# Master switch. Off → every /ads/* route 404s.
ADS_MANAGER_ENABLED=false

# Serve fixtures instead of calling Meta. For local dev before App Review.
ADS_MANAGER_SANDBOX=true

# Optional. Omit to reuse META_APP_ID / META_APP_SECRET (see §1.1).
META_ADS_APP_ID=
META_ADS_APP_SECRET=

# Must match a Valid OAuth Redirect URI in the Meta dashboard exactly.
META_ADS_REDIRECT_URI=https://<api-domain>/ads/oauth/callback

# Server-side backstop, MINOR units of the ad account currency.
# 10000 = ₹100/day. A publish above this is rejected regardless of the UI.
# See §3.4 — please pick a real number.
ADS_MAX_DAILY_BUDGET_MINOR=1000000

# WhatsApp Status ads — its own switch, separate from the master flag.
# The placement is unverified (see §4), so the wizard shows the card
# disabled with a reason until this is on.
ADS_WHATSAPP_STATUS_ENABLED=false

# --- apps/web/.env.local ---

# Hides the rail row and the /ads routes. Not access control — the API
# has its own flag — just avoids advertising a dead surface.
NEXT_PUBLIC_ADS_MANAGER_ENABLED=false
```

Note `ENCRYPTION_KEY` is already required and already set; ads tokens reuse it.

---

## 3. Decisions where I picked a default 🟢

Override any of these and I'll change it; otherwise this is what ships.

### 3.1 Who may connect an ad account, and who may publish

- **Connect / disconnect the ad account: `admin`+** (RLS and UI). It authorises
  spending, so it's an account-level act.
- **Publish / pause / edit an ad: `admin`+** too.
- **View ads and insights: any member** (`viewer`+).

Alternative worth considering: make publishing `owner`-only, like billing. I did
*not* do that — an owner who hired a marketer would then have to publish every ad
themselves. But it is your call, and it's a one-line change in the guard.

### 3.2 Ads default to PAUSED after publish?

- **My default: publish goes live.** The wizard's "Publish" button creates
  everything PAUSED (so a mid-sequence failure can't spend money), then flips to
  ACTIVE as the last step. From the user's point of view, Publish means live —
  matching the reference product.
- Alternative: land in PAUSED and require a second explicit "Turn on". Safer,
  one more click, and differs from what users expect from Meta's own tool.

### 3.3 Subscription gating

Should Ads Manager be **plan-gated** (e.g. GROWTH and ENTERPRISE only)?

- **My default: not gated.** No plan check, available to every account once the
  flag is on.
- If you want it gated, tell me which plans and I'll add it — `subscription_plans`
  has no feature-flag column today, so this means either a new column or a
  hardcoded plan-name list. **Prefer the column**; say the word and I'll add it
  in the same migration.

### 3.4 The daily-budget ceiling

`ADS_MAX_DAILY_BUDGET_MINOR` above is a **safety backstop**, not a product
limit — it exists so a units bug or a bad payload can't create a ₹5,00,000/day
ad set. I defaulted it to ₹10,000/day.

**→ What is the highest daily budget a legitimate customer would set?** Pick
something comfortably above it.

### 3.5 Ad account currency vs workspace currency

Ad account currency comes from Meta and is immutable. Everything in the Ads
Manager surface is displayed in **the ad account's currency**, independent of
`ADMIN_CURRENCY` or a workspace setting, with the code shown next to every
figure. Insights rows store their currency so a later ad-account switch doesn't
silently reinterpret history.

### 3.6 Click-to-WhatsApp ↔ the existing CTWA page

Publishing a Click-to-WhatsApp ad **also writes a `ctwa_campaigns` row** with
`meta_ad_id` set, so `ctwa_clicks` attribution and the existing
`/channels/whatsapp/ctwa` page work with no changes.

Consequence: that page will start showing campaigns the user created in Ads
Manager, not only hand-made ones. I think that's right (they are the same thing),
but flag it if you'd rather the two lists stay separate.

---

## 4. Things only you can check in the Meta account 🟡

These are in the plan's verification list, and I cannot answer them from code or
docs alone — they depend on what the actual business/ad accounts are eligible
for.

- [ ] **WhatsApp Status Ads** — does the placement exist for your ad accounts?
      (Screenshot 2 offers it; it's new, market-gated, and the least documented
      of the five.) If not available, I ship it as a disabled card with a reason
      rather than a flow that errors at publish. **This is the one ad type I
      can't promise.**
- [ ] **Click-to-WhatsApp eligibility** — the WABA must be linked to the same
      Business Portfolio as the ad account. Confirm they are, or CTWA ads fail
      at ad-set creation with an unhelpful error.
- [ ] **A Meta Pixel** — needed for Website Ads optimising for conversions. Is
      there one, and on which domains?
- [ ] **Lead Form Terms of Service** — must be accepted once per page
      (screenshot 1 has a checkbox for it). Accepting it is a manual step in
      Meta's UI or an API call; confirm you're happy for us to surface it.

---

## 5. Copy / product questions 🟢

- **Rail label.** I'm using **"Ads Manager"**, icon a megaphone, placed after
  "AI Agents & Bots" in the workspace block. Alternative: "Meta Ads" — clearer
  that it's not our own ad network, but longer and the icon already implies ads.
- **Panel rows.** `Overview · Create Ad · Leads · Lead Forms · Audiences ·
  Events · Setup`. "Lead Forms" rather than "Forms" because `/forms` is already
  the web form builder and they are unrelated.
- **AI creative generation** (screenshot 5: "Generate Your Creatives with AI",
  product/logo upload, aspect ratio, 3 free generations). **Out of scope** —
  the `ai` module does text and retrieval only, so this needs an image-generation
  provider, a per-account quota ledger and a moderation story. If you want it,
  it's its own project and I need to know which provider.

---

## 6. Status log

Updated as I go, so you can see what's actually built.

| Milestone | State |
|---|---|
| M0 foundations (migration 068 applied, Prisma models, Graph util, module, flag, sandbox) | **done** |
| M1 connect + Setup page + nav | **done** |
| M2 read surface + insights sync (nightly BullMQ sweep + on-demand) | **done** |
| M3 wizard + Click-to-WhatsApp | **done** |
| M4 remaining four ad types + Meta lead forms | **done** (WhatsApp Status ships gated off — §4) |
| M5 audiences + events | **done** |
| M6 App Review pack | **written** — [meta-ads-app-review.md](meta-ads-app-review.md). Submission blocked on §1 |

Verified end to end: monorepo typecheck clean, **806 API tests + 676 web
tests** passing, both apps build, **41 `/ads/*` routes** map on boot, the
nightly sync scheduler registers, and the feature flag 404s everything when
off.

### Gap-closing round — everything that was outstanding is now built

An audit against the plan turned up ten things that were promised and
missing, or built and not wired up. All are done:

| Was | Now |
|---|---|
| 🔴 **No data-deletion callback** — blocked App Review | `POST /ads/privacy/data-deletion` + `/deauthorize`, `signed_request` HMAC verified, public status page at `/ads-data-deletion`, 8 tests. **Paste both URLs into the Meta dashboard — see the App Review pack §5.** |
| Refreshing mid-wizard lost the draft | `?type=`/`?step=` in the URL, draft in `sessionStorage`. The whole draft is deliberately NOT in the URL — see `use-wizard-persistence.ts`. |
| `custom_event_type` hardcoded to `PURCHASE` | An 11-event picker, served from the same list the builder validates against. A sign-up campaign no longer bids for purchases. |
| No way to save an audience from the wizard | "Save audience" button + `POST /ads/audiences/saved` |
| Audience build ignored tags and emails | Tag chips + an optional email schema |
| `filter_criteria` written but never read | Refresh-from-segment per CRM audience |
| `runAsyncInsightsReport` had no caller | 90-day backfill when an ad account is first selected, so the Overview is not empty until the first nightly sync |
| Meta's real preview unused (CSP) | *"See Meta's exact preview"* — iframe `src` extracted, hostname verified, opened in a new tab. No `frame-src` change needed. |
| `meta_ads_audit` write-only | Readable on Setup, admin-gated, failures included |
| Plan asked to read placement enums from the API | Closed as **not possible** — no such endpoint exists. Documented in the plan §12 item 7. |

Two bugs my own verification caught and fixed: an empty POST to the privacy
callback returned 500 instead of 400 (these are public endpoints, so
unparsed input must be a 400), and the wizard's URL→state sync was a
`setState` inside an effect — the ad type is now derived rather than stored
twice.

### What you can walk through today

With `ADS_MANAGER_ENABLED=true`, `ADS_MANAGER_SANDBOX=true` and
`NEXT_PUBLIC_ADS_MANAGER_ENABLED=true` (both dev servers restarted —
`NEXT_PUBLIC_*` is inlined at build time):

1. **Ads Manager** in the primary rail, with its own second panel:
   Overview · Create Ad · Leads · Lead Forms · Audiences · Events · Setup.
2. **Setup** — press *Use sandbox*, then pick a business, an ad account, a
   page, link WhatsApp, pick a pixel, record the lead terms. The checklist
   fills in and reports *Ready to advertise*.
3. **Create Ad** — the full four-step wizard: five destination cards,
   targeting with location and interest autocomplete, placement chips,
   budget with day-parting, creative with upload and character counters,
   plus a live preview and reach estimate. Publish writes a real campaign
   → ad set → ad into the database and (for Click-to-WhatsApp) a
   `ctwa_campaigns` row.
4. **Overview** — KPI tiles, two trend charts, and a campaign table with
   expandable per-ad rows and working pause/resume.
5. **Leads** — spend joined to contacts and pipeline deals.
6. **Lead Forms**, **Audiences**, **Events** — all functional against
   fixtures.

Fixtures exist specifically to make the *unhappy* paths reachable, because
those are what break in production: an ad account with **no payment
method**, a page **without the Advertise task**, and a **paused** campaign
whose `effective_status` differs from its `status`.

Also verified: flag off → `/ads/*` 404s; flag on without a session → 401;
forged OAuth state → redirect to Setup with an error and nothing written.

**Real-Meta verification is still blocked on §1.4 — a test ad account.**
Everything above proves our code paths, not Meta's parameter validation.
The two items most likely to need a fix on first contact are the CTWA
`promoted_object` shape and `destination_type` behaviour.
