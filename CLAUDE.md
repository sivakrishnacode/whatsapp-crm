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
- **Feature modules** (`src/app.module.ts`): `prisma`, `common` (redis, rate-limit, security), `queue` (BullMQ), `auth`, `health`, `automations`, `flows`, `v1`, `whatsapp`, `account`, `integrations`, `ecommerce`, `campaigns`, `subscription`, `onboarding`, `ai`.
- **Two API surfaces by controller prefix:**
  - `@Controller('v1/...')` — the **public/partner REST API** (`v1/me`, `v1/messages`, `v1/webhooks`, `v1/broadcasts`, `v1/contacts`, `v1/conversations`). Lives in `src/v1/{controllers,services,types,utils}`. See `docs/public-api.md`.
  - `@Controller('whatsapp/...')` — **internal dashboard/webhook** endpoints consumed by the web app.
- **Auth (`src/auth/guards`):**
  - `supabase-auth.guard.ts` — verifies **Supabase** JWTs from cookies using `jose` (JWKS via `SUPABASE_URL/.well-known/jwks.json`, or HS256 with `SUPABASE_JWT_SECRET`). Used by the dashboard/web surface.
  - `api-key.guard.ts` — `Bearer <api-key>` for the public `v1` API (see `ApiKey` model + `src/lib/api-keys/scopes`).
- **Queue:** `@nestjs/bullmq` + `ioredis` (broadcasts, automations, campaign schedules, etc.).
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
- **Domain models (public):** `Account`/`Profile`/`ApiKey` (tenancy + access), `account_onboarding`/`plan_enquiries` (guided signup), `contacts`/`contact_*`/`tags`/`custom_fields`, `conversations`/`messages`/`message_reactions`/`message_templates`, `broadcasts`/`broadcast_recipients`/`campaign_schedules`, `pipelines`/`pipeline_stages`/`deals`, `Automation`/`AutomationStep`/`AutomationLog`/`AutomationPendingExecution`, `Flow`/`FlowNode`/`FlowRun`/`FlowRunEvent`/`flow_state`, `whatsapp_config`/`whatsapp_products`/`whatsapp_orders`, `ecommerce_*`, `ai_configs`/`ai_knowledge_documents`/`ai_knowledge_chunks`, `facebook_connections`/`facebook_pages`/`ctwa_campaigns`/`ctwa_clicks`/`retargeting_audiences`, `subscription_plans`/`user_subscriptions`/`usage_tracking`, `webhook_endpoints`, `notifications`.

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

## Meta WhatsApp Cloud API integration (core dependency)

The app is built on the **official Meta WhatsApp Cloud API** (`https://graph.facebook.com/<version>/...`, Bearer-token auth). `notes/WhatsApp Cloud API.postman_collection.json` is Meta's official collection and is a **superset reference** for endpoints — the code implements a subset of it.

- **Version pin:** WhatsApp module uses `v21.0` (`META_API_BASE` in `src/whatsapp/meta-api.util.ts:21` and `whatsapp-templates.controller.ts:63`). ⚠️ The separate Facebook Pages/lead-gen integration (`src/integrations/controllers/facebook.controller.ts`) uses `v20.0` — versions are intentionally distinct surfaces but worth keeping in mind.
- **`src/whatsapp/meta-api.util.ts`** — thin fetch wrappers (each takes one named-options object): `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList` (+ shared `INTERACTIVE_LIMITS`), `sendProductMessage`/`sendProductListMessage`, `sendReactionMessage`, `verifyPhoneNumber`, `exchangeEmbeddedSignupCode`, `registerPhoneNumber`, `subscribeWabaToApp`/`getSubscribedApps`, `uploadResumableMedia`, `submit/edit/deleteMessageTemplate`, `getMediaUrl`/`downloadMedia`.
- **Also implemented across the module:** flows send (`flow-meta-send.service.ts`), template management (`controllers/whatsapp-templates.controller.ts`), media proxy (`controllers/whatsapp-media.controller.ts`), inbound webhook (`services/whatsapp-webhook.service.ts` — parses messages + delivery/read statuses), account connect/register (`services/connect-account.service.ts`).
- **In the Postman collection but NOT yet implemented:** outbound *mark-as-read* & *typing indicators*, QR codes, commerce settings, Payments API (SG/IN order messages), analytics, billing, block users, business compliance, deregister, business portfolio. (Read status is only *received* via webhook, not sent.)

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
