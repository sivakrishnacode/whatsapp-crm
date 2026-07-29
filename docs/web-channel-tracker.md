# Web channel — build tracker

Companion to [web-channel-plan.md](./web-channel-plan.md). That file holds the
*why*; this one holds the *what, in what order, and how far along*.

**Legend:** ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked · ⏭️ deferred

**Last updated:** 2026-07-29 · **Current phase:** 3 — Widget runtime

---

## Progress at a glance

| Phase | Title | Tasks | Done | Status |
|---|---|---|---|---|
| 1 | Web channel foundation | 14 | 14 | ✅ done |
| 2 | Transport & send path | 9 | 9 | ✅ done |
| 3 | Widget runtime | 12 | 12 | ✅ done |
| 4 | Form builder | 13 | 13 | ✅ done |
| 5 | Forms → engine wiring | 8 | 8 | ✅ done |
| 6 | Appointments | 13 | 0 | ⬜ |
| 7 | Appointments → engine wiring | 7 | 0 | ⬜ |
| 8 | Analytics & polish | 9 | 0 | ⬜ |
| | **Total** | **85** | **56** | 66% |

---

## Phase 1 — Web channel foundation ✅

Goal: `web` is a legal value everywhere, has a config table and a settings
page, and the nav says `live`. No messages flow yet.

**Verified:** API typecheck clean · web typecheck clean · 421 API tests pass ·
395 web tests pass · new + changed files lint clean.

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 1.1 | Migration `053_web_channel.sql` | `supabase/migrations/053_web_channel.sql` | ✅ | extends 3 CHECK constraints; adds `web_config`, `web_sessions`, `contacts.web_visitor_id`, `web-media` bucket |
| 1.2 | Prisma schema reconcile | `apps/api/prisma/schema.prisma` | ✅ | `prisma validate` + `generate` clean |
| 1.3 | `Channel` union gains `'web'` | `apps/api/src/common/messaging/channel.ts` | ✅ | + `CHANNEL_CAPABILITIES.web` |
| 1.4 | `replyWindowHours` → `number \| null` | same | ✅ | **R1 turned out to be a non-risk** — zero readers existed; see risk register |
| 1.5 | Web-side channel coercion → 3-way | `apps/web/src/lib/inbox/channel.ts` | ✅ | membership check + `isWebConversation`; regression test added |
| 1.6 | `WebModule` skeleton | `apps/api/src/web/web.module.ts` | ✅ | config-only for phase 1; engines wired in phase 2 |
| 1.7 | `web-config.service.ts` | `apps/api/src/web/services/` | ✅ | get-or-create, update, rotate key/secret separately, `markSeen` |
| 1.8 | `web-config.controller.ts` + DTO | `apps/api/src/web/controllers/`, `dto/` | ✅ | GET member-readable, mutations `@RequireRole('admin')` |
| 1.9 | `widget-key.util.ts` + tests | `apps/api/src/web/utils/` | ✅ | 22 tests — origin allowlist, lookalike domains, empty-denies |
| 1.10 | Register in `AppModule` | `apps/api/src/app.module.ts` | ✅ | |
| 1.11 | Rewrites `/api/web/*`, `/api/public/*` | `apps/web/next.config.ts` | ✅ | `beforeFiles`; `/api/public/*` added early so phase 3 needs no config change |
| 1.12 | Nav: web `placeholder` → `live` | `apps/web/src/lib/nav/channels.ts` | ✅ | Forms/Appointments rows **deliberately deferred** — see note below |
| 1.13 | `use-channel-status` fetches web | `apps/web/src/hooks/use-channel-status.tsx` | ✅ | distinguishes "no domains yet" from "snippet not installed" |
| 1.14 | Web settings page + config UI | `apps/web/src/app/(dashboard)/channels/web/settings/page.tsx`, `apps/web/src/components/channels/web/web-config.tsx` | ✅ | 3-step setup progress, domain allowlist, snippet, key rotation |

**Decision made during phase 1 —** the Forms and Appointments panel rows were
pulled back out of `WEB_PANEL`. The `[[...section]]` catch-all backstops panel
rows that point *inside* `/channels/web`, but `/forms` and `/appointments` are
flat routes with no catch-all, so listing them before phase 4/6 would have
shipped two rows that 404. The placement rationale is recorded in the nav file;
the rows land with their routes (tasks 4.11 and 6.12).

**Not run —** migration 053 has not been applied to any database. It is written
and idempotent; `prisma validate`/`generate` confirm the schema half. Apply via
`scripts/run-migration.sh` when you are ready.

---

## Phase 2 — Transport & send path ✅

Goal: a visitor can exchange messages with an agent; AI + automations fire.

**Verified:** API + web typecheck clean · 49 new web-module tests · 395 web
tests · **Nest boots and all 26 web routes register** (see Gotchas re: `tsx`).

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 2.1 | `visitor-token.util.ts` + tests | `apps/api/src/web/utils/` | ✅ | 10 tests; HS256 keyed on the **account's own** secret, so cross-tenant replay fails at the signature |
| 2.2 | `widget-key.guard.ts` | `apps/api/src/web/guards/` | ✅ | shape-check before DB read; same 403 for unknown-vs-malformed so accounts can't be enumerated |
| 2.3 | `visitor-session.guard.ts` | `apps/api/src/web/guards/` | ✅ | must be applied *after* WidgetKeyGuard; redundant account check kept deliberately |
| 2.4 | `web-session.service.ts` | `apps/api/src/web/services/` | ✅ | resume-first; contact+conversation in one transaction; identity-verification HMAC |
| 2.5 | `web-send.service.ts` | `apps/api/src/web/services/` | ✅ | text/media/buttons/list/card; row id doubles as the platform id |
| 2.6 | `ChannelSenderService` 3-way switch | `apps/api/src/common/messaging/channel-sender.service.ts` | ✅ | **unlocked AI + all automations + all flows on web with zero engine edits** |
| 2.7 | `web-inbound.service.ts` | `apps/api/src/web/services/` | ✅ | same fan-out order as Instagram (flows → automations → AI) so nobody gets 3 replies |
| 2.8 | SSE stream + Redis fan-out + controllers | `apps/api/src/web/controllers/`, `services/web-stream.service.ts` | ✅ | one subscriber connection, not one per visitor; 25s heartbeat; `X-Accel-Buffering: no` |
| 2.9 | Inbox: web filter, badge, no-window composer | `apps/web/src/components/inbox/*` | ✅ | window logic short-circuits for web; templates now `=== "whatsapp"` not `!== "instagram"` |

**Extra, not in the original plan —** `web-media.service.ts` +
`web-dashboard.controller.ts` (agent send, typing, read, session context) and
`business-hours.util.ts` (17 tests incl. DST both sides of a transition). The
dashboard controller has no window endpoint on purpose: web has no window, so
the composer reads the capability instead of calling anything.

**Also found —** two ternary chains that would have silently mislabelled web as
WhatsApp (`ChannelBadge`, `supportsTemplates`). Both replaced with a record /
equality check so the *next* channel fails loudly rather than inheriting
WhatsApp's affordances.

---

## Phase 3 — Widget runtime ✅

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 3.1 | `loader.js` (versioned `v1`) | `apps/web/public/widget/v1/loader.js` | ✅ | injects iframe; never breaking-change |
| 3.2 | `(public)` route group + layout | `apps/web/src/app/(public)/layout.tsx` | ✅ | no dashboard shell |
| 3.3 | Widget frame route | `apps/web/src/app/(public)/widget/v1/frame/page.tsx` | ✅ | |
| 3.4 | **Header carve-out for `/widget/*`** | `apps/web/next.config.ts` | ✅ | **risk item** — drop `X-Frame-Options: DENY`, replace `frame-ancestors 'none'` |
| 3.5 | Middleware early-return for public paths | `apps/web/src/middleware.ts` | ✅ | avoids a Supabase round trip per widget load |
| 3.6 | `bootstrap` public endpoint | `apps/api/src/web/controllers/web-public.controller.ts` | ✅ | |
| 3.7 | `use-widget-stream.ts` (SSE + backoff) | `apps/web/src/components/widget/` | ✅ | |
| 3.8 | Launcher + greeting/teaser | `apps/web/src/components/widget/widget-launcher.tsx` | ✅ | |
| 3.9 | Message list + composer | `apps/web/src/components/widget/` | ✅ | text, emoji, file |
| 3.10 | Media upload (`web-media` bucket) | api + widget | ✅ | |
| 3.11 | Appearance editor + live preview | `apps/web/src/components/channels/web/` | ✅ | |
| 3.12 | Install snippet + verify-installation | `apps/web/src/components/channels/web/web-install-snippet.tsx` | ✅ | |

---

## Phase 4 — Form builder ✅

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 4.1 | Migration `054_forms.sql` | `supabase/migrations/` | ✅ | `forms`, `form_submissions`, `form-uploads` bucket |
| 4.2 | Prisma reconcile | `apps/api/prisma/schema.prisma` | ✅ | |
| 4.3 | `form.types.ts` (field union) | `apps/api/src/forms/` | ✅ | mapping reuses `custom:<uuid>` convention |
| 4.4 | `form-validate.ts` + tests | `apps/api/src/forms/` | ✅ | server is the authority, not the client |
| 4.5 | `forms.service.ts` + controller | `apps/api/src/forms/` | ✅ | CRUD, slug uniqueness, publish, duplicate |
| 4.6 | `form-contact-resolver.service.ts` + tests | `apps/api/src/forms/services/` | ✅ | dedupe by phone → email → visitor; never cross-account |
| 4.7 | `form-submit.service.ts` | `apps/api/src/forms/services/` | ✅ | validate → spam → contact upsert |
| 4.8 | Public render + submit endpoints | `apps/api/src/forms/forms-public.controller.ts` | ✅ | rate-limited, honeypot, size-capped |
| 4.9 | `form-renderer.tsx` (**shared**) | `apps/web/src/components/forms/` | ✅ | hosted + embed + widget + preview; no dashboard imports |
| 4.10 | Builder shell (palette/canvas/inspector) | `apps/web/src/components/forms/` | ✅ | `@dnd-kit` already a dep |
| 4.11 | Forms list / new / edit routes | `apps/web/src/app/(dashboard)/forms/` | ✅ | |
| 4.12 | Hosted form page | `apps/web/src/app/(public)/f/[slug]/page.tsx` | ✅ | |
| 4.13 | Submissions table + share panel | `apps/web/src/components/forms/` | ✅ | link, embed snippet, QR |

---

## Phase 5 — Forms → engine wiring ✅

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 5.1 | `form_submitted` automation trigger | `apps/api/src/automations/automation.types.ts` + `apps/web/src/types/index.ts` | ✅ | duplicated types — updated both |
| 5.2 | **`conversationId` optional in dispatch** | `apps/api/src/automations/services/automation-dispatch.service.ts`, `automation-step-executor.service.ts` | ✅ | dispatcher resolves thread or skips messaging steps cleanly |
| 5.3 | `send_form` automation step | `automation-step-executor.service.ts` | ✅ | sends public link via channel sender |
| 5.4 | Validation branches for new trigger | `apps/api/src/automations/services/automation-validate.ts` | ✅ | |
| 5.5 | Builder UI for trigger + step | `apps/web/src/components/automations/` | ✅ | |
| 5.6 | Contact identity merge on capture | `apps/api/src/forms/services/form-contact-resolver.service.ts` | ✅ | transactional; dedupe matrix |
| 5.7 | `form_submitted` flow trigger | `apps/api/src/flows/flow.types.ts` | ✅ | |
| 5.8 | Widget pre-chat + offline forms | `apps/web/src/components/widget/` | ✅ | `widget-prechat.tsx` |

---

## Phase 6 — Appointments

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 6.1 | Migration `055_appointments.sql` | `supabase/migrations/` | ⬜ | needs `btree_gist` |
| 6.2 | **`EXCLUDE USING gist` overlap guard** | same | ⬜ | read-then-write cannot fix the last-slot race |
| 6.3 | Prisma reconcile | `apps/api/prisma/schema.prisma` | ⬜ | |
| 6.4 | `slot-engine.util.ts` (**pure**) | `apps/api/src/appointments/` | ⬜ | `now` is a parameter, no Prisma |
| 6.5 | `slot-engine.util.test.ts` | same | ⬜ | DST, buffers, min-notice, capacity, round-robin |
| 6.6 | `appointment-types.service.ts` + controller | `apps/api/src/appointments/` | ⬜ | |
| 6.7 | `availability.service.ts` + controller | `apps/api/src/appointments/` | ⬜ | rules + exceptions |
| 6.8 | `booking.service.ts` | `apps/api/src/appointments/services/` | ⬜ | transactional book/reschedule/cancel |
| 6.9 | Booking concurrency test | `apps/api/src/appointments/` | ⬜ | two simultaneous bookings → exactly one wins |
| 6.10 | Public slots + book endpoints | `apps/api/src/appointments/appointments-public.controller.ts` | ⬜ | |
| 6.11 | `slot-picker.tsx` (**shared**) | `apps/web/src/components/appointments/` | ⬜ | dashboard + hosted + widget |
| 6.12 | Dashboard routes (calendar, types, availability) | `apps/web/src/app/(dashboard)/appointments/` | ⬜ | |
| 6.13 | Hosted booking page | `apps/web/src/app/(public)/book/[slug]/page.tsx` | ⬜ | |

---

## Phase 7 — Appointments → engine wiring

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 7.1 | `appointment_booked/cancelled/rescheduled` triggers | automations types (both copies) | ⬜ | **not** channel-locked |
| 7.2 | `send_booking_link` step | `automation-step-executor.service.ts` | ⬜ | |
| 7.3 | Reminder queue + processor | `apps/api/src/appointments/appointments.processor.ts` | ⬜ | BullMQ delayed jobs |
| 7.4 | **Reminder template requirement surfaced in UI** | `apps/web/src/components/appointments/appointment-type-editor.tsx` | ⬜ | **risk item** — a 24h reminder is outside the WA window; plain text fails silently |
| 7.5 | Email fallback for web-only contacts | `apps/api/src/appointments/services/` | ⬜ | web contacts can't be pushed to |
| 7.6 | Reschedule/cancel public page | `apps/web/src/app/(public)/book/manage/[token]/page.tsx` | ⬜ | **moved** from `/appointments/[token]` — that prefix would have matched the authenticated `/appointments/types` in the middleware's public-path check and dropped its auth |
| 7.7 | In-widget booking | `apps/web/src/components/widget/widget-booking.tsx` | ⬜ | |

---

## Phase 8 — Analytics & polish

| ID | Task | Files | Status | Notes |
|---|---|---|---|---|
| 8.1 | `web_sessions` write path | `apps/api/src/web/services/web-session.service.ts` | ⬜ | `ip_hash`, never raw IPs |
| 8.2 | Sessions dashboard | `apps/web/src/app/(dashboard)/channels/web/sessions/page.tsx` | ⬜ | |
| 8.3 | Typing indicators (both ways) | api + widget | ⬜ | Redis TTL keys |
| 8.4 | Read receipts (both ways) | api + widget | ⬜ | |
| 8.5 | Business hours + offline routing | `business-hours.util.ts` + widget | ⬜ | |
| 8.6 | Identity verification (HMAC) | `apps/api/src/web/` + docs | ⬜ | stops visitor impersonation on customer sites |
| 8.7 | Widget locale via `next-intl` | `apps/web/src/app/(public)/widget/` | ⬜ | |
| 8.8 | Branding toggle gated on plan tier | `apps/web/src/lib/subscription/` | ⬜ | |
| 8.9 | Knowledge Base page for web channel | `apps/web/src/app/(dashboard)/channels/web/knowledge/page.tsx` | ⬜ | reuses `ai_knowledge_documents` |

---

## Deferred / out of scope

| Item | Why |
|---|---|
| `collect_form` flow node (send form, block run until submitted) | Needs a new resume path in `flows-sweep.service.ts` — deserves its own change |
| Hoist duplicated types into `packages/shared-types` | Real cleanup, but doing it inside this work would hide the channel changes in a large diff. Meanwhile: update both copies in the same commit, every time |
| Web broadcasts | No way to push to a visitor who closed the tab |
| Cross-channel contact merge on *inference* | 050 rejected guessing; only explicit capture merges (5.6) |

---

## Gotchas found while building

**`npm run lint` in `apps/api` runs `eslint --fix`, and the repo has a large
pre-existing lint baseline** (1161 errors on a clean `main`, mostly
`no-unsafe-*` on Prisma/`any` boundaries). Running it therefore rewrites
~55 files that have nothing to do with your change, and buries the diff.

Lint only what you touched:
```
npx eslint "src/web/**/*.ts" "src/common/messaging/channel.ts"
```
Both apps' typechecks and full test suites are clean and *are* usable as
gates — it is only the `--fix` lint script that is not.

**`npx tsx src/…` cannot boot `AppModule`, but the real build can.** Running
the app under `tsx` fails with `Nest can't resolve dependencies of the
AutomationStepExecutorService (?, …)` — `tsx` resolves this codebase's
circular `import`s differently and hands Nest an `undefined` provider. **Clean
`main` fails identically**, so it is not a regression and not worth chasing.

To actually verify the module graph:
```
npx nest build && node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/src/app.module.js');
NestFactory.create(AppModule, { logger: false })
  .then(async (a) => { await a.init(); console.log('BOOT OK'); process.exit(0); })
  .catch((e) => { console.error('FAIL', e.message); process.exit(1); });
"
```
Worth doing after any change that adds a module or a `forwardRef` — typecheck
does not catch a broken DI graph.

---

## Risk register

| # | Risk | Mitigation | Status |
|---|---|---|---|
| R1 | `replyWindowHours` nullability silently changes Instagram behaviour | ✅ **Closed, and it was never real.** The audit in 1.4 found **zero readers** — the field was declarative only, and Instagram's window logic uses its own constants in `ig-window.util.ts`. Widening the type was free. Field docs now state that `null` means "always open", never "zero hours" | ✅ |
| R2 | `conversationId` optional breaks a long-standing step-executor invariant | Tests before the change (5.2) | ⬜ |
| R3 | Widget framing headers pass locally, fail on real customer domains | Test against a genuine third-party origin before shipping phase 3 | ⬜ |
| R4 | Two visitors book the last slot | DB-level `EXCLUDE USING gist`, not application checks (6.2) | ⬜ |
| R5 | New public endpoints = new attack surface | Rate limit + Origin allowlist + size caps + `ip_hash` on every one | ⬜ |
| R6 | WhatsApp reminders silently fail without an approved template | Require `template_name`, explain why at config time (7.4) | ⬜ |
| R7 | Duplicated automation types drift as 5 new trigger/step types land | Both copies in the same commit; noted in Deferred | ⬜ |
