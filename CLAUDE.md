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

| Task                                  | Command                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| Dev (all)                             | `npm run dev` (turbo)                                             |
| Build / lint / typecheck / test (all) | `npm run build` \| `lint` \| `typecheck` \| `test`                |
| Format                                | `npm run format` (prettier)                                       |
| API only                              | `cd apps/api && npm run dev` (nest watch)                         |
| API tests                             | `cd apps/api && npm test` (**vitest**)                            |
| Prisma                                | `npm run db:generate` \| `db:migrate` \| `db:push` \| `db:studio` |
| Web only                              | `cd apps/web && npm run dev`                                      |
| Admin panel only                      | `npm run dev --workspace=admin-panel`                             |

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

Internal operations panel: subscriptions and their amounts, sales, **tenant workspaces and their members**, **AI credit wallets**, and an audit log. Port **3002**. See `apps/admin-panel/README.md`.

- **No new api endpoints** — reads/writes Postgres directly via Prisma (`@repo/database`). Nothing here calls `apps/api`.
- **Auth:** one env credential (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), timing-safe compare, HS256 JWT session cookie signed with `ADMIN_SESSION_SECRET`. `proxy.ts` is an optimistic redirect gate; `requireAdmin()` in `lib/auth.ts` is the real check and runs in every page **and every Server Action**.
- **Structure:** `app/(panel)/*` pages (`/`, `subscribers`, `sales`, `plans`, `workspaces`, `users`, `credits`, `audit`), `app/login`, `lib/{env,session,auth,prisma,format}.ts`, `lib/queries/*` (reads), `lib/actions/*` (writes), `components/{ui,chart,shell,subscriber,plans,credits,workspace}`.
- ⚠️ **Money is derived, not recorded.** There is no payments/invoices table in this database — `user_subscriptions` has no amount column and no history. Every figure is `plan price × subscription`, so MRR/ARR/expected-collections are exact for _today_ and historical revenue is unrecoverable (a price edit rewrites the past). The reasoning lives in `lib/queries/sql.ts`; read it before adding a revenue figure. Time series there count subscriptions, never money.
- **AI credits are the one exception**, and the one place the panel handles real collected money: `ai_credit_orders.amount_minor` is what Razorpay charged and `ai_credit_ledger` is every credit that moved, so `/credits` may plot both over time. ⚠️ Those columns are **BIGINT minor units** while `subscription_plans.price_*` are major-unit decimals — every minor field is named `...Minor` and `minorToMajor()` in `lib/format.ts` is the only conversion. Never sum one into MRR.
- ⚠️ **Manual credit adjustment goes through `admin_adjust_ai_credits`** (migration 073), the third and last writer of `ai_credit_wallets.balance` after 072's `grant_ai_credits`/`consume_ai_credits`. It writes `reason = 'admin_adjust'` with `feature = NULL`, leaves `lifetime_purchased`/`lifetime_consumed` alone (a goodwill grant is not a purchase and a clawback is not consumption), and clamps a deduction at zero. A Prisma update on `balance` is a bug: concurrent auto-replies meter the same wallet and the ledger row must be written in the same statement. `ADMIN_MAX_CREDIT_ADJUSTMENT` is the server-side ceiling.
- ⚠️ **Membership writes re-implement migration 018's RPCs, deliberately.** `set_member_role`, `remove_account_member` and `transfer_account_ownership` all begin `IF auth.uid() IS NULL THEN RAISE 'Unauthorized'` — that check is what stops one tenant editing another's profiles, and this panel has no JWT, so they all refuse. `lib/actions/workspaces.ts` restates the rules and must stay in step with 018. Transferring ownership additionally **moves the subscription row**, because a workspace's plan is resolved through `accounts.owner_user_id`; `usage_tracking` does not move. Both `accounts.owner_user_id` and `user_subscriptions.user_id` are UNIQUE, so both conflicts are pre-checked into sentences rather than P2002s.
- **`admin_audit_log` (073) has no foreign keys on purpose** — a row must outlive the workspace, user or plan it describes. RLS on with zero policies and rights revoked from `anon`/`authenticated`; only an owner connection reads it. `recordAudit()` runs _after_ the write it describes and fails soft (credit moves have the ledger as an independent record).
- `lib/format.ts` is `server-only` on purpose: `ADMIN_CURRENCY` is not public, so client components take pre-formatted strings.

## Database — Prisma + Postgres (Supabase)

- **`packages/database` (`@repo/database`) owns the only schema.** `prisma/schema.prisma`: `provider = postgresql`, **dual schema** `["auth", "public"]` (the `auth.*` models — `users`, `sessions`, `identities`, `mfa_*`, `sso_*`, `oauth_*` — are Supabase's managed auth schema; treat as read-mostly). `previewFeatures = ["partialIndexes"]`. Generator is `prisma-client-js`, so both apps import from `@prisma/client` as usual.
- Each app owns its own connection (lifecycles differ): `apps/api/src/prisma/prisma.service.ts` (Nest module) and `apps/admin-panel/lib/prisma.ts` (globalThis singleton). Both use `@prisma/adapter-pg` (`pg`).
- The CLI reads `DATABASE_URL` from `apps/api/.env` via `packages/database/prisma.config.ts`. Run `npm run db:generate` from the root after any schema edit.
- Migrations also tracked as raw SQL in `supabase/migrations/`.
- ⚠️ **Supabase Storage buckets are written from the BROWSER, not the API** (`avatars`, `flow-media` 016/020, `chat-media` 023, `workspace-logos` 071). The bucket's RLS policy is therefore the _only_ gate on those writes — it must carry the authorization itself, including any role check. Account-scoped buckets all use the path convention `account-<account_id>/…` matched on the first folder segment, built in one place by `buildMediaPath()` (`apps/web/src/lib/storage/upload-media.ts`); a hand-rolled path is silently rejected. When such a URL is later persisted to a column, pin it to our own bucket _and_ the caller's own folder server-side (`common/storage/workspace-logo.util.ts`) — a free-text URL that renders in every teammate's browser is a beacon.
- **Domain models (public):** `Account`/`Profile`/`ApiKey` (tenancy + access), `account_onboarding`/`plan_enquiries` (guided signup), `contacts`/`contact_*`/`tags`/`custom_fields`, `contact_segments`/`contact_segment_members` (migration 076 — named audiences), `conversations`/`messages`/`message_reactions`/`message_templates`, `broadcasts`/`broadcast_recipients`/`campaign_schedules`, `pipelines`/`pipeline_stages`/`deals`, `forms`/`form_submissions`/`form_bookings` (migrations 054/055 — the form builder), `Automation`/`AutomationStep`/`AutomationLog`/`AutomationPendingExecution`, `Flow`/`FlowNode`/`FlowRun`/`FlowRunEvent`/`flow_state`, `whatsapp_config`/`whatsapp_products`/`whatsapp_orders`, `ecommerce_*`, `ai_configs` (workspace AI settings)/`ai_agents`/`ai_agent_knowledge`/`ai_agent_action_links` (migration 084 — several agents per workspace)/`ai_knowledge_documents`/`ai_knowledge_chunks`/`ai_agent_actions` (migration 069 — agent studio), `ctwa_campaigns`/`ctwa_clicks`/`retargeting_audiences`, `app_connections` (migration 082 — OAuth app connectors), `meta_ads_config`/`meta_ads_campaigns`/`meta_ads_adsets`/`meta_ads_ads`/`meta_ads_insights`/`meta_ads_media`/`meta_lead_forms`/`meta_ad_audiences`/`meta_ads_audit` (migration 068 — Ads Manager), `ai_credit_wallets`/`ai_credit_ledger`/`ai_credit_packs`/`ai_credit_orders` (migration 072 — platform-key credits), `subscription_plans`/`user_subscriptions`/`usage_tracking`, `webhook_endpoints`, `notifications`, `admin_audit_log` (migration 073 — written only by `apps/admin-panel`, no FKs on purpose so a row outlives what it describes).

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
- ⚠️ **ONE TRIAL PER WORKSPACE, EVER** (migration 074). `account_onboarding.trial_granted_at` is the latch; the window itself stays on `user_subscriptions`, which is where every consumer reads it. `startSubscription` writes the trial columns only when the latch is unset — switching plans carries the existing clock forward untouched, and a switch after it lapses lands `expired` rather than `active`. Before 074 every call wrote `trial_start_at = now()`, so clicking between Starter, Growth and Enterprise granted a fresh 15 days each time. Only an admin-panel operator can grant time after that ("Start trial" / "Extend the period by"), which is recorded in `admin_audit_log`. `OnboardingState.trialAvailable` exposes the latch to the UI.
- ⚠️ **An Enterprise enquiry is a sales signal, not a billing change.** `POST /onboarding/enquiry` is reachable from `/welcome` (brand-new account — the hard gate means something must be provisioned) _and_ from `/pricing` (already running). It now provisions a trial only when the account is not already entitled; before that it ran the same upsert either way, so a paying Growth customer asking about Enterprise was moved onto a free Enterprise trial, their `payment_method` rewritten to `manual` while their gateway id stayed put, and their MRR silently became zero. `selectPlan` likewise refuses an `active` subscription — plan changes for a payer belong to checkout — and neither path overwrites `payment_method` when a gateway id is present.
- ⚠️ **Enterprise is invisible to MRR.** Revenue is derived as `plan price × subscription` and there is no amount column, so a negotiated price lives only in `plan_enquiries` and contributes nothing to the admin panel's figures. The fix in practice is a **private plan row per customer** (`ENTERPRISE_ACME`, real price, `is_active = false` so nobody else is offered it) assigned to `accounts.owner_user_id` — see `apps/admin-panel/README.md`.
- **Plan limits are enforced through ONE account-scoped resolver** (migration 075): `get_account_entitlement` / `check_account_limit`, wrapped by `EntitlementService` and applied by `EntitlementGuard`. It resolves the plan through `accounts.owner_user_id`, so an invited teammate is entitled by their workspace rather than blocked for having no subscription row of their own — the trap the per-user `check_subscription_limit` (044) fell into. Standing is three-valued: `good`, `grace` (dunning — writes still work) and `lapsed`. ⚠️ It **fails open on failure, not on lapse**: a broken lookup returns "allowed", a successful lookup that says lapsed is honoured. Two kinds of metric, stored differently: monthly FLOW (messages, broadcasts) is counted in `account_usage_monthly` because it cannot be recounted; current STATE (contacts, flows, team members, **AI agents**) is counted live from the table that already holds the truth. `SubscriptionService.checkSubscriptionLimit`/`incrementUsage` and `usage_tracking` are the superseded per-user versions and have no callers.
- **There is exactly ONE billing surface in the product: Settings → Plan & billing (`?tab=pricing`), and it is owner-only** (`ownerOnly` on `SectionMeta`/`PanelItem` — stricter than `adminOnly`, which admins also pass). `/pricing` is the checkout it hands off to. The old `/admin/subscriptions` page and the `subscription/admin/*` Nest controller are **deleted, not moved** — see below. Cross-tenant billing administration belongs to `apps/admin-panel`.
- `get_user_subscription()` is `SECURITY DEFINER` and therefore carries **its own authorization** (migration 067): a JWT caller may read only itself; a server connection (`auth.uid() IS NULL`, which is how apps/api connects) may read anyone. Any new SECURITY DEFINER RPC granted to `authenticated` needs the same guard — RLS is bypassed, so the function body is the only check left.

## Tenant-scoping traps (learned the hard way)

Two cross-tenant leaks shipped here before being removed; both share one shape, so check for it in any new code:

- **Prisma bypasses RLS.** `apps/api` connects as the database owner, so a `findMany()` without `where: { account_id }` returns _every tenant's_ rows even though the equivalent browser query is correctly scoped by policy. The deleted `subscription/admin/users` endpoint was exactly this — `profile.findMany()`, no filter. Its sibling write endpoints took a `targetUserId` from the body and only checked that the caller was an admin _somewhere_, which let an admin of one workspace rewrite another's subscription.
- **`SECURITY DEFINER` RPCs bypass RLS too**, and `GRANT EXECUTE ... TO authenticated` means any signed-in user can call them with any argument. Authorization has to be inside the body.

The rule of thumb: _if a query runs through Prisma or a SECURITY DEFINER function, RLS is not protecting you — scope it yourself._

## Meta WhatsApp Cloud API integration (core dependency)

The app is built on the **official Meta WhatsApp Cloud API** (`https://graph.facebook.com/<version>/...`, Bearer-token auth). `notes/WhatsApp Cloud API.postman_collection.json` is Meta's official collection and is a **superset reference** for endpoints — the code implements a subset of it.

- **Version pins — there are now THREE**, one per independent surface. Intentional (three upgrade risks rather than one shared one), but three things to keep current:
  | Surface                     | Version | Constant                                                                                     |
  | --------------------------- | ------- | -------------------------------------------------------------------------------------------- |
  | WhatsApp Cloud API          | `v21.0` | `META_API_BASE` in `src/whatsapp/meta-api.util.ts:21`, `whatsapp-templates.controller.ts:63` |
  | Facebook Pages / lead-gen   | `v20.0` | inline in `src/integrations/controllers/facebook.controller.ts`                              |
  | Marketing API (Ads Manager) | `v23.0` | `META_MARKETING_VERSION` in `src/ads/marketing-api.util.ts`                                  |
- **`src/whatsapp/meta-api.util.ts`** — thin fetch wrappers (each takes one named-options object): `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList` (+ shared `INTERACTIVE_LIMITS`), `sendProductMessage`/`sendProductListMessage`, `sendReactionMessage`, `verifyPhoneNumber`, `exchangeEmbeddedSignupCode`, `registerPhoneNumber`, `subscribeWabaToApp`/`getSubscribedApps`, `uploadResumableMedia`, `submit/edit/deleteMessageTemplate`, `getMediaUrl`/`downloadMedia`.
- **Also implemented across the module:** flows send (`flow-meta-send.service.ts`), template management (`controllers/whatsapp-templates.controller.ts`), media proxy (`controllers/whatsapp-media.controller.ts`), inbound webhook (`services/whatsapp-webhook.service.ts` — parses messages + delivery/read statuses), account connect/register (`services/connect-account.service.ts`).
- **In the Postman collection but NOT yet implemented:** outbound _mark-as-read_ & _typing indicators_, QR codes, commerce settings, Payments API (SG/IN order messages), analytics, billing, block users, business compliance, deregister, business portfolio. (Read status is only _received_ via webhook, not sent.)

## AI agents (`apps/api/src/ai`, `apps/web/src/app/(dashboard)/agents`)

**A workspace runs SEVERAL agents** (`ai_agents`, migration 084). The split that
makes the rest of this section readable:

- **`ai_configs` is the WORKSPACE row** — the provider and its encrypted key, the
  credit mode, the embeddings provider/model the stored vectors are bound to. One
  per account, and the only place a credential lives.
- **`ai_agents` is one row per agent** — persona, voice, skills, escalation,
  behaviour, test mode, and `model` (nullable: NULL follows the workspace default).
  It holds **no key of any kind**, which is what makes an agent safe to duplicate.
  Every field here used to be a column on `ai_configs`; 084 backfilled one agent per
  existing row and dropped the originals.

⚠️ **The provider is never per-agent.** There is one stored key per workspace and it
belongs to one provider, so an agent may choose a MODEL and nothing more — and on
platform credits not even that (one key serves every platform workspace, so a
per-agent override would let one tenant point our credential at an expensive tier).

**Routing — how an inbound message picks an agent** (`AgentResolverService`, pinned by
`agent-resolver.service.test.ts`):

1. **Stickiness first.** `conversations.ai_agent_id` is set on the first AI reply and
   consulted before anything else. Without it, routing is re-evaluated per MESSAGE and
   a reorder changes who the customer is talking to mid-sentence.
2. Otherwise: active agents whose `channels` contains the conversation's channel — or
   whose `channels` is **EMPTY, meaning any channel** — in `priority` order, first
   wins. Empty is permissive here (unlike `automations.channels`) because every agent
   migrated from `ai_configs` carries an empty array and must keep answering everyone.
3. **No fallback beyond that.** An agent scoped to Instagram must not answer a
   WhatsApp thread just because it is the only one; the thread stays for a human.

**The knowledge library and custom actions stay WORKSPACE-level** — one upload, one
embedding cost, one reindex — and each agent selects from them
(`ai_agent_knowledge` / `ai_agent_action_links`). ⚠️ `uses_all_knowledge` /
`uses_all_actions` are booleans **because an empty link table must not mean
"everything"**: unticking the last document would otherwise silently re-grant the whole
library (the same trap 076 documents for segment rules). The selection is pushed INTO
`match_ai_knowledge_semantic` / `_fts` as `p_document_ids`, never applied to their
results — post-filtering a top-k would make "this agent may not read those" look
identical to "nothing relevant was found".

**Attribution:** `messages.ai_agent_id` is written at INSERT time by each channel's own
persist step (threaded through `ChannelSenderService.sendText`), and
`conversations.ai_handoff_at` records when the bot gave up. That is what the per-agent
numbers on the list are counted from — no counter, so no drift.

**Agent count is a plan limit** (`subscription_plans.max_ai_agents`, NULL = unlimited):
Starter 1, Growth 5, Enterprise unlimited, checked through `check_account_limit` like
any other current-state metric. Paused agents still count — a cap you can dodge by
pausing is not a cap.

**Two ways to power it, chosen per workspace** (`ai_configs.credit_mode`, migration 072):

- `platform` (default) — runs on **our** Gemini key (`AI_PLATFORM_GEMINI_KEY`), metered
  against `ai_credit_wallets`. New workspaces get 250 free credits.
- `byok` — the account's own OpenAI / Anthropic / Gemini key, AES-256-GCM-encrypted,
  calling the provider directly. Their provider bills them, so **nothing is metered and
  no quota applies** — the original 069 design, unchanged.

Everything below is account-scoped configuration on `ai_configs` (one row per workspace).

- ⚠️ **The stored mode is the decision; fallback is one-directional.** `resolveSource()`
  in `lib/config.ts` falls back only when the chosen source cannot serve the call at all
  (no server key, empty wallet → their key if present; no own key → platform). It never
  falls back _to_ credits from a working own-key setup: that would bill someone for
  something they did not choose. A pre-072 account with a key was migrated to `byok`
  for the same reason.
- ⚠️ **A credit is metered from real tokens**, not per action: `creditsForGeneration()`
  charges `ceil((input + output×4) / 4000)`, floor 1, summed over **every** tool round
  (`GenerateResult.usage`) — a 3-round loop is 3 billable calls. Gemini's
  `thoughtsTokenCount` counts as **output**; omitting it meters a fraction of the cost.
  Indexing is metered at 1 credit / 25k tokens. Pinned by `credits/credits.test.ts`.
- **Platform model is deliberately the cheapest high-rate-limit tier**
  (`gemini-3.5-flash-lite`): one key serves every platform workspace, so a low RPM
  ceiling makes one busy tenant an outage for all of them.
- ⚠️ **The platform key never leaves the server** — not in a response, a job payload
  (Redis stores those in plaintext and Bull Board renders them), or a log line.
- **The playground is metered like production.** An unmetered test surface on our key is
  an open inference proxy behind a login page.
- **Balance moves only through `grant_ai_credits` / `consume_ai_credits` /
  `admin_adjust_ai_credits`** (SQL, atomic, ledger written in the same statement). All
  three are SECURITY INVOKER with EXECUTE revoked from PUBLIC — a DEFINER function
  granted to `authenticated` would be a mint-your-own-credits endpoint. Concurrent
  auto-replies on one workspace make read-then-write in JS wrong, not just untidy.
  The third (migration 073) is the internal admin panel's signed manual correction:
  `reason = 'admin_adjust'`, `feature = NULL`, `lifetime_purchased`/`lifetime_consumed`
  untouched, deductions clamped at zero. Nothing in `apps/api` calls it.
- ⚠️ **Top-ups verify Razorpay's HMAC signature and price the pack server-side**
  (`ai_credit_packs` → `ai_credit_orders` written _before_ redirect). `credited_at` is the
  idempotency latch so the browser callback and the webhook grant exactly once. Note the
  neighbouring `subscription/razorpay/confirm-payment` does **not** verify a signature —
  do not copy it; it needs the same fix.

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
  expressible. Headers are encrypted and never returned — the UI shows header _names_.
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
  human. On `byok` there is deliberately **no message quota** — the provider bills the
  customer directly, so a cap we invented would be theatre. On `platform` the credit
  wallet _is_ the cap, because we are the ones paying.
- ⚠️ **The automation gate in `AiReplyService` must ask exactly what
  `AutomationDispatchService.dispatch` asks** — active + trigger type, _plus_ the
  `channels` scope, _plus_ `triggerMatches` (the keyword filter). It exists only to stop
  two replies to one message, so only an automation that genuinely fires may silence the
  bot. It shipped as the first check alone, and one web-scoped `keyword_match` automation
  turned auto-reply off for the whole workspace on every channel, permanently and with
  nothing logged. Pinned by `ai-reply-automation-gate.test.ts`. It is the one gate that
  fails **closed** (one reply beats two).
- **Match RPCs stay `SECURITY INVOKER`** (migration 032 fixed a cross-tenant read by
  changing them from DEFINER). They are granted to `authenticated`; as DEFINER any
  signed-in user could pass a foreign `p_account_id` through PostgREST.
- **Web is a list plus a studio.** `/agents` (`components/agents/agents-list.tsx`) is a
  LIST rather than a card grid on purpose: its order **is** the routing order, and a
  grid that reflows by column would show that fact differently at every window width.
  It carries the plan meter, the create dialog (blank + role templates from
  `lib/agent-templates.ts`) and the workspace-level Provider & credits drawer.
  `/agents/[id]` is the studio: tabs are Persona / Knowledge / Skills / Actions /
  Behaviour / **Routing**, and the test panel is a **drawer** so it is reachable from
  whichever form you just edited. `?tab=` is still the deep-link contract (`setup` and
  `provider` now map to Routing, since the key moved to the workspace).
- ⚠️ **`agent-readiness.tsx` is a MIRROR of the run-time gates**, in the order
  `AiReplyService` checks them — it exists to answer "why is my bot silent?" without
  reading logs. A gate added there and not here makes the checklist lie, which is worse
  than not having one. "Drafts only" and test mode are deliberately NOT blockers: both
  are legitimate ways to run an agent.
- Uploads are base64 in JSON (this API has no multipart parser, same as
  `POST /ads/media`); PDF/DOCX text is extracted with `pdf-parse` / `mammoth`.

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
  spending another tenant's money rather than leaking their data. (`facebook_connections`
  used to store its token in _plaintext_ and was the counter-example here; migration 081
  dropped it with the Facebook Leads integration, which is the permanent fix.)
- ⚠️ **Lead-form submissions still arrive on `/webhooks/facebook-leads`**, which moved
  into this module with migration 081 when Facebook Leads was removed from Integrations —
  Ads Manager became its only consumer. It resolves its tenant from `meta_ads_config` by
  `page_id` and is deliberately NOT behind `AdsEnabledGuard`: Meta delivers to a Page
  subscription whatever our flag says, and 404ing makes Meta disable the subscription.
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
  (a Click-to-WhatsApp click produces a _WhatsApp_ conversation).
- Publishing a Click-to-WhatsApp ad writes a `ctwa_campaigns` row, so existing
  `ctwa_clicks` attribution and `/channels/whatsapp/ctwa` keep working unchanged.

## Segments — named audiences (migration 076)

A segment is a set with a purpose ("March webinar attendees"); a **tag** is a
fact about one person ("vip"). Both exist because collapsing them is how a tag
list becomes sixty entries nobody dares delete.

- **Two kinds, and the choice is permanent.** `kind = 'static'` is an explicit
  membership list in `contact_segment_members` and is the only kind anything may
  add somebody to. `kind = 'dynamic'` is a saved filter whose membership is
  computed from `filter` on read and never stored. `kind` is deliberately
  immutable — flipping static→dynamic orphans member rows behind a filter that
  does not describe them, and dynamic→static invents a list nobody chose.
- ⚠ **`resolve_segment_contact_ids(id)` is the ONLY correct way to turn a
  segment into people.** Reading `contact_segment_members` directly looks like it
  works and silently returns nothing for a dynamic segment — an empty audience
  reads as an empty audience, not as a bug. `SegmentMembershipService.resolve()`
  is the TypeScript face of it.
- ⚠ **Both ends of a membership write are pinned, and neither check is
  redundant.** `SegmentMembershipService.findForAccount()` pins the SEGMENT to the
  caller's account; `add_contacts_to_segment` pins the CONTACT to the segment's.
  The segment id arrives from a config blob and the contact id from a webhook
  payload, and Prisma bypasses RLS — either check alone leaves a cross-tenant
  write open. The RLS INSERT policy restates both for the browser, which writes
  membership through PostgREST directly.
- ⚠ **An incomplete rule is DROPPED, and a filter with no usable rules matches
  NOBODY.** `segment_complete_rules()` decides this. Treating an unfinished rule
  as permissive is correct under `match: 'all'` and catastrophic under
  `match: 'any'`, where it resolves to the entire contact list — and the first
  thing that happens to a segment is that somebody broadcasts to it. The rule
  vocabulary is a contract between `contact_matches_segment_rule()` (SQL, the
  authority) and `apps/web/src/lib/segments/rules.ts`; a field added to one and
  not the other saves fine, renders fine, and matches nobody.
- **Six surfaces can file a contact into a segment**, all through the same
  service or the same RPC: the contacts page bulk bar, the contact drawer, the
  inbox sidebar, CSV import, the `add_to_segment`/`remove_from_segment`
  automation steps, the `set_segment` flow node, and `POST /v1/segments/:id/contacts`.
  `contact_segment_members.source` records which one, and `added_by` is NULL when
  a machine did it — an automation adding 10,000 people is a different fact from
  an operator ticking a box.
- **Broadcasts take `audience.type = 'segments'`** (several segments UNION) and
  `excludeSegmentIds`, which applies to *every* audience type because "everyone
  except last month's buyers" is the shape most suppression lists take.
- `filter_contacts()` is 025's `filter_contacts_by_tags` superset — tags AND
  segments, and its search also covers `company` and `ig_username`. 025 is left
  in place, unused by the page.
- The public API reuses `contacts:read`/`contacts:write` rather than minting a
  segment scope: a new scope is absent from every key already issued, so every
  live integration would 403 the day it shipped.

## App connections — OAuth connectors (migration 082)

Google Sheets, Gmail, Calendar and Meet, connected once per workspace
through a server-side OAuth redirect. Design: `docs/app-connections.md`.
Lives in `apps/api/src/connections`, **not** `integrations/` (that module
is Zapier: pasted webhook URLs, no stored credential).

- ⚠️⚠️ **EVERY SCOPE IS "SENSITIVE", NEVER "RESTRICTED", AND THAT IS THE
  CENTRAL CONSTRAINT.** A restricted scope commits the product to an
  annual **paid third-party CASA security assessment**; a sensitive scope
  needs a one-off verification review. Two counter-intuitive consequences
  that must not be "simplified" later: **Gmail is send-only and there is
  no draft action** (`gmail.send` is sensitive, `gmail.compose` is
  RESTRICTED because it can read drafts), and **nothing lists Drive
  files** (spreadsheet ids are pasted from the URL; only the TABS inside
  are listed). Pinned by `connections.test.ts`.
- ⚠️ **`ConnectionTokenService` is the only place a token is decrypted.**
  No token in a queue payload, an API response or a log line — Redis
  stores job data in plaintext and Bull Board renders it. Refresh is
  serialised per connection (`inFlight`) with a 120s expiry skew; an
  `invalid_grant` sets `status = 'needs_reauth'` rather than retrying
  forever, and **a refresh response that omits a refresh token must never
  overwrite the stored one** or the connection dies days later.
- ⚠️ **`app_connections` has RLS on with ZERO policies and rights
  revoked** (like `admin_audit_log`). RLS is row-level: any
  browser-readable policy hands `refresh_token` to PostgREST. API-only,
  redacted projection. Add an endpoint, never a policy.
- **ONE `app_action` step type for every app and every action.** The app
  and action are data in `step_config`, resolved through
  `ConnectorRegistryService`; the picker still lists each action
  separately. Adding an action is a server-side change only — the
  editor renders from `FieldSpec` served by `GET /connections/catalog`,
  which is also what the API validates against, so a field cannot render
  without validating.
- ⚠️ **`connection_id` in a step config is author-supplied data, not
  authority.** Every read is filtered by the running automation's
  `account_id` — same trap as `segment_id`, bigger prize.
- The OAuth callback (`/connections/oauth/callback`) has **no auth
  guard**: cross-site GET, authorised by the HMAC-signed `state`, which
  signs with its own `CONNECTIONS_STATE_SECRET` so a state cannot be
  replayed into the Instagram or Ads callbacks.
- `lib/automations/app-presets.ts` (Slack, Notion, Airtable…) still
  exists for the long tail and is honestly labelled "Other services" —
  those are pre-filled `http_request` steps where you paste your own key.

## Automations — canvas editor + step engine

An automation is a **sequence of steps where a branching step owns two child
sequences** (`yes` / `no`), persisted as `automation_steps.parent_step_id` +
`branch`. It is a TREE, not a free graph — that difference is the whole reason
the editor works the way it does.

- ⚠️ **`automation_steps.key` is the identity that matters** (migration 080).
  Saving is delete-then-reinsert (`replaceSteps`), so **row ids change on every
  save** — a token or a canvas node built on one would rot silently. The key is
  author-chosen, unique per automation, sanitised to `[a-z0-9_]` in TWO places
  that must agree: `uniqueKey()` (api) and `uniqueStepKey()` (web).
- **`position_x`/`position_y` are NULLABLE on purpose.** NULL = "never laid
  out" and triggers dagre; `0` = deliberately placed. `NOT NULL DEFAULT 0`
  would make every pre-canvas automation a pile at the origin.
- ⚠️ **A step's output is published to later steps** under
  `context.steps[<key>]`, which is what `{{ steps.lookup.body.id }}` reads.
  Published BEFORE the next step runs, and also on a *failed* HTTP step — a
  `continue`-on-error step exists precisely so a condition can branch on the
  status code it just got.
- **`automation-interpolation.util.ts` is the expression engine**: deep paths
  (`steps.x.body.items.0.sku`), namespaces (`contact`, `message`, `vars`,
  `steps`, `trigger`, `conversation`, `form`, `now`) and filters
  (`| default:"x"`, `json`, `upper`, `digits`, …). ⚠️ **An unknown token still
  resolves to an EMPTY STRING**, never verbatim — a visible `{{vars.name}}` in
  a customer's chat reads as a broken app. `resolveValue()` keeps the TYPE when
  a field is exactly one token, which is how a JSON body posts `3` not `"3"`.
- **Conditions are `rules[] + match: all|any`.** The pre-existing single
  `{subject, operand, value}` triple is lifted into a one-rule list when
  `rules` is absent — those rows are live, and a condition silently flipping
  branch is a customer getting the wrong message.
- **`send_webhook` and `close_conversation` are superseded, not removed**
  (`http_request`, `set_conversation_status`). They stay readable and are
  hidden from the add menu via `STEP_META[...].deprecated`.
- ⚠️ **Everything that can go wrong at run time is SILENT by design**: an
  unsupported step is skipped, an unknown token is empty, a missing contact is
  skipped. `lib/automations/diagnostics.ts` is the editor's answer to that —
  pre-flight checks for dead tokens, cross-branch references, channel
  capability, WhatsApp's 24-hour window, SSRF-refused URLs, self-calling
  automations. It is a MIRROR of run-time behaviour; `automation-validate.ts`
  (api) remains the only thing that blocks activation.
- **`lib/automations/availability.ts` mirrors `CHANNEL_CAPABILITIES`.**
  Instagram has no templates and no lists; web has no templates. A step that
  works on *some* selected channels is `partial` (legitimate — one automation
  branching per channel); one that works on *none* is `never` and is dead
  config. An UNSCOPED automation is not warned about partial support, or every
  template step in the product would carry a warning nobody reads.
- **Editor (`components/automations/canvas/*`)**: React Flow canvas + docked
  right inspector, design spec in `docs/automation-canvas-design.md`. Edges are
  DERIVED from the tree, so drag-to-connect is a **move**, not a link. A
  branching step's yes/no ports live inside a two-column card footer; the
  dashed **continue** edge (right edge → right edge) is where the parent
  sequence resumes, and it exists because without it every condition looked
  like the end of the automation.
- **Colour is per CATEGORY, not per step type** (24 hues is noise), and
  `stepColors().line` — not `solid` — paints every stroke and glyph: the raw
  hue measures 2.53:1 on a light card, under WCAG 1.4.11's 3:1.
- ⚠️ **Some triggers carry NO channel, and scoping one silences it**
  (`CHANNELLESS_TRIGGERS`): `form_submitted` and the three `appointment_*`.
  `FormSubmitService.fanOut` / `BookingService.fanOut` set no
  `context.channel`, so the dispatcher's `toChannel(undefined)` resolves them
  to WhatsApp — picking "Web" for a website form, the intuitive answer, meant
  it never fired, permanently and with nothing logged. The dispatcher now
  IGNORES `channels` for these (automations saved earlier carry a scope
  nobody can see any more), the inspector hides the picker
  (`channelless` on `TRIGGER_OPTIONS`), and switching to one clears whatever
  the picker left behind. Three places, all mirrors of one list.

## Forms — builder, conditional logic and steps (migrations 054/055)

A form is a **JSON list of fields** on `forms.fields`, so a new field type or
field property is a code change with no migration. `form_submissions.data` is
keyed by `field_key`.

- ⚠️ **`field_key` is the identity and is generated ONCE.** It keys
  `submissions.data`, so it must survive the label being reworded — the
  builder mints it from the first label (`makeFieldKey`) and never
  regenerates it. The inspector shows it read-only; an export column nobody
  can find is worse than a slightly ugly one.
- ⚠️ **Conditional visibility is enforced in TWO places that must agree.**
  `computeFieldVisibility` in `apps/api/src/forms/form.types.ts` is the
  authority; `apps/web/src/lib/forms/visibility.ts` mirrors it for the
  renderer and the builder. When they disagree the form becomes
  **unsubmittable**: the browser hides a required field, the server demands
  it, and the error lands on an input that is not on screen. Pinned on both
  sides (`form-validate.test.ts`, `visibility.test.ts`).
- ⚠️ **A hidden field is not a blank one.** The validator neither requires nor
  STORES a field a rule hid — dropping the stale answer matters as much as
  skipping the requirement, or someone who picks "Other", types a reason and
  then changes their mind has that reason filed against them.
- **Rules point BACKWARDS only** (`visible_when.field_key` must name an
  earlier field). That single rule makes cycles impossible by construction
  instead of by cycle detection, and it is the only arrangement a rule can be
  satisfied under once page breaks exist. Rejected at save time.
- **`page_break` is a presentational field**, not a container: steps are
  positional, everything between two breaks is one step, and `splitIntoPages`
  drops empty pages so a rule that empties a step removes it rather than
  rendering a blank one with a Next button.
- ⚠️ **The builder canvas renders the REAL `FieldInput`** from
  `form-renderer.tsx`, inert inside a selection shell. A builder that draws
  its own approximation of a field drifts from the published form silently,
  and the first person to notice is a customer on a live page. It is also why
  half-width fields pair up correctly in the canvas — same flex container.
- **`mapping` and `default_value` are stripped from the public projection**
  (`toPublicProjection`) — they describe the tenant's own CRM structure. So a
  hidden field's default has to be applied SERVER-side in the validator; the
  browser never sees it.
- The editor is **full-screen (`fixed inset-0`)** like the automation editor,
  for the same reason: three columns that all want vertical room.
- Submitting fires the `form_submitted` automation trigger and the
  `form.submitted` webhook — see the channel-less warning above.

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
  job existing, _and_ the processor re-checks the row's status before acting.
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

All app ports are bound to **127.0.0.1** deliberately — Docker's port publishing writes iptables rules that sit in front of ufw, so `ufw deny` does _not_ close a `0.0.0.0` publish. The host proxy reaches them on loopback.

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
