# Launch checklist — from zero to a paying customer

Ordered, do-this-then-that. Every step is either a click in someone's dashboard
or a command in this repo.

Deep detail lives elsewhere and is linked per step:
[meta-platform-setup.md](meta-platform-setup.md) (Meta, in full) ·
[../deploy/README.md](../deploy/README.md) (proxy) ·
[../deploy/WEBHOOKS.md](../deploy/WEBHOOKS.md) (callback URLs) ·
[app-connections.md](app-connections.md) (Google) ·
[razorpay.md](razorpay.md) · [subscription-setup.md](subscription-setup.md).

Hostnames used throughout — substitute your own:

| Host | Serves | Container port |
|---|---|---|
| `converse360.in` | marketing site + `/privacy` + `/terms` | `127.0.0.1:3032` |
| `app.converse360.in` | dashboard, forms, booking, widget | `127.0.0.1:3031` |
| `api.converse360.in` | webhooks, OAuth callbacks, `v1` API | `127.0.0.1:8001` |

---

## Phase 0 — Start the slow queues today

These run in the background for weeks. Start them before you write a single env var.

### 0.1 Facebook personal account
- [ ] A real personal account, real name, **2FA on**. This human owns everything below.
- [ ] Not a fresh burner account — Meta distrusts them during verification.

### 0.2 Business Portfolio
- [ ] [business.facebook.com](https://business.facebook.com) → create a Business Portfolio.
- [ ] Name it the **legal entity name** on your incorporation document, not your brand name.

### 0.3 Business Verification ← the longest pole
- [ ] Business Settings → **Security Centre → Start Verification**.
- [ ] Supply legal name, registered address, business phone, website `https://converse360.in`.
- [ ] Upload **one document where the name and address match what you typed byte for byte** — Certificate of Incorporation, GST certificate, or a utility bill in the company name.
- [ ] Use an `@converse360.in` email. A `@gmail.com` contact slows this down.

**1–5 business days clean. Weeks if the document mismatches.** Nothing else can be granted Advanced Access until this passes.

### 0.4 Domain + email
- [ ] Buy the domain, point 3 A records at the server IP.
- [ ] Set up `support@` and `admin@` on the domain (Meta contacts you there).

### 0.5 Legal pages ← blocks App Review
- [ ] Replace **every `[BRACKETED]` placeholder** in `apps/site/privacy.html` and `apps/site/terms.html`: legal entity name, registered address, jurisdiction, grievance officer, refund policy, notice periods, hosting region. They currently render as orange dashed chips, publicly.
- [ ] Have a lawyer read both.
- [ ] ⚠️ The privacy policy promises messages and contacts are purged 90 days after cancellation. **Nothing in the codebase does that.** Either build the sweep job or soften the wording before you publish.

---

## Phase 1 — Server and proxy

### 1.1 Box
- [ ] VPS, Docker + Docker Compose installed.
- [ ] `git clone` this repo to `/root/whatsapp-crm`.

### 1.2 DNS
- [ ] `converse360.in`, `app.converse360.in`, `api.converse360.in` → server IP.

### 1.3 TLS
- [ ] `certbot --nginx -d converse360.in -d app.converse360.in -d api.converse360.in`

### 1.4 nginx — three vhosts, and three rules that only break in production

```nginx
# app host
client_max_body_size 32m;          # default 1m silently 413s every attachment

location /api/public/web/stream {   # widget SSE — nginx buffers it by default,
    proxy_pass http://127.0.0.1:3031;
    proxy_buffering off;            # chat then works locally and is minutes
    proxy_cache off;                # late in production, with nothing in any log
    proxy_read_timeout 1h;
}
```

- [ ] **Do NOT add a host-wide `add_header X-Frame-Options DENY` on the app host.** `next.config.ts` already denies framing everywhere except `/widget/*`; a host-wide header overrides that carve-out and the widget renders as a blank box on customer sites only.
- [ ] `client_max_body_size 12m;` on the api host.
- [ ] Pass `X-Forwarded-For` on both (rate-limit bucketing).
- [ ] api host: `proxy_request_buffering off;` — Stripe signs the raw body.

Full config notes: [deploy/README.md](../deploy/README.md).

---

## Phase 2 — Supabase

### 2.1 Project
- [ ] Create the project. **Pick the region you will name as the hosting region in the privacy policy.**
- [ ] Project Settings → API → copy **Project URL**, **anon key**, **service_role key**.

### 2.2 The Prisma role
- [ ] SQL Editor → paste `packages/database/prisma/bootstrap-role.sql`, replacing `REPLACE_WITH_A_GENERATED_PASSWORD` with `openssl rand -hex 24`. Run it.
- [ ] Build the connection string — **session pooler, port 5432**, not 6543:

```
DATABASE_URL="postgres://prisma.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres?connection_limit=10"
```

### 2.3 Migrations — all 90, in order
Put `DATABASE_URL` into `apps/api/.env` first; the script reads it from there and strips the Prisma-only query params psql rejects.

```bash
for f in supabase/migrations/*.sql; do
  ./scripts/apply-migration.sh "$(basename "$f" .sql)" || break
done
```

- [ ] Every migration is idempotent, so re-running is safe. `ON_ERROR_STOP` halts on the first failure rather than half-migrating.
- [ ] Storage buckets (`avatars`, `flow-media`, `chat-media`, `workspace-logos`, `media-library`, …) are created **by the migrations** — nothing to click.
- [ ] Verify the two extensions that fail silently:

```sql
select extname from pg_extension where extname in ('vector','btree_gist');
```

`vector` missing → AI semantic search degrades to keyword only.
`btree_gist` missing → **the double-booking constraint is not created and bookings become racy, with nothing reporting a problem.**

- [ ] `npm run db:generate` at the repo root.

### 2.4 Auth URLs ← silently breaks every email link if missed
Authentication → URL Configuration:

| Field | Value |
|---|---|
| Site URL | `https://app.converse360.in` |
| Redirect URLs | `https://app.converse360.in/**` |

### 2.5 Sign in with Google (optional)
No env var — dashboard only.
- [ ] Google Cloud → Auth Platform → Clients → **Web client**. Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
- [ ] Google Cloud → Data Access → add the `openid` scope **manually** (email and profile are on by default).
- [ ] Supabase → Authentication → Providers → Google → paste client id + secret, enable.

---

## Phase 3 — Generate your own secrets

Do this once, write them into a password manager, then into the env files.

| Value | Command | Rule |
|---|---|---|
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | **Never rotate.** Every stored WhatsApp, Instagram and ads token is encrypted under it. Identical in api **and** web. |
| `INTERNAL_API_SECRET` | `openssl rand -hex 32` | Identical in api and web. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `openssl rand -hex 16` | Must match the Meta dashboard field exactly. |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | `openssl rand -hex 16` | Same. |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | `openssl rand -hex 16` | Same. |
| `WEB_IP_HASH_SALT` | `openssl rand -hex 32` | **Never rotate** — invalidates every stored visitor hash. |
| `CONNECTIONS_STATE_SECRET` | `openssl rand -hex 32` | Its own secret, never shared with Instagram or Ads. |
| `ADMIN_SESSION_SECRET` | `openssl rand -base64 48` | Rotating = log every admin out. |
| `ADMIN_PASSWORD` | long passphrase | Never reuse a CRM password. |
| `QUEUE_DASHBOARD_PASSWORD` | `openssl rand -hex 24` | Bull Board shows every tenant's job payloads. |

---

## Phase 4 — The Meta app

**Create ONE app for all four surfaces.** Not three.
IGSIDs are app-scoped: move Instagram to a different app later and every stored Instagram identity is garbage. That is irreversible — decide now. Reasoning in [meta-platform-setup.md §0](meta-platform-setup.md).

> ⚠️ **Use cases cannot be removed from an app after creation.** Add deliberately.

### 4.1 Create
[developers.facebook.com](https://developers.facebook.com) → My Apps → Create App.

| Field | Value |
|---|---|
| App name | `Converse360` — customers see this in the consent dialog |
| Contact email | `support@converse360.in` |
| First use case | **WhatsApp** |
| Business portfolio | the verified one from §0.2 |
| App type | must resolve to **Business** (a Consumer app cannot request `ads_management` at all) |

- [ ] Dashboard → Use cases → Add: **Instagram** (choose *API setup with Instagram login*, **not** *with Facebook login*), **Marketing API**, **Facebook Login for Business**.

### 4.2 Settings → Basic — fill every field
A blank here costs a full review cycle.

| Field | Value |
|---|---|
| App Icon | 1024×1024 PNG, no transparency |
| Category | Business and Pages |
| Privacy Policy URL | `https://converse360.in/privacy` |
| Terms of Service URL | `https://converse360.in/terms` |
| Data Deletion Request URL | `https://api.converse360.in/ads/privacy/data-deletion` |
| Deauthorize Callback URL | `https://api.converse360.in/ads/privacy/deauthorize` |
| App Domains | `converse360.in`, `app.converse360.in`, `api.converse360.in` |
| Platform → Website → Site URL | `https://app.converse360.in` |

- [ ] Copy **App ID** → `META_APP_ID` and `NEXT_PUBLIC_FACEBOOK_APP_ID`.
- [ ] Copy **App Secret** → `META_APP_SECRET`.

### 4.3 WhatsApp — Tech Provider
You are a **Tech Provider**, not a Solution Partner: customers add their own payment method to their own WABA and Meta bills them directly. You never hold a credit line.

1. [ ] Dashboard → **WhatsApp → Set up**. This auto-provisions a test WABA + test phone number you can use immediately.
2. [ ] Use cases → WhatsApp → Customize → **Tech Provider onboarding**.
3. [ ] **Facebook Login for Business → Configurations → Create from template → *WhatsApp Embedded Signup Configuration***.
   - Assets the customer picks: WABA + phone number.
   - Product: **WhatsApp Cloud API**.
   - Permissions: `whatsapp_business_management`, `whatsapp_business_messaging`.
   - [ ] Copy the **Configuration ID** → `NEXT_PUBLIC_FACEBOOK_CONFIG_ID`.
4. [ ] WhatsApp → Configuration → Webhook → Edit:
   - Callback: `https://api.converse360.in/whatsapp/webhook`
   - Verify token: your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - Subscribe: **`messages`**, **`message_template_status_update`**, **`business_capability_update`**
   - A missing field fails silently — the feature just never fires.

> ⚠️ Without `WHATSAPP_WEBHOOK_VERIFY_TOKEN` set on the server **first**, a fresh deployment deadlocks: zero connected accounts means no per-account token to match, the handshake 403s, the dashboard refuses to save the webhook, so no account can ever connect.

### 4.4 Instagram
Dashboard → **Instagram → API setup with Instagram login**.

- [ ] Copy **Instagram app ID** → `INSTAGRAM_APP_ID` and **Instagram app secret** → `INSTAGRAM_APP_SECRET`.
  ⚠️ These are **not** the Settings → Basic values. Meta signs Instagram webhooks with the Instagram secret — using `META_APP_SECRET` rejects 100% of inbound webhooks, with no symptom other than messages never arriving.
- [ ] Business login settings:

| Field | Value |
|---|---|
| OAuth Redirect URI | `https://api.converse360.in/instagram/connect/callback` |
| Deauthorize callback | `https://api.converse360.in/instagram/deauthorize` |
| Data Deletion Request | `https://api.converse360.in/instagram/data-deletion` |

  Must match `INSTAGRAM_REDIRECT_URI` **character for character** — a trailing slash gets a generic "couldn't be validated" that names nothing.
- [ ] Webhooks → Callback `https://api.converse360.in/instagram/webhook`, verify token = `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`. Subscribe: `messages`, `messaging_postbacks`, `messaging_seen`, `message_reactions`, `messaging_referral`, `comments`, `live_comments`, `mentions`.
  > The OAuth redirect URI and the webhook callback are **different URLs**. Pasting the former into the Webhooks field is the most common mistake here.
- [ ] App roles → **Instagram Testers**. The invite must be accepted from inside the Instagram app (Settings → Apps and websites → Tester invites). Unaccepted behaves exactly like never added.

### 4.5 Facebook Login for Business
- [ ] Valid OAuth Redirect URIs: `https://api.converse360.in/ads/oauth/callback` (+ `http://localhost:8001/ads/oauth/callback` for dev).
- [ ] Allowed Domains for the JS SDK: `app.converse360.in` (+ `http://localhost:3000`).
- [ ] `GET /ads/oauth/config` echoes the exact redirect URI this server sends — **copy from there, don't retype**.

### 4.6 Facebook Lead Ads
- [ ] Dashboard → **Webhooks → Page** → subscribe `leadgen`.
- [ ] Callback: `https://api.converse360.in/webhooks/facebook-leads`, verify token = `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.

### 4.7 Ads Manager — defer
- [ ] Add Product → Marketing API now, but leave `ADS_MANAGER_ENABLED=false`. See Phase 9.

### 4.8 App roles
- [ ] Add teammates as **Testers** so they can walk every connect flow before Advanced Access exists.

---

## Phase 5 — Every URL to paste, in one place

All on the **api** host — third parties call them, so they cannot go through the app's `/api/*` proxy.

| Dashboard field | URL |
|---|---|
| WhatsApp → Configuration → Webhook | `https://api.converse360.in/whatsapp/webhook` |
| Instagram → Webhooks → Callback | `https://api.converse360.in/instagram/webhook` |
| Instagram → Business login → OAuth Redirect | `https://api.converse360.in/instagram/connect/callback` |
| Instagram → Business login → Deauthorize | `https://api.converse360.in/instagram/deauthorize` |
| Instagram → Business login → Data Deletion | `https://api.converse360.in/instagram/data-deletion` |
| Webhooks → Page → `leadgen` | `https://api.converse360.in/webhooks/facebook-leads` |
| FLB → Valid OAuth Redirect URIs | `https://api.converse360.in/ads/oauth/callback` |
| Settings → Basic → Data Deletion | `https://api.converse360.in/ads/privacy/data-deletion` |
| Settings → Basic → Deauthorize | `https://api.converse360.in/ads/privacy/deauthorize` |
| Settings → Basic → Privacy Policy | `https://converse360.in/privacy` |
| Settings → Basic → Terms of Service | `https://converse360.in/terms` |
| Razorpay → Settings → Webhooks | `https://api.converse360.in/webhooks/razorpay` |
| Stripe → Developers → Webhooks | `https://api.converse360.in/webhooks/stripe` |
| Google Cloud → Authorised redirect URI | `https://app.converse360.in/api/connections/oauth/callback` |
| Supabase → Auth → URL Configuration | Site `https://app.converse360.in`, redirect `https://app.converse360.in/**` |

---

## Phase 6 — Other services

### 6.1 Razorpay (India) — [razorpay.md](razorpay.md)
- [ ] Dashboard → API Keys → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. The key **id** also goes in web as `NEXT_PUBLIC_RAZORPAY_KEY_ID`.
- [ ] Settings → Webhooks → `https://api.converse360.in/webhooks/razorpay`, secret → `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Events, exactly: `order.paid`, `payment.authorized`, `payment.captured`, `subscription.activated`, `subscription.authenticated`, `subscription.updated`, `subscription.cancelled`.

### 6.2 Stripe (optional, non-IN)
- [ ] `STRIPE_SECRET_KEY`; webhook `https://api.converse360.in/webhooks/stripe` → `STRIPE_WEBHOOK_SECRET`.
- [ ] Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.

### 6.3 Plans
- [ ] Migration 044 seeds STARTER / GROWTH / ENTERPRISE (FREE is retired by 066). Set real prices in the **admin panel** — `SubscriptionService.listSelectablePlans()` reads the table live, so a price edit needs no deploy.

### 6.4 Google app connections (Sheets / Gmail / Calendar / Meet) — [app-connections.md](app-connections.md)
- [ ] A **separate Google Cloud project** from the Supabase login one. Verification, scopes and quotas are per-project; a Workspace-scope review must not be able to block your login button.
- [ ] Credentials → OAuth client ID → **Web application**. Leave *Authorised JavaScript origins* **empty** — server-side redirect flow only.
- [ ] Authorised redirect URI: `https://app.converse360.in/api/connections/oauth/callback` → `GOOGLE_OAUTH_REDIRECT_URI` (exact match, no trailing slash).
- [ ] Scopes are fixed in code and every one is **sensitive, never restricted**. Do not add `gmail.compose` or any Drive scope — that triggers an annual paid CASA assessment.

### 6.5 Built-in AI credits (optional)
- [ ] Google AI Studio key → `AI_PLATFORM_GEMINI_KEY`. Leave unset and the product simply falls back to bring-your-own-key; nothing breaks.
- [ ] Keep `AI_PLATFORM_MODEL=gemini-3.5-flash-lite` — one key serves every platform workspace, so a low RPM tier makes one busy tenant an outage for all of them.

---

## Phase 7 — Env files

### `apps/api/.env`

```bash
# Core
DATABASE_URL=postgres://prisma.<ref>:<pw>@<region>.pooler.supabase.com:5432/postgres?connection_limit=10
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_ALG=ES256
ENCRYPTION_KEY=            # 64 hex, identical to web
INTERNAL_API_SECRET=       # identical to web
REDIS_URL=redis://redis:6379   # NOT localhost — that is the container itself
NODE_ENV=production
PORT=8001

# Public URLs
PUBLIC_APP_URL=https://app.converse360.in
NEXT_PUBLIC_SITE_URL=https://app.converse360.in   # invite links — NOT the marketing domain

# Widget
WEB_IP_HASH_SALT=
WEB_WIDGET_TRUST_LOCALHOST=false

# Meta
META_APP_ID=
META_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=
INSTAGRAM_REDIRECT_URI=https://api.converse360.in/instagram/connect/callback
INSTAGRAM_API_VERSION=v23.0
INSTAGRAM_HUMAN_AGENT_ENABLED=false
FACEBOOK_WEBHOOK_VERIFY_TOKEN=

# Ads — off until Phase 9
ADS_MANAGER_ENABLED=false
ADS_MANAGER_SANDBOX=false
META_ADS_REDIRECT_URI=https://api.converse360.in/ads/oauth/callback
ADS_MAX_DAILY_BUDGET_MINOR=1000000
# META_ADS_APP_ID / _SECRET left UNSET — that is what shares the main app

# Billing
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# AI (optional)
AI_PLATFORM_GEMINI_KEY=
AI_PLATFORM_MODEL=gemini-3.5-flash-lite
AI_PLATFORM_EMBEDDINGS_MODEL=gemini-embedding-001
AI_SIGNUP_GRANT_CREDITS=250

# Google connections (optional)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://app.converse360.in/api/connections/oauth/callback
CONNECTIONS_STATE_SECRET=

# Ops
QUEUE_DASHBOARD_USER=ops
QUEUE_DASHBOARD_PASSWORD=
```

### `apps/web/.env.local`

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ENCRYPTION_KEY=              # identical to api
INTERNAL_API_SECRET=         # identical to api
META_APP_SECRET=
META_APP_ID=
NEXT_PUBLIC_SITE_URL=https://app.converse360.in
NEXT_PUBLIC_APP_LOCALE=en
NEXT_PUBLIC_FACEBOOK_APP_ID=
NEXT_PUBLIC_FACEBOOK_CONFIG_ID=
NEXT_PUBLIC_RAZORPAY_KEY_ID=
NEXT_PUBLIC_ADS_MANAGER_ENABLED=false
# Do NOT set NEST_API_URL — docker-compose injects http://api:8001, which keeps
# the rewrite inside the compose network. Setting it publicly routes internal
# calls out to the internet and back.
```

### `apps/admin-panel/.env.local`

```bash
ADMIN_USERNAME=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
DATABASE_URL=                # same string as apps/api/.env
ADMIN_CURRENCY=INR
```

> ⚠️ **`NEXT_PUBLIC_*` is inlined at build time.** Setting one in a running container does nothing. Rebuild — `docker compose up -d --build`, never `restart`.

---

## Phase 8 — Deploy and verify

```bash
./scripts/deploy.sh            # checks, push, pull, rebuild, verify
ss -tlnp | grep -E '3031|3032|8001'   # want 127.0.0.1 on all three
```

Then confirm every callback answers **before** pasting it into a dashboard, and again after. A 404 is a proxy problem, a 502 is a container down, and neither looks different from a typo.

```bash
# Legal + public status pages — expect 200 ×4
for u in https://converse360.in/privacy https://converse360.in/terms \
         https://app.converse360.in/instagram-data-deletion \
         https://app.converse360.in/ads-data-deletion; do
  curl -so /dev/null -w "$u %{http_code}\n" "$u"
done

# Webhook handshakes — 403 = reachable and correctly refusing a wrong token.
# 404 = not proxied at all.
for p in whatsapp/webhook instagram/webhook webhooks/facebook-leads; do
  curl -so /dev/null -w "$p %{http_code}\n" \
    "https://api.converse360.in/$p?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"
done

# Privacy callbacks — 400 = reachable and demanding a signed_request
for p in instagram/deauthorize instagram/data-deletion \
         ads/privacy/data-deletion ads/privacy/deauthorize; do
  curl -so /dev/null -w "$p %{http_code}\n" -X POST "https://api.converse360.in/$p"
done

# The real handshake, with your token — expect ok123
curl -s "https://api.converse360.in/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_WEBHOOK_VERIFY_TOKEN&hub.challenge=ok123"

# Widget framing — the check that catches the most likely breakage
curl -sI https://app.converse360.in/widget/v1/frame | grep -i x-frame-options   # want NOTHING
curl -sI https://app.converse360.in/login           | grep -i x-frame-options   # want DENY

curl -s https://api.converse360.in/health
```

- [ ] Sign up, complete `/welcome`, land in the dashboard.
- [ ] Channels → Web → Channel Settings → **add `converse360.in` to Allowed domains**. An empty allowlist denies everything, so the widget won't load on your own site until you do.
- [ ] Run **Connect with Facebook** end to end against the test WABA. **You cannot record the App Review video until this works.**

---

## Phase 9 — App Review

Two access levels per permission. **Standard** is automatic but only works for users holding a role on your app — useless for customers. **Advanced** works for anyone and needs Business Verification + App Review + an annual Data Use Checkup.

Request these:

| Permission | Surface |
|---|---|
| `whatsapp_business_management`, `whatsapp_business_messaging` | WhatsApp |
| `business_management` | WhatsApp + Ads |
| `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments` | Instagram |
| `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` | Leads |
| `leads_retrieval` | Leads |
| `pages_manage_ads`, `ads_management`, `ads_read` | Ads |

Not at launch: **Instagram Human Agent** (separate, higher-bar review — ship with `INSTAGRAM_HUMAN_AGENT_ENABLED=false`) and `instagram_business_content_publish`.

**Submit in revenue order** — permissions are reviewed individually, so a stall doesn't block the rest:
1. WhatsApp → 2. Instagram → 3. Pages + Lead Ads → 4. Ads.

Each submission needs:
- [ ] **One uninterrupted narrated screencast of the whole journey.** WhatsApp: log in → Connect WhatsApp → complete Embedded Signup → customer sends a message → it appears in the inbox → agent replies → it arrives on the phone. **No cuts.** Vague or partial video is the top rejection reason.
- [ ] Working test credentials — a demo workspace with the channel already connected.
- [ ] A concrete per-permission use case. *"Businesses manage support conversations from Instagram Direct in a shared team inbox"* — not *"we need to read messages."*
- [ ] **Show one refusal** — a Page without the ADVERTISE task, a send outside the 24-hour window. Reviewers look for the unhappy path.
- [ ] Record with `ADS_MANAGER_SANDBOX=false`. A reviewer who spots `sandbox_act_1` will reject.

### The ads trap — Marketing API Access Tier
Separate from permission review, and the longest pole overall.

- A new app is at the **limited** tier: it can only call the Marketing API against ad accounts **you** own. It cannot touch a customer's ad account at all.
- Full Access needs **≥500 Marketing API calls in the past 15 days, error rate under 15% across the last 500.**
- **You cannot satisfy that from fixtures.** `ADS_MANAGER_SANDBOX=true` makes zero Graph calls.

Path: get `ads_management`/`ads_read` approved → point the module at **your own** ad account with a small real budget, sandbox off → accrue calls for 15+ days → apply for Full Access → only then can a customer connect their ad account. **Budget 4–8 weeks after everything else is live.**

---

## Phase 10 — Go live

1. [ ] Business Verification approved.
2. [ ] All permissions show **Advanced Access**.
3. [ ] Toggle the app **Development → Live**.
4. [ ] Set production env vars and **rebuild** (`NEXT_PUBLIC_*` is inlined at build time).
5. [ ] `./scripts/deploy.sh`
6. [ ] Re-run every curl in Phase 8.
7. [ ] Roll out to **one friendly account first**.

---

## What a customer has to do on their side

**WhatsApp** — a Facebook account, a business, and a phone number **not currently registered on the WhatsApp consumer or Business app**. They complete Embedded Signup, then ⚠️ **must add a payment method to their own WABA** in Meta Business Settings. Until they do, they can receive messages but every business-initiated conversation fails — and it reads as our bug. Say so in onboarding. New WABAs start at **tier 1**: 1,000 business-initiated conversations per 24h, which is what `BROADCAST_SEND_RATE_MAX=10` defaults to.

**Instagram** — a **Professional** (Business or Creator) account, and **Settings → Messages and story replies → Message controls → Allow access to messages = ON**. If that toggle is off, webhooks silently never fire, with no error anywhere. It is the number one cause of "my integration receives nothing." No Facebook Page needed.

**Lead Ads** — a Facebook Page they administer, with lead forms on it.

**Ads** — a Business Portfolio, an ad account **with a funding source**, a Page they hold the **ADVERTISE** task on, and for Click-to-WhatsApp, their WABA in the **same** portfolio as the ad account.

---

## Policy limits — know these before someone sells past them

- **WhatsApp: 24-hour customer service window.** Outside it, only an approved template, approved per template.
- **Instagram: 24-hour window and no templates at all** → there is no compliant way to run Instagram broadcasts, which is why no such endpoint exists. Don't let it get sold.
- **Instagram private replies:** one per comment, within 7 days.
- **Group threads and vanish-mode messages are never delivered** by the API.
- ⚠️ **WhatsApp AI policy, 15 Jan 2026.** Meta prohibits providers whose *primary functionality* is a general-purpose AI assistant, and forbids using WhatsApp data to train models — including aggregated or anonymised. We're a CRM with AI as a feature, which is on the allowed side. **Never market this as "an AI assistant on WhatsApp."** Lead with *CRM and shared inbox* in App Review and on the site. Non-compliance is restriction or suspension, not a warning.
- **Annual Data Use Checkup.** Overdue blocks App Review and can cost Advanced Access on a live app. Diarise it.

---

## Ongoing, or it breaks later

- **Instagram tokens expire after exactly 60 days with no silent renewal.** `InstagramTokenRefreshService` sweeps daily and renews anything within 10 days of expiry. **If that job stops, every Instagram connection in the system dies 60 days later, all at once**, and each business must re-authorise by hand. Monitor it.
- **Redis runs with persistence off** (`--save '' --appendonly no`). A restart drops queued broadcasts, scheduled campaigns and pending automation waits. `BroadcastRecoveryService` re-enqueues unfinished broadcasts on boot; the rest is gone. Fine if understood, not fine by accident.
- **Never rotate `ENCRYPTION_KEY` or `WEB_IP_HASH_SALT`.**
- Watch three Graph version pins: `v21.0` WhatsApp Cloud API · `v20.0` Pages/lead-gen · `v23.0` Marketing API and `graph.instagram.com`.

---

## Realistic timeline

| Week | Work |
|---|---|
| **0** | Business Verification. Legal placeholders + lawyer. Create the app, add all four use cases. Server, Supabase, migrations, deploy. |
| **0–1** | Configure all four surfaces against test assets. Walk each connect flow end to end. |
| **1–2** | Record screencasts. Submit WhatsApp App Review. |
| **2–3** | Submit Instagram, then Pages + Lead Ads. **Budget for one rejection round.** |
| **3–4** | WhatsApp approved → Live mode → first friendly customer. |
| **4–6** | Submit ads permissions; run your own ad account to accrue the 500 calls. |
| **6–10** | Apply for Marketing API Full Access. Only then `ADS_MANAGER_ENABLED=true`. |

**WhatsApp live in 3–4 weeks; ads in 8–10.** The variance is Business Verification and screencast quality — neither is a code problem.
