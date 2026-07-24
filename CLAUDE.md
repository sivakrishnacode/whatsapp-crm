@AGENTS.md

# Project Reference

> Living reference for AI agents working in this repo. The `@AGENTS.md` import above
> carries the **Next.js guidance** (this is a heavily-changed Next.js — read
> `apps/web/node_modules/next/dist/docs/` before writing web code). Keep this file
> accurate as the codebase evolves.

## What this is

`conceps-wa` (dir: `wacrm`) — a **WhatsApp CRM** platform. It connects a business's
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
packages/
  typescript-config/   Shared tsconfig bases.
supabase/migrations/   SQL migrations (Supabase-managed Postgres, auth + public schemas).
scripts/               run-migration.sh / run-migration.ts.
docs/                  public-api.md, razorpay.md, subscription-setup.md.
notes/                 Reference material (e.g. the official Meta "WhatsApp Cloud API" Postman collection).
docker-compose.yml     redis + api + web.
turbo.json             Tasks: build, dev, lint, test, typecheck.
```

## Commands (run from repo root unless noted)

| Task | Command |
|---|---|
| Dev (all) | `npm run dev` (turbo) |
| Build / lint / typecheck / test (all) | `npm run build` \| `lint` \| `typecheck` \| `test` |
| Format | `npm run format` (prettier) |
| API only | `cd apps/api && npm run dev` (nest watch) |
| API tests | `cd apps/api && npm test` (**vitest**) |
| Prisma | `cd apps/api && npm run prisma:generate \| prisma:migrate \| prisma:studio` |
| Web only | `cd apps/web && npm run dev` |

Both apps test with **vitest** (not Jest). API lint = eslint + prettier; web lint = `eslint`.

## Backend — `apps/api` (NestJS)

- **Entry** `src/main.ts`: `cookie-parser`, global `ValidationPipe({ whitelist: true, transform: true })`, listens on `PORT ?? 8001`. No global route prefix — controllers own their full path.
- **Feature modules** (`src/app.module.ts`): `prisma`, `common` (redis, rate-limit, security), `queue` (BullMQ), `auth`, `health`, `automations`, `flows`, `v1`, `whatsapp`, `account`, `integrations`, `ecommerce`, `campaigns`, `subscription`, `ai`.
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

## Database — Prisma + Postgres (Supabase)

- `apps/api/prisma/schema.prisma`: `provider = postgresql`, **dual schema** `["auth", "public"]` (the `auth.*` models — `users`, `sessions`, `identities`, `mfa_*`, `sso_*`, `oauth_*` — are Supabase's managed auth schema; treat as read-mostly). Client uses `@prisma/adapter-pg` (`pg`). `previewFeatures = ["partialIndexes"]`.
- Migrations also tracked as raw SQL in `supabase/migrations/`.
- **Domain models (public):** `Account`/`Profile`/`ApiKey` (tenancy + access), `contacts`/`contact_*`/`tags`/`custom_fields`, `conversations`/`messages`/`message_reactions`/`message_templates`, `broadcasts`/`broadcast_recipients`/`campaign_schedules`, `pipelines`/`pipeline_stages`/`deals`, `Automation`/`AutomationStep`/`AutomationLog`/`AutomationPendingExecution`, `Flow`/`FlowNode`/`FlowRun`/`FlowRunEvent`/`flow_state`, `whatsapp_config`/`whatsapp_products`/`whatsapp_orders`, `ecommerce_*`, `ai_configs`/`ai_knowledge_documents`/`ai_knowledge_chunks`, `facebook_connections`/`facebook_pages`/`ctwa_campaigns`/`ctwa_clicks`/`retargeting_audiences`, `subscription_plans`/`user_subscriptions`/`usage_tracking`, `webhook_endpoints`, `notifications`.

## Meta WhatsApp Cloud API integration (core dependency)

The app is built on the **official Meta WhatsApp Cloud API** (`https://graph.facebook.com/<version>/...`, Bearer-token auth). `notes/WhatsApp Cloud API.postman_collection.json` is Meta's official collection and is a **superset reference** for endpoints — the code implements a subset of it.

- **Version pin:** WhatsApp module uses `v21.0` (`META_API_BASE` in `src/whatsapp/meta-api.util.ts:21` and `whatsapp-templates.controller.ts:63`). ⚠️ The separate Facebook Pages/lead-gen integration (`src/integrations/controllers/facebook.controller.ts`) uses `v20.0` — versions are intentionally distinct surfaces but worth keeping in mind.
- **`src/whatsapp/meta-api.util.ts`** — thin fetch wrappers (each takes one named-options object): `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList` (+ shared `INTERACTIVE_LIMITS`), `sendProductMessage`/`sendProductListMessage`, `sendReactionMessage`, `verifyPhoneNumber`, `exchangeEmbeddedSignupCode`, `registerPhoneNumber`, `subscribeWabaToApp`/`getSubscribedApps`, `uploadResumableMedia`, `submit/edit/deleteMessageTemplate`, `getMediaUrl`/`downloadMedia`.
- **Also implemented across the module:** flows send (`flow-meta-send.service.ts`), template management (`controllers/whatsapp-templates.controller.ts`), media proxy (`controllers/whatsapp-media.controller.ts`), inbound webhook (`services/whatsapp-webhook.service.ts` — parses messages + delivery/read statuses), account connect/register (`services/connect-account.service.ts`).
- **In the Postman collection but NOT yet implemented:** outbound *mark-as-read* & *typing indicators*, QR codes, commerce settings, Payments API (SG/IN order messages), analytics, billing, block users, business compliance, deregister, business portfolio. (Read status is only *received* via webhook, not sent.)

## Infra — `docker-compose.yml`

- `redis` (`redis:7-alpine`, `wacrm-redis`).
- `api` (`wacrm-api`, `8001:8001`, `REDIS_URL=redis://redis:6379`).
- `web` (`wacrm-web`, `3031:3000`).

## Conventions & gotchas

- **Next.js 16 / React 19** — don't assume older Next APIs; consult the bundled docs first.
- Meta API helpers use **named-parameter objects**, not positional args — match that style.
- Tests are **vitest**.
- `v1/*` controllers = public API (api-key auth); `whatsapp/*` & dashboard controllers = internal (Supabase cookie auth). Pick the right guard.
- `auth.*` Prisma models are Supabase-managed — avoid writing to them directly.
- Enforce **account/tenant scoping** on every query — this is a multi-tenant app.
