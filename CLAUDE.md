@AGENTS.md

# Project Reference

> Living reference for AI agents working in this repo. The `@AGENTS.md` import above
> carries the **Next.js guidance** (this is a heavily-changed Next.js — read
> `apps/web/node_modules/next/dist/docs/` before writing web code). Keep this file
> accurate as the codebase evolves.

## What this is

`converse360` (dir: `wacrm`) — a **WhatsApp CRM** platform. It connects a business's
WhatsApp Business account (via the **Meta WhatsApp Cloud API**) and layers on contacts,
conversations/inbox, broadcasts/campaigns, deal pipelines, no-code **automations** and
**flows**, e-commerce, an AI assistant, and a public/partner API — all multi-tenant
(account-scoped) with subscription billing.

## Monorepo layout

npm workspaces + **Turborepo**. `packageManager: npm@10.9.7`.

```
apps/
  api/                 NestJS backend (REST). Port 8001.
  web/                 Next.js 16 frontend (React 19). Port 3000 (3031 in docker).
  admin-panel/         Next.js 16 internal billing admin. Port 3002 (3033 in docker).
  site/                Static marketing site (3032 in docker).
packages/
  typescript-config/   Shared tsconfig bases.
  database/            THE Prisma schema + migrations, shared by api and admin-panel.
supabase/migrations/   SQL migrations (Supabase-managed Postgres, auth + public schemas).
scripts/               run-migration.sh / run-migration.ts, deploy.sh.
docs/                  public-api.md, razorpay.md, subscription-setup.md.
notes/                 Reference material (e.g. the official Meta "WhatsApp Cloud API" Postman collection).
docker-compose.yml     redis + api + web + site + admin-panel.
turbo.json             Tasks: build, dev, lint, test, typecheck, generate.
```

## Commands (run from repo root unless noted)

| Task | Command |
|---|---|
| Dev (all) | `npm run dev` (turbo) |
| Build / lint / typecheck / test (all) | `npm run build` \| `lint` \| `typecheck` \| `test` |
| Format | `npm run format` (prettier) |
| API only | `cd apps/api && npm run dev` (nest watch) |
| API tests | `cd apps/api && npm test` (**vitest**) |
| Prisma | `npm run db:generate` \| `db:migrate` \| `db:push` \| `db:studio` |
| Web only | `cd apps/web && npm run dev` |
| Admin panel only | `npm run dev --workspace=admin-panel` |

Both apps test with **vitest** (not Jest). API lint = eslint + prettier; web lint = `eslint`.

`build` and `typecheck` depend on `^generate`, so a fresh clone generates the
Prisma client before compiling anything that needs it.

## Backend — `apps/api` (NestJS)

- **Entry** `src/main.ts`: `cookie-parser`, global `ValidationPipe({ whitelist: true, transform: true })`, listens on `PORT ?? 8001`. No global route prefix — controllers own their full path.
- **Feature modules** (`src/app.module.ts`): `prisma`, `common` (redis, rate-limit, security, messaging, phone), `queue` (BullMQ), `auth`, `health`, `automations`, `flows`, `v1`, `whatsapp`, `instagram`, `web`, `forms`, `account`, `integrations`, `ecommerce`, `campaigns`, `subscription`, `onboarding`, `ai`, `ads`.
- **Two API surfaces by controller prefix:**
  - `@Controller('v1/...')` — the **public/partner REST API** (`v1/me`, `v1/messages`, `v1/webhooks`, `v1/broadcasts`, `v1/contacts`, `v1/conversations`). Lives in `src/v1/{controllers,services,types,utils}`. See `docs/public-api.md`.
  - `@Controller('whatsapp/...')` — **internal dashboard/webhook** endpoints consumed by the web app.
- **Auth (`src/auth/guards`):**
  - `supabase-auth.guard.ts` — verifies **Supabase** JWTs from cookies using `jose` (JWKS via `SUPABASE_URL/.well-known/jwks.json`, or HS256 with `SUPABASE_JWT_SECRET`). Used by the dashboard/web surface.
  - `api-key.guard.ts` — `Bearer <api-key>` for the public `v1` API (see `ApiKey` model + `src/lib/api-keys/scopes`).
- **Queue:** `@nestjs/bullmq` + `ioredis` — see the dedicated section below.
- **Payments:** `stripe` and `razorpay` (Razorpay for IN — see `docs/razorpay.md`, `docs/subscription-setup.md`).
- **Config:** `@nestjs/config` global. Env-driven (`SUPABASE_*`, `REDIS_URL`, `DATABASE_URL`, Meta app creds, Stripe/Razorpay keys, etc.).

## Frontend — `apps/web` (Next.js 16, React 19)

⚠️ Next.js **16.2.6** — significant API/convention changes vs. older versions. **Read `apps/web/node_modules/next/dist/docs/` before writing web code** (per AGENTS.md).

- App Router: `src/app/(auth)`, `src/app/(dashboard)`, `join`, root `layout.tsx`/`page.tsx`.
- `src/{components,hooks,i18n,lib,types}`, `src/middleware.ts`.
- **Auth/data:** Supabase (`@supabase/ssr`, `@supabase/supabase-js`). Rate limiting via `@upstash/ratelimit` + `@upstash/redis`.
- **UI:** shadcn + `@base-ui/react`, Tailwind (`tailwind-merge`, `tw-animate-css`, `class-variance-authority`), `lucide-react`, `sonner`, `recharts`.
- **Flow builder:** `@xyflow/react` + `@dagrejs/dagre` (auto-layout); drag-and-drop via `@dnd-kit/*`.
- i18n: `next-intl`. Audio (voice notes): `opus-recorder`.

## Admin panel — `apps/admin-panel` (Next.js 16)

Internal billing panel: subscriber accounts, subscription amounts, sales, users. Port **3002**. See `apps/admin-panel/README.md`.

- **No new api endpoints** — reads/writes Postgres directly via Prisma (`@repo/database`). Nothing here calls `apps/api`.
- **Auth:** one env credential (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), timing-safe compare, HS256 JWT session cookie signed with `ADMIN_SESSION_SECRET`. `proxy.ts` is an optimistic redirect gate; `requireAdmin()` in `lib/auth.ts` is the real check and runs in every page **and every Server Action**.
- **Structure:** `app/(panel)/*` pages, `app/login`, `lib/{env,session,auth,prisma,format}.ts`, `lib/queries/*` (reads), `lib/actions/*` (writes), `components/{ui,chart,shell,subscriber,plans}`.
- ⚠️ **Money is derived, not recorded.** There is no payments/invoices table in this database — `user_subscriptions` has no amount column and no history. Every figure is `plan price × subscription`, so MRR/ARR/expected-collections are exact for *today* and historical revenue is unrecoverable (a price edit rewrites the past). The reasoning lives in `lib/queries/sql.ts`; read it before adding a revenue figure. Time series there count subscriptions, never money.
- `lib/format.ts` is `server-only` on purpose: `ADMIN_CURRENCY` is not public, so client components take pre-formatted strings.

## Database — Prisma + Postgres (Supabase)

- **`packages/database` (`@repo/database`) owns the only schema.** `prisma/schema.prisma`: `provider = postgresql`, **dual schema** `["auth", "public"]` (the `auth.*` models — `users`, `sessions`, `identities`, `mfa_*`, `sso_*`, `oauth_*` — are Supabase's managed auth schema; treat as read-mostly). `previewFeatures = ["partialIndexes"]`. Generator is `prisma-client-js`, so both apps import from `@prisma/client` as usual.
- Each app owns its own connection (lifecycles differ): `apps/api/src/prisma/prisma.service.ts` (Nest module) and `apps/admin-panel/lib/prisma.ts` (globalThis singleton). Both use `@prisma/adapter-pg` (`pg`).
- The CLI reads `DATABASE_URL` from `apps/api/.env` via `packages/database/prisma.config.ts`. Run `npm run db:generate` from the root after any schema edit.
- Migrations also tracked as raw SQL in `supabase/migrations/`.
- ⚠️ **Supabase Storage buckets are written from the BROWSER, not the API** (`avatars`, `flow-media` 016/020, `chat-media` 023, `workspace-logos` 071). The bucket's RLS policy is therefore the *only* gate on those writes — it must carry the authorization itself, including any role check. Account-scoped buckets all use the path convention `account-<account_id>/…` matched on the first folder segment, built in one place by `buildMediaPath()` (`apps/web/src/lib/storage/upload-media.ts`); a hand-rolled path is silently rejected. When such a URL is later persisted to a column, pin it to our own bucket *and* the caller's own folder server-side (`common/storage/workspace-logo.util.ts`) — a free-text URL that renders in every teammate's browser is a beacon.
- **Domain models (public):** `Account`/`Profile`/`ApiKey` (tenancy + access), `account_onboarding`/`plan_enquiries` (guided signup), `contacts`/`contact_*`/`tags`/`custom_fields`, `conversations`/`messages`/`message_reactions`/`message_templates`, `broadcasts`/`broadcast_recipients`/`campaign_schedules`, `pipelines`/`pipeline_stages`/`deals`, `Automation`/`AutomationStep`/`AutomationLog`/`AutomationPendingExecution`, `Flow`/`FlowNode`/`FlowRun`/`FlowRunEvent`/`flow_state`, `whatsapp_config`/`whatsapp_products`/`whatsapp_orders`, `ecommerce_*`, `ai_configs`/`ai_knowledge_documents`/`ai_knowledge_chunks`/`ai_agent_actions` (migration 069 — agent studio), `facebook_connections`/`facebook_pages`/`ctwa_campaigns`/`ctwa_clicks`/`retargeting_audiences`, `meta_ads_config`/`meta_ads_campaigns`/`meta_ads_adsets`/`meta_ads_ads`/`meta_ads_insights`/`meta_ads_media`/`meta_lead_forms`/`meta_ad_audiences`/`meta_ads_audit` (migration 068 — Ads Manager), `subscription_plans`/`user_subscriptions`/`usage_tracking`, `webhook_endpoints`, `notifications`.

## Auth & signup

- **Providers:** email+password and **Sign in with Google**, both through Supabase. `src/app/auth/callback/route.ts` is the single landing point for every Supabase redirect — it handles both `?code=` (PKCE, used by Google) and `?token_hash=&type=` (email confirmation / recovery). `?next=` is narrowed by `sanitizeNextPath` before use; it is attacker-controlled. Google needs no env var, only dashboard config (see `apps/web/.env.local.example`).
- **Server-side Supabase:** `src/lib/supabase/server.ts` (per-request, async `cookies()`). The browser client in `client.ts` stays a singleton.
- **`/welcome` is a hard gate.** Two mandatory steps — workspace name + qualification answers, then a plan. `DashboardShell`'s `AuthGate` calls `GET /api/onboarding` and bounces anywhere in the dashboard to `/welcome` until `step === 'done'`. The check is deliberately **not** in middleware (it would add a DB read to every request) and **fails open** (a broken endpoint must not lock out paying customers).
- ⚠️ **A plan belongs to the workspace, but `user_subscriptions` is keyed by user.** `OnboardingService` therefore always writes the subscription for `accounts.owner_user_id`, and records completion once per account in `account_onboarding` — otherwise every invited teammate would be asked to buy their own plan. Making subscriptions genuinely account-scoped is unfinished work that would touch the admin panel, both gateways and every webhook.
- **`/onboarding` (the page) is the channel-connect checklist, not the wizard.** Don't confuse it with the `/api/onboarding` endpoints, which serve `/welcome`.

## Plans & billing

- Selectable plans are **STARTER, GROWTH, ENTERPRISE**. **FREE is retired** (migration 066 set `is_active = false`); it survives only so historical rows can still resolve their `plan_id`. Nothing may offer it again — there is no free tier to downgrade to, so cancellation sets `status = 'cancelled'` and the gate sends the account back to the plan picker.
- `SubscriptionService.listSelectablePlans()` is the **one** source for the pricing page and the wizard, read live from the table so an admin-panel price edit needs no deploy. Enterprise sorts last explicitly: its `price_monthly` is 0 (meaning "quoted"), which a plain price-ascending sort would put first.
- Selecting a plan in the wizard starts its trial; no payment is taken. Checkout happens later from `/pricing`.
- ⚠️ **Enterprise is invisible to MRR.** Revenue is derived as `plan price × subscription` and there is no amount column, so a negotiated price lives only in `plan_enquiries` and contributes nothing to the admin panel's figures.
- **There is exactly ONE billing surface in the product: Settings → Plan & billing (`?tab=pricing`), and it is owner-only** (`ownerOnly` on `SectionMeta`/`PanelItem` — stricter than `adminOnly`, which admins also pass). `/pricing` is the checkout it hands off to. The old `/admin/subscriptions` page and the `subscription/admin/*` Nest controller are **deleted, not moved** — see below. Cross-tenant billing administration belongs to `apps/admin-panel`.
- `get_user_subscription()` is `SECURITY DEFINER` and therefore carries **its own authorization** (migration 067): a JWT caller may read only itself; a server connection (`auth.uid() IS NULL`, which is how apps/api connects) may read anyone. Any new SECURITY DEFINER RPC granted to `authenticated` needs the same guard — RLS is bypassed, so the function body is the only check left.

## Tenant-scoping traps (learned the hard way)

Two cross-tenant leaks shipped here before being removed; both share one shape, so check for it in any new code:

- **Prisma bypasses RLS.** `apps/api` connects as the database owner, so a `findMany()` without `where: { account_id }` returns *every tenant's* rows even though the equivalent browser query is correctly scoped by policy. The deleted `subscription/admin/users` endpoint was exactly this — `profile.findMany()`, no filter. Its sibling write endpoints took a `targetUserId` from the body and only checked that the caller was an admin *somewhere*, which let an admin of one workspace rewrite another's subscription.
- **`SECURITY DEFINER` RPCs bypass RLS too**, and `GRANT EXECUTE ... TO authenticated` means any signed-in user can call them with any argument. Authorization has to be inside the body.

The rule of thumb: *if a query runs through Prisma or a SECURITY DEFINER function, RLS is not protecting you — scope it yourself.*

## Meta WhatsApp Cloud API integration (core dependency)

The app is built on the **official Meta WhatsApp Cloud API** (`https://graph.facebook.com/<version>/...`, Bearer-token auth). `notes/WhatsApp Cloud API.postman_collection.json` is Meta's official collection and is a **superset reference** for endpoints — the code implements a subset of it.

- **Version pins — there are now THREE**, one per independent surface. Intentional (three upgrade risks rather than one shared one), but three things to keep current:
  | Surface | Version | Constant |
  |---|---|---|
  | WhatsApp Cloud API | `v21.0` | `META_API_BASE` in `src/whatsapp/meta-api.util.ts:21`, `whatsapp-templates.controller.ts:63` |
  | Facebook Pages / lead-gen | `v20.0` | inline in `src/integrations/controllers/facebook.controller.ts` |
  | Marketing API (Ads Manager) | `v23.0` | `META_MARKETING_VERSION` in `src/ads/marketing-api.util.ts` |
- **`src/whatsapp/meta-api.util.ts`** — thin fetch wrappers (each takes one named-options object): `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList` (+ shared `INTERACTIVE_LIMITS`), `sendProductMessage`/`sendProductListMessage`, `sendReactionMessage`, `verifyPhoneNumber`, `exchangeEmbeddedSignupCode`, `registerPhoneNumber`, `subscribeWabaToApp`/`getSubscribedApps`, `uploadResumableMedia`, `submit/edit/deleteMessageTemplate`, `getMediaUrl`/`downloadMedia`.
- **Also implemented across the module:** flows send (`flow-meta-send.service.ts`), template management (`controllers/whatsapp-templates.controller.ts`), media proxy (`controllers/whatsapp-media.controller.ts`), inbound webhook (`services/whatsapp-webhook.service.ts` — parses messages + delivery/read statuses), account connect/register (`services/connect-account.service.ts`).
- **In the Postman collection but NOT yet implemented:** outbound *mark-as-read* & *typing indicators*, QR codes, commerce settings, Payments API (SG/IN order messages), analytics, billing, block users, business compliance, deregister, business portfolio. (Read status is only *received* via webhook, not sent.)

## AI agent (`apps/api/src/ai`, `apps/web/src/app/(dashboard)/agents`)

**Bring-your-own-key.** The account's own OpenAI / Anthropic / **Google Gemini** key is
stored AES-256-GCM-encrypted and used to call the provider directly — no per-seat AI
fee, no conversation routed through a third party of ours. Everything below is
account-scoped configuration on `ai_configs` (one row per workspace).

- **One assembly, three entry points.** `AgentRuntimeService.assemble()` retrieves
  knowledge, gathers tools and composes the prompt; the inbox draft button, the
  playground and the auto-reply bot all call it. **Keep it that way** — a test panel
  that assembles differently from production teaches users to trust behaviour they
  will not get.
- **Prompt order is load-bearing** (`lib/defaults.ts`): role → safety → identity →
  what the business does → **ground rules** → voice → skills → tools → escalation →
  knowledge (last, so it is freshest when the model answers). Ground rules sit above
  skills deliberately: "never promise same-day delivery" must outrank anything a skill
  or a retrieved document implies. `ai_configs.system_prompt` is the pre-069 free-text
  field — still appended, never dropped, because older accounts have everything in it.
- **Skills are a registry** (`lib/skills.ts`), one entry each: a prompt fragment plus
  the built-in tools it unlocks. The row stores only `{enabled, config}` per id, so a
  new skill is one entry and zero migrations. Built-in tools (`lib/tools/builtin.ts`)
  read this database and are scoped to the account **and** the contact — `lookup_orders`
  must not become an order-lookup oracle for the tenant.
- **Custom API actions** (`ai_agent_actions`) are user-defined HTTP tools. The model
  supplies declared parameter VALUES only; endpoint, method and headers are what an
  admin configured, so a prompt-injected "call your action against evil.test" is not
  expressible. Headers are encrypted and never returned — the UI shows header *names*.
- ⚠️ **`lib/http-guard.ts` is the SSRF boundary** for the two features that fetch a
  user-supplied URL (page crawling, custom actions): scheme allowlist, no credentials
  in the URL, every resolved address must be publicly routable, redirects followed
  manually and re-validated each hop, response bytes capped. Loosening any of it is a
  security change, not a refactor. Known residual: DNS rebinding (documented in-file).
- ⚠️ **Embedding vectors are model-specific.** `ai_knowledge_chunks.embedding` is
  `vector(1536)`, so every provider must emit exactly 1536 dims (Gemini's 3072-dim
  model is asked for 1536 and re-normalised). Each chunk records `embedding_model` and
  retrieval filters on the account's current one, so switching provider degrades to
  keyword search and prompts a reindex rather than returning confident nonsense.
- ⚠️ **Gemini specifics** (`lib/providers/gemini.ts`, verified against the live API):
  assistant role is `model`; the system prompt is `system_instruction`; the key goes in
  the `x-goog-api-key` **header**, never `?key=` (query strings land in logs); a
  function result returns as a `functionResponse` part on a **user** turn; thinking
  tokens count against `maxOutputTokens`, so the budget carries headroom or a reply
  comes back empty with `finishReason: MAX_TOKENS`; and a thinking model's
  `thoughtSignature` must be echoed back with the call it belongs to.
- **Test mode** (`test_mode` + up to 3 `test_numbers`, E.164) is the honest "try before
  you go live": the bot answers only those numbers and leaves everyone else for a
  human. There is deliberately **no message quota** — the provider bills the customer
  directly, so a cap we invented would be theatre.
- **Match RPCs stay `SECURITY INVOKER`** (migration 032 fixed a cross-tenant read by
  changing them from DEFINER). They are granted to `authenticated`; as DEFINER any
  signed-in user could pass a foreign `p_account_id` through PostgREST.
- Web: `components/agents/agent-studio.tsx` — tabs are Persona / Knowledge / Skills /
  Actions / Behaviour / Provider, and the test panel is a **drawer** so it is reachable
  from whichever form you just edited. `?tab=` is the deep-link contract (`setup` still
  maps to Provider). Uploads are base64 in JSON (this API has no multipart parser,
  same as `POST /ads/media`); PDF/DOCX text is extracted with `pdf-parse` / `mammoth`.

## Meta Ads Manager (`apps/api/src/ads`, `apps/web/src/app/(dashboard)/ads`) — BUILT, UNRELEASED

A second, separate Meta surface: the **Marketing API**, not the Cloud API. Design in
`docs/meta-ads-manager.md`; open setup items in `docs/meta-ads-manager-requirements.md`;
App Review pack in `docs/meta-ads-app-review.md`. **Read the first two before touching
this module.**

Complete: connect/Setup, insights sync, the four-step publish wizard, all five ad
types, Meta lead forms, audiences, events, and spend→deal attribution. Gated off
pending Meta App Review for `ads_management`.

- **Off by default, twice.** `ADS_MANAGER_ENABLED` (api — `AdsEnabledGuard` 404s every
  `/ads/*` route) and `NEXT_PUBLIC_ADS_MANAGER_ENABLED` (web — hides the rail row and
  `notFound()`s the routes via `ads/layout.tsx`). The web flag is a courtesy; the API
  guard is the actual gate. `ADS_MANAGER_SANDBOX=true` serves `src/ads/sandbox/fixtures.ts`
  instead of calling Meta, which is what makes the App Review screencast possible before
  App Review.
- ⚠️ **Ads run on the CUSTOMER's ad account. There is no wallet, no ad-credit ledger, no
  money through us** — Meta bills them directly. The reference product's "Buy Credits"
  header is deliberately absent; its honest equivalent is `meta_ads_config.funding_ok`,
  read from Meta, which gates publishing. Do not add a credits table without re-opening
  that decision.
- ⚠️ **Money is BIGINT minor units everywhere** (₹500 → `50000`), matching both the
  Marketing API and migration 068. No DECIMAL, no float rupees. One missed conversion is
  a 100× overspend on a real card, so `ADS_MAX_DAILY_BUDGET_MINOR` is a server-side
  backstop independent of any UI validation.
- ⚠️⚠️ **META IS INCONSISTENT ABOUT MONEY UNITS.** Budgets and bids
  (`daily_budget`, `bid_amount`) are **minor** units as a string — `"50000"` is ₹500.
  Insights (`spend`, `cpc`, `cpm`) are **major** units as a decimal string — `"500.00"`
  is ₹500. Same API, often the same screen. `parseBudgetMinor` and `parseSpendMinor` in
  `marketing-api.util.ts` are the ONLY places that difference is handled; never call
  `Number()` on a Meta money field directly. Pinned by `marketing-money.test.ts`.
- **The five ad types are a builder registry** (`services/ad-types/`), one file each,
  each answering campaign + adset + creative. `AdPublishService` is type-agnostic;
  adding a sixth type is one file plus one registry line. `whatsapp_status` ships behind
  its own `ADS_WHATSAPP_STATUS_ENABLED` flag because the placement is unverified.
- **Reach estimates and previews are advisory, never fatal.** A failed estimate returns
  a reason, not an exception — Meta rejects estimate specs for reasons (new ad account,
  throttle) that do not prevent the ad. Meta's real ad preview
  (`generatePreviews`) is implemented but unused: it returns a facebook.com iframe and
  the CSP has no `frame-src` for it.
- **`AdsConfigService` is the only place an ads token is decrypted**, and the only source
  of the ad account / page / pixel ids. **No route accepts an `ad_account_id` as
  authority** — see the tenant-scoping section above; here the cost of forgetting is
  spending another tenant's money rather than leaking their data. `facebook_connections`
  stores its token in *plaintext*; do not copy that pattern (fixing it is outstanding).
- **Connect is a server-side OAuth redirect, not the Facebook JS SDK.** An ads token must
  never exist in page JavaScript, and `connect.facebook.net` is absent from the web app's
  CSP `script-src` (Report-Only today, so the existing SDK-based lead-ads screen still
  works — but nothing new should be built on it). The callback (`ads/oauth/callback`) has
  **no auth guard**: it is a cross-site GET, and authorisation comes from the HMAC-signed
  `state` carrying the accountId that started the flow.
- **`common/security/oauth-state.util.ts`** is the shared signed-state mechanism, with
  per-provider bindings in `instagram/utils/` and `ads/utils/` — each signs with its own
  app secret so a state minted for one flow cannot be replayed into the other.
- **Publishing (M3) must be create-all-PAUSED → mirror in one transaction → activate**,
  with reverse-order rollback. `graphRequest` retries throttled **GETs only**; a retried
  POST buys a second campaign and Marketing API has no idempotency key. This is pinned by
  a test in `marketing-api.util.test.ts` — don't "fix" it.
- **Nav:** Ads Manager is the first primary-rail row to own a second panel, via
  `RailItem.panel` in `lib/nav/channels.ts`. It is deliberately **not** a channel — a
  channel is a value of `conversations.channel`, and no conversation arrives on "ads"
  (a Click-to-WhatsApp click produces a *WhatsApp* conversation).
- Publishing a Click-to-WhatsApp ad writes a `ctwa_campaigns` row, so existing
  `ctwa_clicks` attribution and `/channels/whatsapp/ctwa` keep working unchanged.

## Queues (`apps/api/src/queue`, BullMQ + Redis)

**Anything that calls somebody else's API on behalf of a request runs on a
queue.** Design and the decisions behind it: `docs/implementation_queue.md`.

- **`src/queue/queue.constants.ts` is the single source of every queue name**,
  and the list the dashboard enumerates. A queue whose name is declared next to
  its processor instead still runs — it is just invisible at `/admin/queues`,
  which is when you need it most.
- **13 queues.** Registered centrally in `QueueModule` when producer and
  processor live in different modules (`broadcast-orchestrate`,
  `broadcast-send`, `webhook-delivery`, `ai-reply`, `automation-trigger`,
  `ecommerce-sync`, `lead-fetch`); in the owning module otherwise
  (`automations-pending`, `flows-sweep`, `whatsapp-limits`, `ads-sync`, the two
  Instagram ones).
- **Broadcasts are a fan-out**: one orchestrator job per broadcast → one job per
  recipient. Both the dashboard and `POST /v1/broadcasts` go through
  `BroadcastQueueService.enqueueBroadcast()`. The status flow is
  `draft → queued → sending → sent|failed` (migration 070).
- ⚠️ **Never put a secret in a job payload.** Redis stores job data in plaintext
  and Bull Board renders it. Processors re-read and decrypt what they need —
  which also means a rotated token takes effect on the next job.
- ⚠️ **Redis is a work list; Postgres is the system of record.** Every job must
  be rebuildable from rows alone (this is why per-recipient template params are
  a column, not payload), and `BroadcastRecoveryService` re-enqueues unfinished
  broadcasts on boot.
- ⚠️ **Idempotency is layered on purpose**: a stable `jobId` stops a duplicate
  job existing, *and* the processor re-checks the row's status before acting.
  Removing either one re-introduces double-sends.
- **Retry classification comes from Meta's status code**, never from matching on
  an error message (`isTransientSendError`). `sendTemplateMessage` throws
  classified `MetaApiError` subclasses so this is possible.
- ⚠️ **`ai-reply` must stay fast.** Its concurrency is the auto-reply bot's
  response time; no rate limiter and no deliberate delay belongs on that queue.
- **Bull Board at `/admin/queues`**, mounted by hand in `main.ts` so auth runs
  before every one of its internal routes. Guarded by its own ops credential
  (`QUEUE_DASHBOARD_USER`/`_PASSWORD`) and **not mounted at all** when unset —
  it shows every tenant's job payloads, so a workspace login must never open it
  (same reasoning as `apps/admin-panel`).

## Infra — `docker-compose.yml`

All app ports are bound to **127.0.0.1** deliberately — Docker's port publishing writes iptables rules that sit in front of ufw, so `ufw deny` does *not* close a `0.0.0.0` publish. The host proxy reaches them on loopback.

- `redis` (`redis:7-alpine`, `wacrm-redis`) — no published port at all.
- `api` (`wacrm-api`, `127.0.0.1:8001:8001`, `REDIS_URL=redis://redis:6379`).
- `web` (`wacrm-web`, `127.0.0.1:3031:3000`).
- `site` (`wacrm-site`, `127.0.0.1:3032:80`).
- `admin-panel` (`wacrm-admin-panel`, `127.0.0.1:3033:3002`) — no `depends_on`; it only needs Postgres.

## Conventions & gotchas

- **Next.js 16 / React 19** — don't assume older Next APIs; consult the bundled docs first. `middleware.ts` is now **`proxy.ts`** (exporting `proxy`); `params`/`searchParams`/`cookies()`/`headers()` are all async.
- The Prisma schema lives in **`packages/database`** — never add a second copy under an app.
- Meta API helpers use **named-parameter objects**, not positional args — match that style.
- Tests are **vitest**.
- `v1/*` controllers = public API (api-key auth); `whatsapp/*` & dashboard controllers = internal (Supabase cookie auth). Pick the right guard.
- `auth.*` Prisma models are Supabase-managed — avoid writing to them directly.
- Enforce **account/tenant scoping** on every query — this is a multi-tenant app. The admin panel is the one deliberate exception: it is cross-tenant by design, which is exactly why its auth is separate and its own.
