# Going live on Meta — apps, permissions, review, and customer onboarding

Everything outside this codebase that has to be true before `converse360` can
onboard a real, paying business on WhatsApp, Instagram, Facebook Lead Ads or
Meta Ads.

This is the **operator runbook**. Per-surface engineering detail lives in
[instagram.md](instagram.md), [meta-ads-manager.md](meta-ads-manager.md),
[meta-ads-manager-requirements.md](meta-ads-manager-requirements.md),
[meta-ads-app-review.md](meta-ads-app-review.md) and
[../deploy/WEBHOOKS.md](../deploy/WEBHOOKS.md). Where they disagree with this
file on Meta-side facts, this file is newer — it was written against Meta's live
documentation in August 2026.

**Assumptions this document is written under** (from the launch decision):

- Starting from scratch — no verified portfolio, no app, nothing approved.
- **Customers pay Meta directly** for WhatsApp conversations. We never hold a
  credit line, never rebill, never touch conversation money. Same posture as ad
  spend (see the "no wallet" rule in [meta-ads-manager.md](meta-ads-manager.md)).
- All four surfaces launch: WhatsApp, Instagram DMs + comments, Facebook Lead
  Ads, Meta Ads Manager.

---

## 0. The answer: one app, not three

**Create ONE Meta app.** Business type. One Business Portfolio. Add all four
surfaces to it as *use cases*.

Meta's app model is explicit about this: *"You can add multiple use cases to a
single app, provided they are compatible with each other."* WhatsApp Business
Platform, Instagram, and Marketing API are compatible — they are different
products under one app, sharing one App ID, one App Secret, one Business
Portfolio, and one Business Verification.

### Why the repo currently reads like you need more than one

[docs/instagram.md:20](instagram.md#L20) and
[apps/api/.env.example:74-80](../apps/api/.env.example#L74-L80) both describe the
Instagram credentials as *"a separate app in the Meta dashboard."* That wording
is wrong and it is the reason you asked this question.

`INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` are the **Instagram app ID and
Instagram app secret** — a second credential pair that Meta generates *inside
your existing app*, shown at **Instagram → API setup with Instagram login**.
Meta's own docs: *"Apps that use Business Login for Instagram will use the
Instagram app ID displayed on the Instagram > API setup with Instagram login
section of the dashboard."*

So the code is right — those really are different values from `META_APP_ID` /
`META_APP_SECRET`, and Instagram webhooks really are signed with the Instagram
secret. Only the word "app" was wrong. **Two credential pairs, one app.**

### Why splitting would actively hurt

| | Cost of splitting |
|---|---|
| **IGSIDs are app-scoped** | Every `contacts.ig_scoped_id` we store is only meaningful to the app that issued it. Move Instagram to a different app later and every stored Instagram identity is garbage — conversations orphan, contacts duplicate. **This is irreversible.** Decide now. |
| **Business Verification is per-portfolio, App Review is per-app** | Three apps means three review queues, three Data Use Checkups, three sets of privacy/deletion callbacks to keep alive. |
| **Consent fatigue** | A customer who already granted the app Pages + WhatsApp access sees the ads request as an *incremental* permission dialog. A separate app means a second full login from zero. |
| **Advanced Access is per app + per permission** | Nothing is shared. You re-prove the same business three times. |

### The one honest argument for splitting

Meta enforcement is **per app**. If the app gets restricted for a policy problem
on one surface — a bad template, an Instagram spam report — everything on that
app goes down together. WhatsApp and Instagram messaging and the ads surface all
stop at once.

Most CRM/BSP vendors accept that risk and run one app. **If you ever want to
hedge it, ads is the surface to split off**, because ads carries no app-scoped
identity that would break: no IGSID equivalent, and the ad account / page ids
come from Meta's own graph. The code already supports this with zero changes —
[apps/api/src/ads/ads.config.ts:45-47](../apps/api/src/ads/ads.config.ts#L45-L47)
reads `META_ADS_APP_ID` / `META_ADS_APP_SECRET` and falls back to
`META_APP_ID` / `META_APP_SECRET` when unset.

**Recommendation: one app now.** Revisit only if ads volume gets large enough
that you want its enforcement blast radius isolated.

> ⚠️ **Use cases cannot be removed from an app after creation.** Adding is fine,
> removing is not. Add WhatsApp + Instagram + the ads/business set deliberately;
> don't click extra ones "to see what they do."

---

## 1. The hierarchy, so the rest of this makes sense

```
Meta personal account (a human logs in with this — yours)
 └── Business Portfolio  ("Business Manager")   ← Business Verification lives HERE
      ├── App: "Converse360"  (Business type)   ← App Review lives HERE
      │    ├── use case: WhatsApp Business Platform
      │    │     └── Embedded Signup configuration → config_id
      │    ├── use case: Instagram  (API setup with Instagram login)
      │    │     └── Instagram app ID + Instagram app secret
      │    ├── Facebook Login for Business       ← ads OAuth + FB leads JS SDK
      │    └── Marketing API                     ← Ads Manager
      ├── Your own Facebook Page / IG account (for testing)
      └── System users, payment methods (yours, for your own ads — not customers')
```

Each **customer** has their own separate Business Portfolio containing their own
WABA, their own Page, their own ad account. Our app is *granted access* to those
assets; we never own them. That is what makes the "customer pays Meta directly"
model work, and it is why no route in this codebase ever accepts an
`ad_account_id` or `waba_id` from the client as authority.

---

## 2. Blockers in our own product — all fixed

Six things that would each have failed App Review on their own. All are now
built; what remains is filling in values only you can supply.

| # | Was | Now |
|---|---|---|
| 1 | **No Privacy Policy page.** The site footer linked `href="#privacy"` — an anchor to nothing. | [apps/site/privacy.html](../apps/site/privacy.html), served at `converse360.in/privacy`. Written against what the code actually does: message content, media mirroring, encrypted tokens, SHA-256 hashed phone numbers to Meta for audiences, bring-your-own-key AI, 90-day retention after cancellation, and an explicit "we do not train models on your data" statement (required by Meta's Jan 2026 terms). ⚠️ **Every `[BRACKETED]` field must be replaced and a lawyer must read it.** |
| 2 | **No Terms of Service page.** Same footer, `href="#terms"`. | [apps/site/terms.html](../apps/site/terms.html), at `converse360.in/terms`. States plainly that Meta bills the customer directly for conversations and ad spend, that we hold no credit line, and that a WhatsApp payment method is required before they can start conversations. Same placeholder rule. |
| 3 | **Instagram data-deletion status page didn't exist** — the callback returned `<app>/settings/data-deletion`, which is inside `(dashboard)` behind the auth gate. A reviewer following it hit a login wall. | Public page at [apps/web/src/app/instagram-data-deletion/page.tsx](../apps/web/src/app/instagram-data-deletion/page.tsx), mirroring the ads one. The callback now points there. |
| 4 | **Instagram deauthorize/data-deletion deleted nothing** — both returned a bare `200`. | Both verify Meta's `signed_request` HMAC with `INSTAGRAM_APP_SECRET` and call `deleteForInstagramUser()`, which matches on `ig_user_id` **or** `ig_app_scoped_id` and removes every matching connection with its encrypted token. Fails closed if the secret is unset. |
| 5 | **No app-level WhatsApp webhook verify token** — a fresh deploy could not save the webhook at all. See §4.4. | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is checked first, constant-time; the per-account walk remains as the fallback for legacy bring-your-own-app connections. |
| 6 | **Hardcoded `"simple"` verify-token bypass**, active in production. | Removed. |

`parseSignedRequest` moved to
[common/security/signed-request.util.ts](../apps/api/src/common/security/signed-request.util.ts)
— two surfaces now receive Meta callbacks signed with **different secrets**
(ads with the app secret, Instagram with the Instagram app secret), so the
secret is a parameter and neither module owns the parser.

Covered by 25 new tests. Full suite: **938 API tests passing**, typecheck clean.

### What is still on you

- [ ] Replace every `[BRACKETED]` placeholder in `privacy.html` and `terms.html`
      — legal entity name, registered address, jurisdiction, grievance officer,
      refund policy, notice periods, hosting region.
- [ ] Have both read by a lawyer before the app goes Live.
- [ ] Note that **nothing in the codebase enforces the 90-day purge** the privacy
      policy promises. Today it is a promise, not a mechanism. Either build the
      job or soften the wording — do not ship the gap.

---

## 3. Phase 0 — Business Portfolio and Business Verification

**Start this on day one. It gates everything and it is the longest queue you do
not control.** Advanced Access requires Business Verification, full stop, since
February 2023.

1. Go to [business.facebook.com](https://business.facebook.com) → create a
   Business Portfolio if you don't have one. Use the **legal entity name** —
   not "Converse360" unless that is what is on the incorporation document.
2. **Business Settings → Security Centre → Start Verification.**
3. Supply: legal business name, registered address, business phone, website
   (`https://converse360.in` — must resolve and must look like a real business
   site), and **one document that matches the name and address exactly**.
   For an Indian entity: Certificate of Incorporation, GST registration
   certificate, or a utility bill in the company name.
4. Meta verifies by phone/email/SMS to a number or domain-based address it can
   tie to the business. A `@gmail.com` contact will slow this down; use
   `@converse360.in`.

**Timeline:** 1–5 business days with clean documents. Weeks if the name on the
document doesn't byte-for-byte match what you typed. That mismatch is the single
most common rejection.

- [ ] Business Portfolio created
- [ ] Business Verification submitted
- [ ] Business Verification **approved** ← blocks §7 entirely

---

## 4. Phase 1 — Create the app and add the four surfaces

### 4.1 Create it

[developers.facebook.com](https://developers.facebook.com) → My Apps → Create App.

| Field | Value |
|---|---|
| App name | `Converse360` (this is what customers see in the consent dialog — get it right, renaming later is a support ticket) |
| Contact email | `support@converse360.in`, not a personal address |
| Use cases | Pick the **WhatsApp** use case first |
| Business portfolio | The verified one from §3 |
| App type | Must resolve to **Business**. A Consumer-type app cannot request `ads_management` at all. |

Then **Dashboard → Use cases → Add** the remaining ones:
- **Instagram** (choose *API setup with Instagram login*, **not** *with Facebook login*)
- **Marketing API**
- **Facebook Login for Business**

### 4.2 App Settings → Basic — fill every field now

Meta rejects submissions with blanks here, and finding out costs a full review
cycle.

| Field | Value |
|---|---|
| App Icon | 1024×1024 PNG, no transparency |
| Category | Business and Pages |
| Privacy Policy URL | `https://converse360.in/privacy` ← **§2 blocker 1** |
| Terms of Service URL | `https://converse360.in/terms` ← **§2 blocker 2** |
| User Data Deletion | **Data Deletion Request URL** → `https://api.converse360.in/ads/privacy/data-deletion` |
| App Domains | `converse360.in`, `app.converse360.in`, `api.converse360.in` |
| Platform → Website → Site URL | `https://app.converse360.in` |
| Business verification | Should already show verified from §3 |

> The app-level Data Deletion field takes **one** URL. Instagram has its *own*
> data-deletion field under its Business login settings (§5.2), so both get
> covered — but only if you fill both places.

### 4.3 Facebook Login for Business

Used by two things: the ads OAuth redirect and the Facebook Lead Ads JS SDK
popup.

- **Valid OAuth Redirect URIs** — add exactly:
  - `https://api.converse360.in/ads/oauth/callback`
  - `http://localhost:8001/ads/oauth/callback` (dev)
- **Allowed Domains for the JavaScript SDK**:
  - `app.converse360.in`
  - `http://localhost:3000` (dev)

> `GET /ads/oauth/config` echoes the exact redirect URI this server will send.
> **Copy from there, don't retype.** A mismatch produces "Invalid redirect_uri",
> which names neither the expected value nor where to fix it.

### 4.4 The WhatsApp webhook verify token

Set `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `apps/api/.env` to any random string
(`openssl rand -hex 16`) and paste the same value into the Meta dashboard.

Worth understanding why it exists, because the old behaviour looked fine until
the day it wasn't. The handshake originally loaded **every** `whatsapp_config`
row and matched the presented token against each account's own stored
`verify_token` — no app-level value at all. That fits the bring-your-own-Meta-app
model, where each customer configured their own webhook. **It does not fit Tech
Provider + Embedded Signup**, where the webhook is configured once at app level
and we subscribe our app to each customer's WABA afterwards.

The failure was a deadlock: on a fresh deployment with zero connected accounts,
you type a token into the Meta dashboard, Meta sends one GET handshake, no row
matches, we return 403, the dashboard refuses to save the webhook — so no
account can ever connect, so no row can ever exist.

`handleVerification()` now checks the app-level token first, in constant time,
and keeps the per-account walk as the fallback so legacy connections still
re-verify. The hardcoded `"simple"` bypass that used to sit at the bottom of
that function is gone.

---

## 5. Phase 2 — Configure each surface

### 5.1 WhatsApp — become a Tech Provider

This is the part your question called "tech provider steps." Meta's model:

- **Tech Provider** — you build on Cloud API and onboard customers via Embedded
  Signup. **Customers add their own payment method to their own WABA.** ← this
  is us.
- **Solution Partner (BSP)** — you hold a Meta line of credit and share it with
  customers, Meta bills you, you rebill. Not us, by decision.

Meta's own docs draw exactly that line: *"Solution Partners: must have an
existing line of credit and share it with customers during onboarding. Tech
Providers: customers must add their own payment method to their WABA before
messaging."*

Steps, in order:

1. **App Dashboard → WhatsApp → Set up.** This auto-provisions a **test WABA and
   test phone number** you can use immediately, before any review.
2. **Use cases → WhatsApp → Customize → Tech Provider onboarding.** This is
   where the Tech Provider configuration lives.
3. **Create the Embedded Signup configuration:**
   - Dashboard → **Facebook Login for Business → Configurations → Create from
     template** → *WhatsApp Embedded Signup Configuration*.
   - Choose which business assets the customer selects (WABA + phone number).
   - Products: **WhatsApp Cloud API**. Add *Marketing Messages Lite* only if you
     intend to support it — we don't today.
   - Permissions in the configuration: `whatsapp_business_management`,
     `whatsapp_business_messaging`.
   - **Copy the Configuration ID** → `NEXT_PUBLIC_FACEBOOK_CONFIG_ID`.
4. **Webhook** — App Dashboard → WhatsApp → Configuration → Webhook → Edit:
   - Callback URL: `https://api.converse360.in/whatsapp/webhook`
   - Verify token: the value from §4.4
   - **Subscribe:** `messages`, `message_template_status_update`,
     `business_capability_update`
   - A missing field fails silently — the feature simply never fires.
5. **App roles → Roles** — add teammates as Testers so they can walk the flow
   before Advanced Access.
6. Run the real "Connect with Facebook" button
   ([whatsapp-embedded-signup-button.tsx](../apps/web/src/components/settings/whatsapp-embedded-signup-button.tsx))
   end to end against the test number. **You cannot record the App Review video
   until this works.**

> `NEXT_PUBLIC_FACEBOOK_APP_ID` and `NEXT_PUBLIC_FACEBOOK_CONFIG_ID` are inlined
> at **build time**. Setting them in the running container does nothing — the web
> image must be rebuilt.

### 5.2 Instagram

App Dashboard → **Instagram → API setup with Instagram login**.

1. Record **Instagram app ID** → `INSTAGRAM_APP_ID` and **Instagram app secret**
   → `INSTAGRAM_APP_SECRET`. These are *not* the Settings → Basic values.
   Using `META_APP_SECRET` here rejects 100% of inbound webhooks with no symptom
   other than messages never arriving.
2. **Business login settings:**
   | Field | Value |
   |---|---|
   | OAuth Redirect URI | `https://api.converse360.in/instagram/connect/callback` |
   | Deauthorize callback URL | `https://api.converse360.in/instagram/deauthorize` |
   | Data Deletion Request URL | `https://api.converse360.in/instagram/data-deletion` |

   Must match `INSTAGRAM_REDIRECT_URI` **character for character**. A trailing
   slash gets a generic "couldn't be validated" that names nothing.
3. **Webhooks** — Callback `https://api.converse360.in/instagram/webhook`,
   verify token `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`. Subscribe: `messages`,
   `messaging_postbacks`, `messaging_seen`, `message_reactions`,
   `messaging_referral`, `comments`, `live_comments`, `mentions`.

   > The OAuth redirect URI and the webhook callback URL are different URLs.
   > Pasting the former into the Webhooks field is the most common setup mistake
   > here.
4. **App roles → Roles → Instagram Testers.** The invite must be accepted from
   inside the Instagram app (*Settings → Apps and websites → Tester invites*).
   Unaccepted behaves exactly like never added.

### 5.3 Facebook Lead Ads

Already built, and a **Page** subscription rather than a WABA or Instagram one.

- App Dashboard → **Webhooks → Page** → subscribe `leadgen`
- Callback URL: `https://api.converse360.in/webhooks/facebook-leads`
- Verify token: `FACEBOOK_WEBHOOK_VERIFY_TOKEN`
- Uses the JS SDK popup with `pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval`
  ([facebook-leads-config.tsx:181](../apps/web/src/components/settings/facebook-leads-config.tsx#L181))

> This surface still uses the Facebook JS SDK. The Ads Manager module
> deliberately does not — an ads token must never exist in page JavaScript, and
> `connect.facebook.net` is absent from the web app's CSP `script-src`
> (Report-Only today, which is the only reason this screen still works). Build
> nothing new on it.

### 5.4 Meta Ads Manager

- App Dashboard → **Add Product → Marketing API**
- App Settings → Basic → confirm **Data Deletion Request URL** =
  `https://api.converse360.in/ads/privacy/data-deletion`
- **Deauthorize Callback URL** = `https://api.converse360.in/ads/privacy/deauthorize`
- Redirect URI already added in §4.3

Set `META_ADS_REDIRECT_URI=https://api.converse360.in/ads/oauth/callback`.
Leave `META_ADS_APP_ID` / `META_ADS_APP_SECRET` **unset** — that is what makes
it the shared app.

> 🔧 **Follow-up worth doing.** Our ads consent URL is built with the legacy
> `scope=` parameter
> ([ads-connect.service.ts:112-124](../apps/api/src/ads/services/ads-connect.service.ts#L112-L124)).
> Meta's current guidance for Facebook Login for Business: *"config_id has
> replaced scope (although scope can still be included, we recommend that you do
> not use it)."* It works today. Creating a second FLB configuration for the ads
> scope bundle and passing its `config_id` is the supported path and gives the
> customer a cleaner asset-picker dialog. Not a launch blocker.

---

## 6. Phase 3 — Permissions and Advanced Access

Meta has two access levels per permission:

- **Standard Access** — granted automatically, but only works for users who
  **hold a role on your app**. Fine for development. Useless for customers.
- **Advanced Access** — works for any user. **Requires Business Verification,
  App Review, and an annual Data Use Checkup.**

Everything below needs Advanced Access before a single paying customer can
connect.

| Permission | Surface | Held? | What we do with it |
|---|---|---|---|
| `whatsapp_business_management` | WhatsApp | request | WABA settings, templates, phone registration |
| `whatsapp_business_messaging` | WhatsApp | request | Send and receive messages |
| `business_management` | WhatsApp + Ads | request | List the customer's portfolios and assets |
| `instagram_business_basic` | Instagram | request | Profile and account info |
| `instagram_business_manage_messages` | Instagram | request | Send/receive DMs |
| `instagram_business_manage_comments` | Instagram | request | Comment moderation, private replies |
| `pages_show_list` | Leads + Ads | request | Let the customer pick a Page |
| `pages_read_engagement` | Leads + Ads | request | Page name/avatar for previews |
| `pages_manage_metadata` | Leads | request | Subscribe the Page to `leadgen` |
| `pages_manage_ads` | Ads | request | Run ads from the Page; create lead forms |
| `leads_retrieval` | Leads | request | Pull lead-form submissions into the CRM |
| `ads_management` | Ads | request | Create/pause campaigns, ad sets, ads, creatives |
| `ads_read` | Ads | request | Insights and spend reporting |

Two things deliberately **not** requested at launch:

- **Instagram Human Agent** — extends the reply window from 24 hours to 7 days.
  Separate review with a higher bar. Ship with
  `INSTAGRAM_HUMAN_AGENT_ENABLED=false` and apply once you have live usage to
  show reviewers.
- `instagram_business_content_publish` — publishing is out of scope.

### Submit in this order

Permissions are reviewed **individually**, so a stalled one does not block the
others. But each submission needs its own screencast, and screencasts are where
cycles get lost. Sequence by revenue:

1. **WhatsApp** (`whatsapp_business_*`, `business_management`) — the product.
2. **Instagram** (`instagram_business_*`) — second channel.
3. **Pages + Lead Ads** (`pages_*`, `leads_retrieval`).
4. **Ads** (`ads_management`, `ads_read`, `pages_manage_ads`) — last, and see §7.

### What every submission needs

- **An uninterrupted, narrated screencast of the complete journey.** For
  WhatsApp: log into the CRM → click Connect WhatsApp → complete Embedded Signup
  → a customer sends a message → it appears in the inbox → an agent replies →
  it arrives on the phone. No cuts. Partial or vague videos are the top rejection
  reason.
- **Working test credentials** — a demo workspace with the channel already
  connected, so a reviewer who fails the connect step can still see the product.
- **A concrete per-permission use-case description.** *"Businesses using our CRM
  manage customer support conversations from Instagram Direct in a shared team
  inbox"* — not *"we need to read messages."* Draft text for the ads permissions
  is already written in [meta-ads-app-review.md §3](meta-ads-app-review.md).
- **Show one refusal.** Reviewers look for whether the app handles the unhappy
  path — a Page without the ADVERTISE task, a send outside the 24-hour window,
  a budget over the ceiling.
- Record with `ADS_MANAGER_SANDBOX=false`. A reviewer who spots `sandbox_act_1`
  in the recording will reject.

---

## 7. Phase 4 — Marketing API Access Tier (ads only, and it is a trap)

This is **separate from permission App Review**, and it is the longest pole in
the whole launch. Do not discover it after everything else is approved.

Meta renamed *Ads Management Standard Access* to **Marketing API Access Tier**
effective **4 May 2026**. Tier labels changed from Standard/Advanced to
**Limited / Full Access**.

- A new app starts at the limited tier: it can only call the Marketing API
  against **ad accounts you own or admin**. It **cannot manage a customer's ad
  account at all**.
- To reach Full Access, the app must demonstrate real usage:
  **at least 500 Marketing API calls in the past 15 days, with an error rate
  under 15% across the last 500 calls.**
- Requirements are now shown directly in App Dashboard → **Permissions &
  Features**. Screen recordings are no longer required for this specific
  feature.

**The consequence for sequencing:** you cannot satisfy the 500-call requirement
from fixtures. `ADS_MANAGER_SANDBOX=true` serves
[src/ads/sandbox/fixtures.ts](../apps/api/src/ads/sandbox/fixtures.ts) and makes
zero Graph calls. You need a real ad account, real traffic, and roughly two weeks
of it, *before* you can even apply.

Practical path:

1. Get `ads_management` / `ads_read` approved via normal App Review first.
2. Point the ads module at **your own** ad account with a small budget, sandbox
   off. The nightly insights sweep plus manual refreshes generate real calls.
3. Watch the error rate — `readRateLimitUsage` surfaces the current tier from the
   `x-ad-account-usage` response header, logged on every Graph response.
4. After 15 days above 500 clean calls, apply for Full Access in the dashboard.
5. Only then can a customer connect *their* ad account.

**Budget 4–8 weeks for the ads surface after everything else is live.** Launch
WhatsApp, Instagram and Lead Ads first; keep `ADS_MANAGER_ENABLED=false`.

---

## 8. Phase 5 — Go live

1. Business Verification approved (§3).
2. All permissions show **Advanced Access** in App Review → Permissions and
   Features.
3. Toggle the app from **Development** to **Live** at the top of the dashboard.
4. Set production env vars (§9) and rebuild — `NEXT_PUBLIC_*` is inlined at
   build time.
5. Deploy: `./scripts/deploy.sh`.
6. Verify every callback answers, using the curl block in
   [../deploy/WEBHOOKS.md](../deploy/WEBHOOKS.md#quick-verification). A **404**
   is a proxy problem; **502** means the container is down.
7. Roll out to **one friendly account first**. For ads specifically, the first
   real publish is the only true test of the Click-to-WhatsApp `promoted_object`
   shape and `destination_type` behaviour — both flagged unverified.

---

## 9. Credentials reference

Every Meta value the code reads, and where in the dashboard it comes from.

| Env var | Where | Notes |
|---|---|---|
| `META_APP_ID` | Settings → Basic → App ID | Needed for resumable media upload on image-header templates |
| `META_APP_SECRET` | Settings → Basic → App Secret | **Required.** WhatsApp webhook signature verification fails closed without it |
| `NEXT_PUBLIC_FACEBOOK_APP_ID` | Same App ID | Browser-exposed for the JS SDK. App IDs are not secret |
| `NEXT_PUBLIC_FACEBOOK_CONFIG_ID` | FLB → Configurations → the Embedded Signup config | Button stays disabled without it |
| `INSTAGRAM_APP_ID` | Instagram → API setup with Instagram login | ⚠️ Not the Settings → Basic App ID |
| `INSTAGRAM_APP_SECRET` | Same section | ⚠️ Not `META_APP_SECRET`. Signs IG webhooks |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | You invent it | `openssl rand -hex 16`. Must match the dashboard exactly |
| `INSTAGRAM_REDIRECT_URI` | You set it | Must match Business login settings character for character |
| `INSTAGRAM_API_VERSION` | `v23.0` | Pinned so a deprecation is a config change, not a deploy |
| `INSTAGRAM_HUMAN_AGENT_ENABLED` | `false` | Flip only after separate approval |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | You invent it | Lead Ads `leadgen` handshake |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | You invent it | App-level WhatsApp handshake. **Required** for Embedded Signup — see §4.4 |
| `META_ADS_APP_ID` / `_SECRET` | — | **Leave unset** to share the main app |
| `META_ADS_REDIRECT_URI` | You set it | Must match FLB → Valid OAuth Redirect URIs exactly |
| `ADS_MANAGER_ENABLED` | `false` until §7 | API-side gate; `AdsEnabledGuard` 404s every `/ads/*` route |
| `ADS_MANAGER_SANDBOX` | `false` for review | Fixtures instead of Meta |
| `NEXT_PUBLIC_ADS_MANAGER_ENABLED` | `false` until §7 | Web-side courtesy hide. The API guard is the real gate |
| `ADS_MAX_DAILY_BUDGET_MINOR` | Pick a real number | Minor units. A missed conversion is a 100× overspend on a live card |
| `ENCRYPTION_KEY` | Yours, 64 hex chars | ⚠️ **Never rotate.** Every stored WhatsApp token, verify token, Instagram token and ads token is encrypted under it |

Three Graph version pins, one per surface, all deliberate:
`v21.0` WhatsApp Cloud API · `v20.0` Facebook Pages/lead-gen ·
`v23.0` Marketing API and `graph.instagram.com`.

---

## 10. Every URL to paste into the dashboard

All on `api.converse360.in` — third-party servers call them, so they cannot go
through the app's `/api/*` proxy.

| Dashboard field | URL |
|---|---|
| WhatsApp → Configuration → Webhook | `https://api.converse360.in/whatsapp/webhook` |
| Instagram → Webhooks → Callback URL | `https://api.converse360.in/instagram/webhook` |
| Instagram → Business login → OAuth Redirect URI | `https://api.converse360.in/instagram/connect/callback` |
| Instagram → Business login → Deauthorize | `https://api.converse360.in/instagram/deauthorize` |
| Instagram → Business login → Data Deletion | `https://api.converse360.in/instagram/data-deletion` |
| Webhooks → Page → `leadgen` | `https://api.converse360.in/webhooks/facebook-leads` |
| FLB → Valid OAuth Redirect URIs | `https://api.converse360.in/ads/oauth/callback` |
| Settings → Basic → Data Deletion Request URL | `https://api.converse360.in/ads/privacy/data-deletion` |
| Settings → Basic → Deauthorize Callback URL | `https://api.converse360.in/ads/privacy/deauthorize` |
| Settings → Basic → Privacy Policy | `https://converse360.in/privacy` |
| Settings → Basic → Terms of Service | `https://converse360.in/terms` |
| FLB → Allowed Domains for the JS SDK | `app.converse360.in` |

Also not a Meta field but it silently breaks auth if missed — Supabase →
Authentication → URL Configuration: Site URL `https://app.converse360.in`,
Redirect URLs `https://app.converse360.in/**`.

---

## 11. How a customer connects each channel

What the business actually does, and what has to be true on their side first.

### WhatsApp — Embedded Signup

**They need:** a Facebook account, a business, and a phone number that is **not
currently registered on the WhatsApp consumer or Business app** (or they must
delete that account first, losing its chat history). The number must be able to
receive an SMS or voice call.

1. Settings → Channels → WhatsApp → **Connect with Facebook**.
2. A Facebook popup opens (JS SDK, `config_id` flow). They log in with Facebook.
3. They pick or create a **Business Portfolio**, then a **WhatsApp Business
   Account**, then add a **phone number**.
4. They verify the number by SMS/call inside the popup.
5. They accept Meta's terms in the dialog.
6. Popup posts `WA_EMBEDDED_SIGNUP` back with the WABA id and phone number id;
   the SDK callback returns an authorization code.
7. Our server exchanges the code for a customer-scoped token, **registers the
   phone number** for Cloud API, and **subscribes our app to their WABA**.
8. ⚠️ **They then add a payment method to their WABA** in Meta Business Settings.
   Under the Tech Provider model this is on them, and until it's done they can
   receive messages but business-initiated conversations fail. **Our onboarding
   must tell them this explicitly** — otherwise it reads as our bug.

New WABAs start at **messaging tier 1** — 1,000 business-initiated conversations
per 24h. `BROADCAST_SEND_RATE_MAX=10` defaults to that ceiling.

### Instagram — Business Login

**They need:** an Instagram **Professional** account (Business or Creator —
personal accounts cannot use the messaging API at all), and **Settings →
Messages and story replies → Message controls → Allow access to messages = ON**.

> If that toggle is off, webhooks silently never fire. No error, anywhere. It is
> the number one cause of "my integration receives nothing."

No Facebook Page is required — that is the whole reason we chose the Instagram
Login surface over the Facebook Login one.

1. Settings → Channels → Instagram → **Connect**.
2. `GET /instagram/connect/start` returns the consent URL; the `state` is an
   HMAC over `{accountId, userId, nonce, exp}` so the callback can only ever
   write to the account that started it.
3. They approve on instagram.com.
4. Callback exchanges code → short-lived → 60-day token, reads the profile,
   **subscribes webhooks**, stores the token encrypted.

⚠️ **Tokens expire after exactly 60 days with no silent renewal.**
`InstagramTokenRefreshService` sweeps daily and renews anything within 10 days
of expiry. If that job stops, **every Instagram connection in the system dies 60
days later, all at once**, and each business must re-authorise by hand. Monitor
it.

### Facebook Lead Ads

**They need:** a Facebook Page they administer, with lead forms on it.

Settings → Integrations → Facebook → **Connect** → JS SDK popup → grant Pages +
`leads_retrieval` → pick which Pages to sync. We subscribe each selected Page to
`leadgen`; new submissions arrive as contacts.

### Meta Ads Manager

**They need:** a Business Portfolio, an ad account **with a funding source**, a
Facebook Page they hold the **ADVERTISE** task on, and — for Click-to-WhatsApp —
their WABA in the **same** Business Portfolio as the ad account.

1. Ads Manager → Setup → **Connect Facebook**.
2. Server-side redirect to Meta's OAuth dialog (no JS SDK — an ads token must
   never exist in page JavaScript). They grant the ads scopes.
3. Callback verifies the HMAC-signed `state`, exchanges the code, stores the
   connection as `pending_setup`.
4. They pick a business portfolio → ad account → Page → link the WhatsApp number
   → optionally a Pixel → accept lead-form terms.
5. The checklist reports *Ready to advertise* once `funding_ok` comes back true
   from Meta.

**Meta bills them directly.** There is no wallet, no ad-credit ledger, and no
money through us — do not add one without re-opening that decision.

---

## 12. Policy constraints to design around

Not configurable. Know them before someone promises a customer otherwise.

- **WhatsApp: 24-hour customer service window.** Outside it, only an approved
  template. Templates need Meta approval per template.
- **Instagram: 24-hour window and no templates at all.** There is therefore **no
  compliant way to run Instagram broadcasts**. This is why there is deliberately
  no Instagram broadcast endpoint. Do not let it get sold.
- **Instagram private replies:** one per comment, within 7 days.
- **Group threads and vanish-mode messages are never delivered** by the API.
- ⚠️ **WhatsApp AI policy, effective 15 January 2026.** Meta's revised Business
  Solution Terms **prohibit providers whose primary functionality is a
  general-purpose AI assistant or LLM** from using the WhatsApp Business
  Solution, and forbid using WhatsApp Business data to train or develop AI
  models — *including aggregated or anonymised data*. Structured,
  purpose-specific bots (support, bookings, order tracking, notifications,
  surveys) remain allowed.

  **Where we stand:** our AI agent is bring-your-own-key, scoped to the
  business's own knowledge base and tools, and the product is a CRM — squarely
  on the allowed side. **What to watch:** never market converse360 as "an AI
  assistant on WhatsApp," and never use customer message content to train
  anything. The framing in App Review and on the marketing site should lead with
  *CRM and shared inbox*, with AI as a feature. Non-compliance is API
  restriction or account suspension, not a warning.
- **Annual Data Use Checkup.** An overdue one blocks App Review and can cost
  Advanced Access on a live app. Diarise it.

---

## 13. Sequencing

Run these in parallel, not in series. The three Meta queues below are
independent and none of them are fast.

| Week | Work |
|---|---|
| **0** | Start **Business Verification** (§3). Fill the placeholders in `privacy.html` / `terms.html` and get them lawyer-read (§2). Create the app and add all four use cases (§4). |
| **0–1** | Configure all four surfaces (§5) against test assets. Walk each connect flow end to end. |
| **1–2** | Record screencasts. **Submit WhatsApp App Review.** Verification should be back by now — if it isn't, that is your blocker, not the code. |
| **2–3** | Submit Instagram, then Pages + Lead Ads. Expect one rejection round somewhere; budget for it. |
| **3–4** | WhatsApp approved → app to **Live mode** → first friendly customer. Instagram follows. |
| **4–6** | Submit ads permissions. Run our own ad account against real Meta to accrue the 500 calls. |
| **6–10** | Apply for **Marketing API Full Access** (§7). Only then flip `ADS_MANAGER_ENABLED=true`. |

Realistic total: **WhatsApp live in 3–4 weeks, ads live in 8–10.** The variance
is almost entirely Business Verification and screencast quality — neither is a
code problem.

---

## Sources

Meta documentation consulted August 2026:

- [Create an App](https://developers.facebook.com/docs/development/create-an-app/) — multiple use cases per app, and that use cases cannot be removed
- [Graph API Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels) — Standard vs Advanced, Business Verification requirement
- [WhatsApp Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup) — permissions, Tech Provider vs Solution Partner billing
- [Become a Tech Provider](https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers/) — ordered onboarding steps
- [Instagram Platform Overview](https://developers.facebook.com/docs/instagram-platform/overview/) — Instagram app ID lives inside the same Meta app
- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business) — `config_id` has replaced `scope`
- [Update to Ads Management Standard Access](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/) — Marketing API Access Tier, 4 May 2026, 500-call threshold
- [WhatsApp 2026 AI policy](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban) and [Digital Watch summary](https://dig.watch/updates/meta-changes-whatsapp-terms-to-block-third-party-ai-assistants) — Business Solution Terms, 15 January 2026
