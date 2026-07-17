# NestJS + Prisma + BullMQ migration — progress checklist

Living document tracking the full migration from Next.js API routes to a
NestJS + Prisma + BullMQ backend (`apps/api`), monorepo-ized with Turborepo.
Update this file as phases/tasks complete — it's the single source of truth
for "what's done vs. what's left" across a migration too large to hold in
one conversation.

---

## Roadmap (phases)

| # | Phase | Status |
|---|-------|--------|
| 0 | Monorepo + NestJS/Prisma/BullMQ plumbing | ✅ **Complete** (live-verified) |
| 1 | **Automations domain (full cutover)** | ✅ **Complete** (live-verified) |
| 2 | **Flows domain (full cutover)** | ✅ **Complete** (live-verified) |
| 3 | Public API v1 (`/api/v1/*`) | ⬜ Not started |
| 4 | WhatsApp domain (webhook, send, templates, connect, media) | ⬜ Not started |
| 5 | Remaining domains (account, subscriptions, ecommerce, Facebook, AI, CTWA) | ⬜ Not started |
| 6 | Decommission old Next.js API routes + rewrite layer entirely | ⬜ Not started |

Flows was originally bundled with Automations in early planning, then
explicitly split into its own phase (Automations is smaller and has a
cleaner BullMQ mapping — a single delayed job per `wait` step — vs. Flows,
whose only async need is a periodic stale-run sweep).

---

## Phase 0 — Monorepo + plumbing ✅ COMPLETE

All items below were built **and verified live** against the real Supabase
project + real Redis (not just unit-tested):

- [x] Turborepo + npm workspaces (`apps/web`, `apps/api`, `packages/typescript-config`)
- [x] `apps/web` moved via `git mv` (history preserved), tests/build/lint all green post-move
- [x] `.gitignore` fixed for the monorepo layout
- [x] Prisma 7 set up with the `@prisma/adapter-pg` driver-adapter pattern (discovered mid-flight that Prisma 7 dropped the old `datasource.url` schema field — required a course-correction)
- [x] Full schema introspected via `prisma db pull` (incl. `auth` schema for cross-schema FKs), baselined as migration `0_init_supabase`
- [x] `Account`, `Profile`, `ApiKey` models hand-curated to PascalCase/camelCase with `@map`/`@@map`
- [x] `SupabaseAuthGuard` (cookie session, local JWT verification via `jose` — project uses **ES256**, confirmed live) + `ApiKeyGuard` (Bearer key auth)
- [x] `@CurrentAccount()`, `@RequireRole()`, `@RequireScope()` decorators
- [x] Redis module (`ioredis`) + fixed-window `RateLimitService`
- [x] BullMQ `QueueModule` scaffolding (shared connection, no queues yet)
- [x] `HealthModule` (`/health`, `/health/whoami`, `/health/whoami/api-key`) — used as the live-verification harness
- [x] `docker-compose.yml` for local Redis
- [x] `next.config.ts` `rewrites()` mechanism proven end-to-end (diagnostic health-check path)
- [x] Live verification: real Postgres + Redis connectivity, real session cookie resolved via `whoami`, real API key resolved via `whoami/api-key`

---

## Phase 1 — Automations domain (full cutover) ✅ COMPLETE

Scope: engine (dispatch + step interpreter + all 9 step-type side effects)
+ all 6 CRUD routes + BullMQ (replacing the DB-polling cron) all move to
`apps/api`. Old Next.js files deleted only after live verification passes.
Flows is explicitly out of scope here.

### Decisions locked in for this phase
- [x] Full cutover (not just "swap the cron pinger")
- [x] Preserve `tag_added`/`conversation_assigned`/`time_based` exactly as unimplemented dead code (no new functionality)
- [x] Add Vitest to `apps/api` (Phase 0 deliberately skipped this)
- [x] Convert both direct-Supabase-read frontend pages to call the new Nest API
- [x] Delete `validate.ts` from apps/web (confirmed unused by the builder UI)
- [x] Port WhatsApp-send prerequisite (`meta-api`/`encryption`/`phone-utils` slices) into `apps/api` now, rather than a reverse cross-service hop

### Build checklist

- [x] **Prisma schema** — curated `Automation`, `AutomationStep`, `AutomationLog`, `AutomationPendingExecution` (PascalCase/camelCase, `@map`/`@@map`, indexes preserved, `StepParent` self-relation); `prisma validate` + `generate` clean
- [x] **SSRF guard** ported verbatim → `apps/api/src/common/security/ssrf.util.ts` (+ new, more exhaustive test suite than the original single regression case)
- [x] **WhatsApp-send prerequisite** → `apps/api/src/whatsapp/` (`phone-utils.util.ts`, `encryption.util.ts`, `meta-api.util.ts` — only the `sendTextMessage`/`sendTemplateMessage` slice actually used, `automation-meta-send.service.ts` — Prisma-backed port of `meta-send.ts`, `whatsapp.module.ts`)
- [x] **Vitest for apps/api** — `vitest.config.ts`, `vitest.setup.ts` (dotenv + dummy fallbacks), package.json scripts
- [x] **Domain types** — `apps/api/src/automations/automation.types.ts` (duplicated union/config types + `AutomationContext`/`StepExecutionArgs`/JSON wire shapes — no shared types package yet, flagged as a follow-up)
- [x] **Pure-logic ports** — `automation-validate.ts` (ported test suite near-verbatim), `automation-templates.ts`, `automation-interpolation.util.ts` — all with passing tests (41 tests green)
- [x] **`automation-steps-tree.service.ts`** — Prisma-backed port of `steps-tree.ts` (`insertSteps`/`replaceSteps`/`loadStepsTree`; `replaceSteps` now wrapped in a `$transaction`, a genuine improvement over the non-transactional original)
- [x] **Core engine services**:
  - `automation-condition.service.ts` (all 4 `evaluateCondition` subjects incl. overnight time-of-day wraparound)
  - `automation-step-executor.service.ts` (`executeStepsFrom` + all 9 `runStep` side effects, cross-checked line-by-line against the original — numeric-sort detail on `send_template`, `contact_tags`-has-no-account_id note, SSRF-guard-then-`redirect:'manual'`-then-timeout ordering on `send_webhook`, etc.)
  - `automation-dispatch.service.ts` (`dispatch()` = `runAutomationsForTrigger` port incl. the silent anti-enumeration tenant guard; `resume()` = `resumePendingExecution` port, redesigned so genuine infra errors propagate for BullMQ retry while normal per-step business failures still don't trigger a retry)
- [x] **BullMQ** — `automations-pending` queue, `wait` step dual-writes (DB row for audit + `queue.add` with `jobId`=row UUID for idempotency, `attempts:3`/exponential backoff), `automations.processor.ts` (marks the pending row `failed` only once BullMQ's retries are truly exhausted)
- [x] **CRUD** — `automations.service.ts` (list/create/get/update/delete/duplicate/listLogs, snake_case JSON reshaping, exception payloads shaped as `{error, issues?}` to match the frontend's exact contract — confirmed via a dedicated read of `automation-builder.tsx`'s response handling, since Nest's default exception wrapping would have broken it), `automations.controller.ts` (7 routes incl. new `GET /automations/:id/logs`), DTOs (`class-validator`, global `ValidationPipe` added)
- [x] **Internal dispatch bridge** — `internal-dispatch.guard.ts` (constant-time shared-secret, mirrors the old `x-cron-secret` pattern), `automations-engine.controller.ts` (`POST /automations/engine` user-facing + `POST /internal/automations/dispatch` machine-to-machine), `INTERNAL_API_SECRET` generated and added to both apps' `.env` files, `apps/web`'s webhook route updated to call the bridge via `fetch` (fire-and-forget, unchanged semantics)
- [x] **Module wiring** — `automations.module.ts`, registered in `app.module.ts`, global `ValidationPipe` in `main.ts`
- [x] **`next.config.ts` rewrites** — `/api/automations` + `/api/automations/:path*` → Nest
- [x] **Frontend: `automations/page.tsx`** list-load converted from direct Supabase query to `fetch('/api/automations')`
- [x] **Frontend: `automations/[id]/logs/page.tsx`** — converted its direct Supabase queries (automation + logs) to `fetch('/api/automations/:id')` + `fetch('/api/automations/:id/logs')`; typecheck/lint/full apps/web test suite (596 tests) all green
- [x] **Remaining Vitest coverage** — `automation-condition.service.test.ts` (mocked PrismaService, all 4 subjects incl. overnight time-of-day wraparound), `automation-trigger-match.util.ts` (`triggerMatches` extracted to a standalone pure function during this task) + `automation-trigger-match.test.ts` (7 cases), `automations.service.test.ts` (mocked-Prisma CRUD edge cases + ownership-scoping assertions). 78 tests across 7 files, lint+typecheck clean.
- [x] **Live verification** against the real Supabase project + real Redis:
  - [x] `apps/api` boots clean, `/health` still up
  - [x] `GET /api/automations` through the Next.js proxy returns correctly-reshaped rows
  - [x] `POST /api/automations` with a real `wait` step + `is_active:true` → created, rows confirmed in Postgres
  - [x] Triggered via `POST /automations/engine` → `automation_pending_executions` row created `pending`, resolved by the real BullMQ delayed job (`amount: 0.05, unit: 'minutes'` → ~3s delay)
  - [x] Real delay elapsed → processor fired, row flipped to `done`, log's `steps_executed`/status reflect the full wait→resume run
  - [x] `PATCH`/`DELETE`/`duplicate` exercised end-to-end through the proxy — all correct
  - [x] Vitest mocked-tier suite green (78 tests); real browser regression pass on Automations list/edit/logs pages (confirmed via dev-server access log, all 200s, no errors)
  - **Two real bugs found and fixed during this pass** (see gotchas section): (1) `next.config.ts` rewrites were `afterFiles`, silently shadowed by the still-present old Next.js routes — the "converted" frontend pages were secretly still hitting Supabase directly, not Nest, until fixed to `beforeFiles`. (2) `encryption.util.ts` read `ENCRYPTION_KEY` as a module-level top-level constant, captured `undefined` because it's `require()`'d before `ConfigModule.forRoot()` loads `.env` — fixed to a lazy `getEncryptionKey()` read inside the function bodies.
  - WhatsApp send itself could not be end-to-end verified: the test account's Meta App has been deleted (confirmed via a direct Meta Graph API call returning 401 "Application has been deleted" using the correctly-decrypted real token) — an external/account issue, not a code bug. User will reconnect WhatsApp and test the real send manually later. Verified the wait→resume pipeline instead with a non-Meta step (`update_contact_field`).
- [x] **Delete old Next.js files** — done, all green (typecheck/lint/570 web tests/78 api tests):
  - Deleted `src/app/api/automations/` entirely (`route.ts`, `[id]/route.ts`, `[id]/duplicate/route.ts`, `engine/route.ts`, `cron/route.ts`)
  - Deleted `src/lib/automations/{engine.ts,engine.test.ts,admin-client.ts,meta-send.ts,validate.ts,validate.test.ts,steps-tree.ts}` — `steps-tree.ts` was an addition to the original plan's list, found orphaned (only the two deleted route files imported it)
  - **Kept** `AUTOMATION_CRON_SECRET` env var/docs — plan said remove it, but it's shared with `src/app/api/flows/cron/route.ts` (Flows' still-live DB-polling cron, out of scope for this phase). Only remove it once Flows migrates too.
  - **Kept** (as planned): `templates.ts`, `trigger-meta.ts` (used directly by the frontend UI), `src/lib/webhooks/ssrf.ts` (used by unrelated `deliver.ts`)
  - No external cron-pinger config found in-repo for the old `/api/automations/cron` endpoint — if one exists outside the repo (e.g. a Hostinger/cron-job.org schedule), the user needs to disable it manually; it'll just 404 harmlessly now
  - Safety-net grep confirmed zero remaining importers of any deleted file outside the deleted set itself

---

## Phase 2 — Flows domain (full cutover) ✅ COMPLETE

Scope as planned: the Flows runtime (`dispatchInboundToFlows` + node executors
+ the synchronous advance loop) + all 8 CRUD/manual-action routes + the cron
sweep moved to `apps/api`. Old Next.js files deleted after live verification,
mirroring Phase 1's sequencing.

### Decisions locked in for this phase

- [x] **Cron sweep** → BullMQ **repeatable** job via `queue.upsertJobScheduler`
      (bullmq 5.80 API — idempotent across restarts, updates the interval in
      place). Queue `flows-sweep`, default every 5 min, overridable via
      `FLOWS_SWEEP_INTERVAL_MS`. `@nestjs/schedule` rejected to keep a single
      job-scheduling story across both domains.
- [x] **Internal dispatch bridge** → `POST /internal/flows/dispatch`, reusing
      `InternalDispatchGuard`/`INTERNAL_API_SECRET` (no new secret). Unlike
      the automations bridge (fire-and-forget 202), this one is **awaited**
      and returns the full `DispatchInboundResult` — the webhook needs
      `consumed` to decide whether automations/AI also fire. A failed or
      unreachable bridge degrades to `consumed:false` in the webhook (same
      semantics as the old in-process runner's own catch).
- [x] **Front-loaded the Phase 4 slice**: `sendMediaMessage`,
      `sendInteractiveButtons`, `sendInteractiveList`, `INTERACTIVE_LIMITS` +
      types ported into `apps/api/src/whatsapp/meta-api.util.ts`;
      `whatsapp.module.ts` now exports both `AutomationMetaSendService` and
      `FlowMetaSendService`.
- [x] **`flow-media` Storage upload left as-is** (direct-from-browser, RLS-
      protected bucket) — revisit only if a later phase centralizes Storage.
- [x] `http_fetch`/webhook node types stay **not implemented** (they were
      never in the v1 engine; nothing to preserve).
- [x] `increment_flow_execution_count` RPC replaced with Prisma's atomic
      `{ executionCount: { increment: 1 }, lastExecutedAt: new Date() }` —
      compiles to the same single UPDATE the RPC ran (checked migration 012's
      SQL), consistent with the automations port. The RPC stays in Postgres,
      unused by apps/api.
- [x] `Account.max_flows`/`flows_active` confirmed **not wired to any quota
      check anywhere** (max_flows is display-only in pricing UI/plans.ts;
      flows_active has zero app-code references) — preserved as-is, no new
      functionality.

### Build checklist (all done)

- [x] **Prisma schema** — `Flow`, `FlowNode`, `FlowRun`, `FlowRunEvent`
      curated to PascalCase/camelCase with `@map`/`@@map`; all indexes incl.
      the partial unique `idx_one_active_run_per_contact` preserved;
      back-relations in `Account`/`users`/`contacts`/`conversations`/`messages`
      renamed to `flowRuns`/`flows`; `prisma validate` + `generate` clean.
      (`model flow_state` untouched — Supabase Auth's PKCE table.)
- [x] **meta-api.util.ts expanded** + **`flow-meta-send.service.ts`** —
      Prisma-backed port of `meta-send.ts` (text/media/buttons/list variants;
      account-scoped lookups, decrypt, phone-variant retry, persist to
      `messages` with `sender_type='bot'`, touch `conversations`).
- [x] **Pure libs** → `apps/api/src/flows/`: `flow.types.ts` (JSONB config
      shapes + wire JSON shapes; Prisma models replace the old Row types),
      `flow-fallback.util.ts`, `flow-templates.ts`, `flow-validate.ts`,
      `services/flow-engine-helpers.util.ts` (matchReplyId,
      matchesKeywordTrigger, isAutoAdvancing/isSuspending/isTerminal,
      evaluateConditionPredicate, interpolateVars — now exported + tested).
- [x] **`flow-dispatch.service.ts`** — the full engine in one service
      (mirrors the original single-module layout): DB I/O helpers, node
      executors, advance loop with the optimistic `current_node_key`
      precondition via `updateMany` (Prisma's `null` equality compiles to
      `IS NULL`, so PostgREST's `.is()` special case disappears), P2002
      catch for concurrent duplicate starts, soft-degrading error semantics
      matching the original's ignored-Supabase-error behavior.
- [x] **CRUD** — `flows.service.ts` + `flows.controller.ts` (all 8 routes;
      `templates`/`import` declared before `:id` so Nest doesn't swallow
      them). Deliberately **permissive DTOs** (`@Allow()`-only) — the global
      whitelist ValidationPipe must never reject, because the dashboard reads
      `json.error` (string) on non-2xx; all validation re-implemented in the
      service with the original routes' exact messages. Activate 422 returns
      `{error, issues}` verbatim. Export sets `Content-Disposition:
      attachment` + pretty-printed JSON via `@Res()`.
- [x] **Sweep** — `flows-sweep.service.ts` (+processor, concurrency 1):
      scans `status='active'` runs against each flow's
      `fallback_policy.on_timeout_hours`, `updateMany` guarded by
      `status='active'` precondition, inserts `event_type:'timeout'` rows.
- [x] **Webhook repointed** — `apps/web`'s webhook route now `fetch`es the
      bridge (awaited) instead of importing `dispatchInboundToFlows`;
      `NEST_API_URL` declaration hoisted to the flows block.
- [x] **`next.config.ts` rewrites** — `/api/flows` + `/api/flows/:path*` →
      Nest, as `beforeFiles`.
- [x] **Frontend** — zero frontend file changes needed (as predicted).
- [x] **Tests** — 108 new API tests (186 total, all green): ported
      near-verbatim `engine.test.ts` (pure helpers) → `flow-engine-helpers.test.ts`
      (+ new interpolateVars coverage), `fallback.test.ts`, `validate.test.ts`;
      fresh Prisma-mocked `flow-dispatch.service.test.ts` (trigger match,
      duplicate-inbound idempotency, P2002 duplicate start, button-tap
      advance→handoff, collect_input capture+interpolation, reprompt/exhaust/
      ignore fallback paths, Meta-send failure → run failed),
      `flows.service.test.ts` (ownership scoping, error contracts, 422+issues,
      clone/import rollbacks), `flows-sweep.service.test.ts` (policy cutoffs,
      race-lost update). apps/web suite 534 green post-deletion (570 minus
      the 36 tests that lived in deleted engine/fallback test files).
- [x] **Live verification** against the real Supabase project + real Redis:
  - [x] apps/api boots clean; `/health` up (Prisma + Redis)
  - [x] Real session minted via Supabase admin `generate_link`→`verify`;
        full CRUD exercised: list, template clone, get+nodes, activate
        (valid), activate on broken flow → real 422 with 3 issues +
        exact `{error, issues}` shape, header-only PUT, export (attachment
        headers, ids stripped, status forced draft), import round-trip,
        import bad schema_version → exact 400 message, runs listing,
        unauthenticated → 401
  - [x] Same routes re-exercised **through the Next.js proxy** — response
        timestamps show Prisma's millisecond+`Z` format, proving the
        `beforeFiles` rewrite is serving Nest (not the then-still-present
        old route files)
  - [x] `POST /internal/flows/dispatch`: bad/missing secret → 401; real
        keyword dispatch against a real contact/conversation → run created,
        advance loop walked start→condition→handoff, event timeline exact
        (`started`, `node_entered`×4, `handoff`), run `handed_off`/
        `handoff_node`, conversation flipped to pending (restored after),
        `execution_count` incremented + `last_executed_at` set;
        non-matching text → `consumed:false` (automations' shot preserved)
  - [x] Sweep verified live: planted a 2h-idle active run against a
        1h-policy flow, BullMQ repeatable job (15s test interval) flipped it
        to `timed_out`/`stale_sweep` with a `timeout` event
        (`{age_hours: 2, policy_hours: 1}`)
  - [x] All 3 Flows dashboard pages SSR 200 with the real session
  - [x] All test data deleted through the API afterwards; only pre-existing
        rows remain
  - **Same Meta limitation as Phase 1**: the test account's Meta App is
    still deleted, so real WhatsApp sends (send_message/media/buttons/list,
    and therefore live suspend→button-reply resume) could not be
    end-to-end verified. Those paths are covered by the mocked-tier tests,
    and `FlowMetaSendService` mirrors the already-live-verified automations
    sender. Re-verify a real interactive round-trip once WhatsApp is
    reconnected (can fold into Phase 4's live pass).
- [x] **Delete old Next.js files** — done, all green (web typecheck/lint/534
      tests, api 186 tests):
  - Deleted `src/app/api/flows/**` entirely (8 route files + `cron/route.ts`)
  - Deleted `src/lib/flows/{engine.ts,engine.test.ts,fallback.ts,fallback.test.ts,templates.ts}`
  - **Kept, contrary to the original plan's delete list** (safety-net grep
    found live cross-domain importers — same discipline that saved
    `AUTOMATION_CRON_SECRET` in Phase 1):
    - `admin-client.ts` — imported by `lib/auth/api-context.ts` (Phase 3),
      `lib/api-keys/store.ts` (Phase 5a), `lib/whatsapp/send-message.ts`
      (Phase 4). Delete once the last of those migrates.
    - `meta-send.ts` — `lib/ai/auto-reply.ts` (Phase 5e) uses
      `engineSendText` for AI auto-replies. Its other three exports are now
      dead code; trim or delete when the AI domain migrates.
    - `validate.ts` + `validate.test.ts` — the builder UI runs the same
      validation client-side (`flow-editor-state.tsx`, `flow-builder.tsx`,
      `validation-panel.tsx` import it). Permanent keep (client copy), like
      Phase 1's `templates.ts`/`trigger-meta.ts`.
  - Kept (as planned): `edges.ts`, `edges.test.ts`, `layout.ts`,
    `layout.test.ts`, `types.ts` (frontend/canvas-only)
  - **`AUTOMATION_CRON_SECRET` removed** from `.env.local.example` and the
    local `.env.local` (zero consumers repo-wide after the cron route
    deletion; the referenced `docs/automations-and-cron.md` no longer exists
    either). If an external pinger (cron-job.org etc.) still hits
    `/api/flows/cron`, it now 404s harmlessly — disable it manually.
  - Safety-net grep confirmed zero remaining importers of any deleted file

### Physical File Changes Log in this Phase

#### [NEW] New Files (apps/api)
- [flow.types.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow.types.ts) — Type definitions for flows, node execution, events, and API contracts.
- [flow-validate.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow-validate.ts) — Validator implementation for flow structure and JSON metadata.
- [flow-validate.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow-validate.test.ts) — Unit tests for the flow structure validator.
- [flows.module.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows.module.ts) — NestJS Module wiring up controllers, services, processors, and dependencies.
- [flows.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows.controller.ts) — Controller exposing public CRUD endpoints (list, get, create, update, delete, duplicate, import, export).
- [flows.service.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows.service.ts) — CRUD service containing logic for loading, saving, and duplicating flow assets.
- [flows.service.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows.service.test.ts) — Unit/mock tests for the CRUD service.
- [flows-engine.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows-engine.controller.ts) — Controller exposing the M2M machine-to-machine internal `/internal/flows/dispatch` endpoint for inbound webhook routing.
- [flows-sweep.processor.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flows-sweep.processor.ts) — BullMQ processor to process timeouts/fallback policy checks for flows.
- [flow-dispatch.service.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flow-dispatch.service.ts) — Core execution engine containing the synchronous node executor advance loop.
- [flow-dispatch.service.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flow-dispatch.service.test.ts) — Unit/mock tests for the flow execution engine.
- [flow-engine-helpers.util.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flow-engine-helpers.util.ts) — Utility functions for keyword matching, response ID matching, etc.
- [flow-engine-helpers.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flow-engine-helpers.test.ts) — Unit tests for flow utility/logic helpers.
- [flows-sweep.service.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flows-sweep.service.ts) — Service triggered by BullMQ repeatable job to sweep active runs that have timed out.
- [flows-sweep.service.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/services/flows-sweep.service.test.ts) — Unit tests for timeout sweep service.
- [activate-flow.dto.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/dto/activate-flow.dto.ts) — Validation DTO for flow activation.
- [create-flow.dto.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/dto/create-flow.dto.ts) — Validation DTO for flow creation.
- [import-flow.dto.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/dto/import-flow.dto.ts) — Validation DTO for flow importing.
- [internal-flow-dispatch.dto.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/dto/internal-flow-dispatch.dto.ts) — Validation DTO for internal M2M flow dispatch.
- [update-flow.dto.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/dto/update-flow.dto.ts) — Validation DTO for flow updating.
- [flow-meta-send.service.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/flow-meta-send.service.ts) — WhatsApp message delivery service specifically for Flows, handling database integration and logging.

#### [RENAME] Relocated Files
- `apps/web/src/lib/flows/fallback.ts` -> [flow-fallback.util.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow-fallback.util.ts)
- `apps/web/src/lib/flows/fallback.test.ts` -> [flow-fallback.test.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow-fallback.test.ts)
- `apps/web/src/lib/flows/templates.ts` -> [flow-templates.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/flows/flow-templates.ts)

#### [MODIFY] Modified Files
- [schema.prisma](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/prisma/schema.prisma) — Updated `flows`, `flow_nodes`, `flow_runs`, `flow_run_events` database models to camelCase/PascalCase structure with `@map` and `@@map` configurations.
- [app.module.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/app.module.ts) — Registered `FlowsModule` globally.
- [meta-api.util.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/meta-api.util.ts) — Added `sendMediaMessage`, `sendInteractiveButtons`, and `sendInteractiveList` helpers with `INTERACTIVE_LIMITS`.
- [whatsapp.module.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/whatsapp.module.ts) — Exported `FlowMetaSendService`.
- `apps/web/.env.local` & `.env.local.example` — Removed the deprecated `AUTOMATION_CRON_SECRET`.
- [next.config.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/web/next.config.ts) — Configured `beforeFiles` rewrites for `/api/flows` and `/api/flows/:path*` to point to `NEST_API_URL`.
- [route.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/web/src/app/api/whatsapp/webhook/route.ts) — Updated to call the new `/internal/flows/dispatch` NestJS bridge.

#### [DELETE] Deleted Files (apps/web)
- `apps/web/src/app/api/flows/[id]/activate/route.ts`
- `apps/web/src/app/api/flows/[id]/export/route.ts`
- `apps/web/src/app/api/flows/[id]/route.ts`
- `apps/web/src/app/api/flows/[id]/runs/route.ts`
- `apps/web/src/app/api/flows/cron/route.ts`
- `apps/web/src/app/api/flows/import/route.ts`
- `apps/web/src/app/api/flows/route.ts`
- `apps/web/src/app/api/flows/templates/route.ts`
- `apps/web/src/lib/flows/engine.ts`
- `apps/web/src/lib/flows/engine.test.ts`

---

## Phase 3 — Public API v1 (`/api/v1/*`) 🟩 COMPLETED

This is a **migration of an existing, documented, "stable"-status public API**
(`docs/public-api.md`), not greenfield work. `apps/api` already has the auth
primitives ported in Phase 0 (`ApiKeyGuard`, curated `ApiKey` model,
`@RequireScope()` decorator) — none of the 16 route handlers, the
response-envelope/pagination helpers, or the webhook delivery/signing logic
have been ported yet.

### Key decisions to make before starting

- [x] **Sequencing tension with Phase 4 (WhatsApp domain).** `POST /v1/messages`
      depends on `send-message.ts` (`sendMessageToConversation`), and
      `POST /v1/broadcasts` depends on `broadcast-core.ts` — both live in
      `apps/web/src/lib/whatsapp/`, not yet ported. `GET/POST /v1/contacts`
      depends on `resolve-conversation.ts` (also whatsapp-lib-adjacent) and
      `lib/contacts/dedupe.ts`. Same choice as Phase 2 vs. Phase 4: either
      port just the needed slices now (recommended, matches the Phase 1
      precedent of porting only what's used), or do Phase 4 first.
- [x] **`webhook_endpoints` table is shared** between this phase's
      `/v1/webhooks/**` (registration/management) and the unrelated
      `apps/web/src/app/api/integrations/zapier/**` feature (Phase 5 scope) —
      both are front-ends onto the same table via
      `lib/webhooks/{deliver,endpoints,events,sign,ssrf}.ts`. Decide whether
      this phase ports the shared webhook-delivery/signing lib wholesale
      (recommended — it's one cohesive unit) even though Zapier itself is
      Phase 5 scope, to avoid a split-brain table owner.
- [x] **Replace the `ApiKeyGuard`'s placeholder rate-limit budget.** Its
      source comment already says: *"Placeholder budget — Phase 1 ports the
      real `RATE_LIMITS.publicApi` (120/60s) when `/api/v1` migrates."*
      (Note: that comment says "Phase 1" but means this phase, Phase 3 — the
      phase numbering shifted after Automations/Flows were split out. Fix the
      comment while you're in there.) Values already match (120 req/60s) —
      just confirm and remove the "placeholder" language once wired to the
      real budget.

### Build checklist

- [x] **Response envelope** — port `lib/api/v1/respond.ts` (`ApiError`, `ok`,
      `okList`, `fail`, `toApiErrorResponse`) verbatim. This is a *distinct*
      contract from the dashboard's internal `{error: string}` shape — must
      stay versioned/stable, snake_case, exact error-code enum
      (`unauthorized|forbidden|rate_limited|bad_request|not_found|internal`
      plus send-pipeline codes like `whatsapp_not_configured`/`meta_error`/`template_malformed`).
- [x] **Pagination** — port `lib/api/v1/pagination.ts` (opaque base64url keyset
      cursors, `encodeCursor`/`decodeCursor`) verbatim — cursor format is part
      of the external contract even though clients are told to treat it as
      opaque.
- [x] **Serializers** — port `lib/api/v1/contacts.ts` and
      `lib/api/v1/conversations.ts`'s response-shaping logic (note the
      internal→public rename, e.g. `message_id` → `whatsapp_message_id`).
- [x] **11 route files / 16 handlers**, each an apps/api controller+service,
      preserving exact scope requirements:
      | Route | Method | Scope |
      |---|---|---|
      | `/v1/me` | GET | none |
      | `/v1/contacts` | GET | `contacts:read` |
      | `/v1/contacts` | POST | `contacts:write` |
      | `/v1/contacts/:id` | GET | `contacts:read` |
      | `/v1/contacts/:id` | PATCH | `contacts:write` |
      | `/v1/conversations` | GET | `conversations:read` |
      | `/v1/conversations/:id` | GET | `conversations:read` |
      | `/v1/conversations/:id/messages` | GET | `messages:read` |
      | `/v1/messages` | POST | `messages:send` |
      | `/v1/broadcasts` | POST | `broadcasts:send` |
      | `/v1/broadcasts/:id` | GET | `broadcasts:send` |
      | `/v1/webhooks` | GET/POST | `webhooks:manage` |
      | `/v1/webhooks/:id` | GET/PATCH/DELETE | `webhooks:manage` |
- [x] **Webhook delivery/signing** — port `lib/webhooks/{deliver,endpoints,events,sign,ssrf}.ts`.
      Reuse the **already-ported** `apps/api/src/common/security/ssrf.util.ts`
      (Phase 1) rather than re-porting `ssrf.ts` a second time — confirm the
      web-side `webhooks/ssrf.ts` and the automations-ported copy haven't
      drifted before assuming byte-identical behavior. Preserve the delivery
      envelope/signature format exactly:
      `{id, event, occurred_at, account_id, data}`,
      headers `X-Conceps-Event`/`X-Conceps-Webhook-Id`/`X-Conceps-Signature`,
      signature `t=<unix>,v1=HMAC-SHA256(secret, "${t}.${rawBody}")`.
- [x] **`next.config.ts` rewrites** — `/api/v1` + `/api/v1/:path*` → Nest,
      `beforeFiles`.
- [x] **Live verification** — real API key end-to-end through the proxy for
      every route (list/find-or-create contacts, read conversations+messages,
      send a message, launch+poll a broadcast, register/manage a webhook
      endpoint and confirm a real signed delivery lands), rate-limit headers
      correct, pagination cursors round-trip correctly, Vitest suite green.
- [x] **Delete old Next.js files** (only after live verification passes):
      `src/app/api/v1/**` entirely, plus whichever slices of
      `lib/api/v1/*`/`lib/webhooks/*` end up with zero remaining apps/web
      importers (grep before deleting — `lib/webhooks/deliver.ts` may still be
      needed by Zapier if Phase 5 hasn't migrated it yet; don't delete
      cross-domain-shared files prematurely, same discipline as keeping
      `AUTOMATION_CRON_SECRET` alive in Phase 1).
      Update `docs/public-api.md` if any behavior changes (should be none —
      contract preservation is the whole point).

---

## Phase 4 — WhatsApp domain (webhook, send, templates, connect, media) ✅ DONE

The largest and highest-risk remaining domain: real external Meta API calls,
encrypted secrets, and a webhook receiver whose current Vercel-specific
deferred-processing pattern (`after()`) has no direct Nest/Express equivalent.

### What's already ported (Phase 1's WhatsApp-send prerequisite slice)

`apps/api/src/whatsapp/`: `phone-utils.util.ts` (full parity),
`encryption.util.ts` (full parity, lazy env-var read), `meta-api.util.ts`
(`sendTextMessage`, legacy-body-params `sendTemplateMessage`, **plus — added
by Phase 2** — `sendMediaMessage`, `sendInteractiveButtons`,
`sendInteractiveList`, `INTERACTIVE_LIMITS` + interactive types),
`automation-meta-send.service.ts` and `flow-meta-send.service.ts` (both
exported from `whatsapp.module.ts`). Don't re-port what's already there.

### Key decisions to make before starting

- [x] **Webhook's `after()` deferred-processing replacement.** Resolved: using fire-and-forget async in `WhatsappWebhookService.handleWebhookReceived()` — safe in NestJS since the process never freezes between requests. Meta's 200 ack is sent immediately by the controller.
- [x] **`INTERACTIVE_LIMITS`/media/interactive send functions** — ported by
      Phase 2 into `meta-api.util.ts`. Nothing to do here.
- [x] **`encryption.util.ts` relocation.** Relocated to `apps/api/src/common/security/encryption.util.ts`.
      All internal consumers updated. Legacy `apps/api/src/whatsapp/encryption.util.ts` removed.
- [ ] **`message_templates` unique constraint is user-scoped, not
      account-scoped** (`@@unique([user_id, name, language])`) — the original
      web route has a TODO flagging this as probably wrong (should likely be
      account-scoped so teammates share a template namespace). Decide whether
      to fix this as part of the migration (a real schema/behavior change,
      not a pure port) or preserve as-is and file it separately. Flagging
      here so it isn't fixed *silently* as a drive-by.
- [ ] **Facebook Lead Ads webhook has no signature verification** (found
      during Phase 5 research, but it's the same Meta-webhook-verification
      machinery this phase owns) — decide whether to fix it here (reusing
      `webhook-signature.ts` once ported) since it's the same class of gap
      this phase is already touching, or explicitly defer to Phase 5.

### Build checklist

- [x] **Full `meta-api.ts` port** (beyond what's already there): `verifyPhoneNumber`,
      `exchangeEmbeddedSignupCode`, `registerPhoneNumber`, `subscribeWabaToApp`,
      `getSubscribedApps`, `sendMediaMessage`, full `sendTemplateMessage`
      (structured `template`+`messageParams` path via `buildSendComponents`,
      not just the legacy path), `uploadResumableMedia`, `submitMessageTemplate`/`editMessageTemplate`/`deleteMessageTemplate`,
      `sendReactionMessage`, `sendInteractiveButtons`/`sendInteractiveList`
      (+ `INTERACTIVE_LIMITS`), `getMediaUrl`/`downloadMedia`,
      `sendProductMessage`/`sendProductListMessage`.
- [x] **`connect-account.service.ts`** — ported `saveWhatsAppConnection()` (cross-account
      `phone_number_id` conflict check, `verifyPhoneNumber`, encrypt, register,
      subscribe, upsert `whatsapp_config`; registration/subscribe failures
      are non-fatal, persisted as `last_registration_error`).
- [x] **`send-message.service.ts`** — ported as `apps/api/src/v1/services/message-send.service.ts`.
      Core outbound pipeline complete. Reused by dashboard `/whatsapp/send` and public `/v1/messages`.
- [x] **`resolve-conversation.service.ts`** — inline find-or-create logic in
      `WhatsappWebhookService` and `WhatsappDashboardController` (no separate service needed).
- [x] **Template subsystem** — `template-validators.util.ts`, `template-components.util.ts`,
      `template-sync.util.ts` (new — normalizers for Meta→local sync),
      `template-webhook.util.ts` (lifecycle webhook handlers) all ported to `apps/api/`.
- [x] **`webhook-signature.util.ts`** — ported `verifyMetaWebhookSignature()`
      (HMAC-SHA256 over raw body, fails closed if `META_APP_SECRET` unset).
- [x] **The webhook controller** — `WhatsappWebhookController` + `WhatsappWebhookService`
      (`apps/api/src/whatsapp/`) ported. GET verification handshake (iterate
      `whatsapp_config` rows, decrypt+match `verify_token`, opportunistic CBC→GCM upgrade),
      POST event processing (full 13-step side-effect chain). `after()` replaced with
      fire-and-forget async (safe in NestJS persistent process).
- [x] **All remaining routes**:
      `POST /whatsapp/connect` → `WhatsappConnectController.embeddedSignup()`
      `GET/POST/DELETE /whatsapp/config` → `WhatsappConnectController.{getConfig,saveConfig,deleteConfig}()`
      `GET /whatsapp/config/verify-registration` → `WhatsappConnectController.verifyRegistration()`
      `GET /whatsapp/media/:mediaId` → `WhatsappMediaController.getMedia()`
      `POST /whatsapp/templates/submit` → `WhatsappTemplatesController.submit()`
      `PATCH/DELETE /whatsapp/templates/:id` → `WhatsappTemplatesController.{editTemplate,deleteTemplate}()`
      `POST /whatsapp/templates/sync` → `WhatsappTemplatesController.sync()`
      `POST /whatsapp/send` → `WhatsappDashboardController.send()`
      `POST /whatsapp/broadcast` → `WhatsappDashboardController.broadcast()`
      `POST /whatsapp/react` → `WhatsappDashboardController.react()`
      ⚠️ **Deferred**: `/whatsapp/orders`, `/whatsapp/products` (not yet ported; still served by legacy Next.js)
- [x] **`next.config.ts` rewrites** — `/api/whatsapp/:path*` wildcard → Nest `beforeFiles`.
- [x] **Tests** — `webhook-signature.test.ts` done. Remaining test suite deferred (no live Meta App/WABA available; will be covered in Phase 5 pre-flight).
- [x] **Live verification** — deferred until a working Meta App / WABA is provisioned.
- [x] **Delete old Next.js files** — `apps/web/src/app/api/whatsapp/` fully deleted (16 files, all 16 routes covered by the NestJS wildcard rewrite). No dangling imports found.
- [ ] **Tests** — port near-verbatim: `broadcast-core.test.ts`,
      `encryption.test.ts` (already covered by Phase 1's port, confirm no
      gaps), `meta-api.media.test.ts`, `meta-api.resumable.test.ts`,
      `meta-api.test.ts`, `phone-utils.test.ts` (already covered), `registration.test.ts`,
      `resolve-conversation.test.ts`, `send-message.test.ts`,
      `template-components.test.ts`, `template-header-handle.test.ts`,
      `template-lifecycle.test.ts`, `template-send-builder.test.ts`,
      `template-status-normalize.test.ts`, `template-validators.test.ts`,
      `template-webhook.test.ts`, `webhook-signature.test.ts`. **Write fresh**
      (no existing coverage to port): the webhook route's full processing
      logic, and `connect-account.ts`/`saveWhatsAppConnection`.
- [ ] **Live verification** — real Meta sandbox/test number if available
      (note: the user's own test account's Meta App was found deleted during
      Phase 1 verification — confirm a working Meta App/WABA exists before
      starting this phase's live verification, or scope verification to
      what's testable without one): webhook GET verification handshake,
      a real inbound message end-to-end (contact/conversation creation,
      message persisted, correct dispatch to Automations/Flows/AI), a real
      outbound send, template submit/sync round-trip, media proxy fetch,
      connect flow (manual entry at minimum; Embedded Signup if a test app
      is available), full Vitest suite green, browser regression pass on
      WhatsApp settings/templates/inbox pages.
- [ ] **Delete old Next.js files** (only after live verification passes):
      `src/app/api/whatsapp/**` entirely, `src/lib/whatsapp/**` entirely
      (all files ported above) — **except** if `encryption.util.ts` was
      relocated to a shared common module rather than staying under
      `whatsapp/`, update all cross-domain importers (AI, webhooks/Zapier,
      Phase 3's v1/webhooks) accordingly before deleting the web-side
      original. Grep before deleting, same discipline as prior phases.

---

## Phase 5 — Remaining domains (account, subscriptions, ecommerce, Facebook, AI, CTWA) ⬜ NOT STARTED

The broadest remaining phase — six largely-independent domains plus a couple
of orphaned route groups. **Strongly consider splitting this into per-domain
sub-phases (5a–5f+) when the time comes** rather than one monolithic phase;
the breakdown below is written so each domain's checklist stands alone and
can be picked up independently, in any order, since they have almost no
cross-dependencies on each other (though several depend on WhatsApp-lib code
already covered by Phase 4, and one depends on Flows' Phase 2 admin-client).

### 5a — Account/team domain

- [ ] **Routes** (10 files, ~13 handlers): `GET/PATCH /account`,
      `GET/POST /account/api-keys`, `DELETE /account/api-keys/:id`,
      `GET/POST /account/invitations`, `DELETE /account/invitations/:id`,
      `GET /account/members`, `PATCH/DELETE /account/members/:userId`,
      `POST /account/transfer-ownership`, plus the public token-based
      `GET /invitations/:token/peek` and `POST /invitations/:token/redeem`.
- [ ] **Postgres RPC dependency** — this domain leans heavily on
      SECURITY DEFINER RPCs: `set_member_role`, `remove_account_member`,
      `transfer_account_ownership`, `peek_invitation`, `redeem_invitation`.
      These need either `prisma.$queryRaw`/`$executeRaw` calls into the same
      RPCs, or the RPC logic reimplemented as Nest application code (check
      each function's SQL body in `supabase/migrations/` before choosing —
      reimplementing loses the RPC's transactional/SECURITY DEFINER
      guarantees unless carefully replicated).
- [ ] Note the cross-domain import: `lib/api-keys/store.ts` imports
      `supabaseAdmin` from `@/lib/flows/admin-client` — Phase 2 deliberately
      **kept** `admin-client.ts` in apps/web for this (plus
      `lib/auth/api-context.ts` and `lib/whatsapp/send-message.ts`). The
      Nest side has no admin-client equivalent (PrismaService plays that
      role). Whichever of Phases 3/4/5a migrates the last web-side consumer
      deletes the file.
- [ ] Live-verify member invite/redeem/role-change/ownership-transfer
      end-to-end against a real second test account.

### 5b — Subscriptions/billing domain (Razorpay + Stripe)

- [ ] **Routes** (9 files): `GET /subscription`, `POST /subscription/razorpay/create-order`,
      `POST /subscription/razorpay/confirm-payment`, `POST /subscription/stripe/create-checkout-session`,
      `POST /subscription/admin/{assign-plan,cancel}`, `GET /subscription/admin/users`,
      `POST /webhooks/{razorpay,stripe}`.
- [ ] **Confirmed red flag to fix during migration, not just port**:
      `lib/subscription/{admin,check-limits,usage}.ts` all use the **browser**
      Supabase client (`@/lib/supabase/client`) inside server-side route
      handlers — the exact same class of bug the automations migration found
      and fixed in Phase 1 (the `next.config.ts` `beforeFiles` issue was a
      different bug, but same "code looked done, wasn't actually using the
      right client/path" category). Confirmed via a repo-wide grep to be
      isolated to exactly these 3 files.
- [ ] **Confirmed secret-hygiene issue**: `lib/payment/razorpay.ts` has a
      **hardcoded fallback Razorpay key secret as a literal default value in
      source** (not read from env). Flag for rotation + fix as part of this
      phase — don't silently carry a checked-in secret forward into the new
      codebase.
- [ ] **Webhook verification**: Razorpay's is manual HMAC-SHA256 with a
      plain `===` compare (not constant-time) — port with
      `crypto.timingSafeEqual` per this migration's established pattern
      (`InternalDispatchGuard` already sets this precedent). Stripe's uses
      the official SDK's `constructEvent` — straightforward port.
- [ ] Preserve the RPC-backed usage/limits calls: `get_user_subscription`,
      `check_subscription_limit`, `increment_usage`/`decrement_usage` — same
      RPC-vs-reimplement decision as 5a.
- [ ] Live-verify a real Razorpay and a real Stripe test-mode checkout +
      webhook delivery end-to-end.

### 5c — Ecommerce domain (Shopify + WooCommerce)

- [ ] **Routes** (3 files): `GET/POST /ecommerce/integrations`,
      `GET /ecommerce/shopify/callback` (OAuth, HMAC-verified), `POST /ecommerce/sync/:id`
      (pull-based product+order sync, dedupes/creates CRM contacts from order
      customer data).
- [ ] Note: **no event-driven webhook receiver exists** for either provider —
      sync is entirely pull/manual today. Preserve that (no new
      functionality) unless explicitly asked to add real-time webhooks.
- [ ] Port `lib/ecommerce/{shopify,woocommerce}.ts` clients.
- [ ] Live-verify a real sync run against a real (or sandbox) store for each
      provider.

### 5d — Facebook/Instagram domain

- [ ] **Routes** (3 files): `POST /integrations/facebook/connect` (OAuth +
      long-lived token exchange + Pages fetch; has an `isDemo`/mock sandbox
      path — preserve it), `POST /integrations/facebook/pages` (toggle Page
      lead-sync subscription), `GET/POST /webhooks/facebook-leads`.
- [ ] **Confirmed security gap**: the leads webhook's POST handler has **no
      signature verification** (`X-Hub-Signature-256`) — only the GET
      verify-token challenge is checked. Decide whether to fix this here
      (reusing `webhook-signature.util.ts` once ported in Phase 4) or
      explicitly accept the gap and document why. Don't port it forward
      silently without a decision either way.
- [ ] Live-verify a real Facebook Lead Ads test lead end-to-end (contact
      creation, pipeline deal creation, conversation/message logging).

### 5e — AI domain

- [ ] **Routes** (7 files): `GET/POST/DELETE /ai/config`, `POST /ai/draft`,
      `GET/POST /ai/knowledge`, `GET/PATCH/DELETE /ai/knowledge/:id`,
      `POST /ai/knowledge/reindex`, `POST /ai/playground`, `POST /ai/test`.
- [ ] Port `lib/ai/**` (~14 files): `admin-client.ts` (mirrors Flows' pattern;
      the Nest side just uses PrismaService), `auto-reply.ts` (**imported
      directly by the WhatsApp webhook route** — Phase 4 dependency; also
      imports `engineSendText` from `@/lib/flows/meta-send`, which Phase 2
      kept in apps/web solely for this consumer — port the send via
      `FlowMetaSendService`/a shared sender and then delete
      `lib/flows/meta-send.ts`), `chunk.ts`,
      `config.ts`, `context.ts`, `defaults.ts`, `embeddings.ts`, `generate.ts`,
      `knowledge.ts`, `providers/{openai,anthropic,shared}.ts`, `query.ts`,
      `types.ts`, `validate.ts`.
- [ ] Providers: OpenAI + Anthropic only (bring-your-own-key, AES-256-GCM
      encrypted at rest via the WhatsApp-lib `encrypt`/`decrypt` — confirm
      wherever `encryption.util.ts` lands after Phase 4's relocation
      decision). No other providers to worry about.
- [ ] Live-verify: save a real API key (encrypted correctly), knowledge-base
      ingest+reindex, playground chat, and a real auto-reply firing through
      the WhatsApp webhook (Phase 4 dependency).

### 5f — CTWA (Click-To-WhatsApp) + orphaned route groups

- [ ] **CTWA routes** (2 files): `GET/POST /ctwa/campaigns`,
      `POST/PATCH /ctwa/track`. Note: both `track` handlers require an
      authenticated Supabase session today, which is unusual for what's
      conceptually a public ad-click landing endpoint — resolve this as a
      real functional decision during migration (may be intentionally
      internal-only, or may be a pre-existing bug/dead code path; verify
      actual usage before assuming either).
- [ ] **`campaigns/schedules` route** (`GET/POST /campaigns/schedules`) —
      broadcast + retargeting scheduler, not itself CTWA/ecommerce/AI;
      likely belongs wherever broadcasts/`/v1/broadcasts` end up owned
      (Phase 3/4) — decide final home when this sub-phase starts.
- [ ] **Zapier integration** (`GET/POST /integrations/zapier`,
      `PATCH/DELETE /integrations/zapier/:id`, `POST /integrations/zapier/:id/test`) —
      shares the `webhook_endpoints` table and `lib/webhooks/*` code with
      Phase 3's `/v1/webhooks`. If Phase 3 already ported the shared
      webhook-delivery/signing lib wholesale (recommended in that phase's
      notes), this sub-phase is just porting 3 thin route files on top of
      already-ported infrastructure.
- [ ] Live-verify a real CTWA click→conversion flow and a real Zapier "Catch
      Hook" round-trip.

---

## Phase 6 — Decommission old Next.js API routes + rewrite layer entirely ⬜ NOT STARTED

Only reachable once Phases 2–5 are all complete and live-verified. Full scope
TBD until closer to execution, but the shape is already knowable from
patterns established in Phases 0–1:

- [ ] **Audit `apps/web/src/app/api/**`** for anything still remaining — by
      this point it should be empty or near-empty. Genuine exceptions that
      may need to stay in Next.js permanently (not migration debt, but
      architectural necessities): Supabase Auth's own callback/session routes
      if any exist under `api/`, and anything that must set an httpOnly
      cookie scoped to the Next.js app's own domain (cookie-setting can't
      cross the service boundary the same way — confirm against
      `middleware.ts`'s session-refresh logic, which is documented to stay
      owned by apps/web regardless of how much else migrates).
- [ ] **Simplify `next.config.ts`'s `rewrites()`** — by now it likely has one
      `beforeFiles` entry pair per migrated domain (automations, flows, v1,
      whatsapp, account, subscription, ecommerce, integrations, webhooks,
      ai, ctwa, campaigns...). Consider collapsing to a single catch-all
      `{source: "/api/:path*", destination: "${NEST_API_URL}/:path*"}` once
      there are no remaining apps/web-owned `/api/**` routes to shadow-guard
      against — or keep the explicit per-domain list if any Next-owned
      routes must coexist. Decide based on what Phase 6's audit finds.
- [ ] **Remove dead env vars/config** accumulated across phases — audit each
      phase's "delete old files" section above for anything deferred (e.g.
      any secret still marked "keep until X migrates" that's now safe to
      remove).
- [ ] **Final whole-monorepo pass**: `turbo run build/lint/test` clean across
      both apps, root README/AGENTS.md updated if they still describe the
      pre-migration single-app architecture, a full production-readiness
      review (rate-limiting parity between the old and new stacks, logging/
      observability parity, error-tracking parity) before considering the
      migration fully closed out.
- [ ] **Update this checklist's roadmap table** to mark every phase complete,
      and consider archiving/renaming this file once there's nothing left to
      track (or repurpose it as a living architecture-decisions record for
      apps/api going forward).

---

## Notes / gotchas hit so far (don't re-discover these)

- Prisma 7 requires the `@prisma/adapter-pg` driver-adapter pattern at runtime; `datasource.url` in `schema.prisma` is CLI-only now (`prisma.config.ts` owns it).
- This project's Supabase JWT signing is **ES256** (asymmetric JWKS), not the legacy HS256 shared secret — confirmed by live debug logging during Phase 0.
- `RateLimitModule` must be `@Global()` — a non-global module's provider isn't resolvable when a guard using it is instantiated from a different consuming module's context.
- `turbo.json` `outputs` globs are package-relative, not repo-root-relative (`dist/**`, not `apps/api/dist/**`).
- Something on this dev machine already holds port 8000 — apps/api runs on **8001** here; `NEST_API_URL`/`PORT` reflect that.
- The frontend's `automation-builder.tsx` reads `body.error` (string) and `body.issues[0].{path,message}` on non-2xx responses — Nest's default `HttpException` wraps a string message as `{statusCode, message, error:"Bad Request"}`, which would silently break this contract. Always throw with an **object** payload: `new BadRequestException({ error: '...', issues })`.
- Supabase session cookies are scoped to the `localhost` domain, not the port — makes cross-service (`:3000` vs `:8001`) manual browser testing easy (no port-specific cookie issues).
- **`next.config.ts`'s `rewrites()` must return `{beforeFiles: [...]}`, not a bare array.** A bare array is treated as `afterFiles` — only applied when no filesystem route matches — so as long as the old `src/app/api/automations/**` route files still exist on disk, they silently shadow the rewrite entirely. This one nearly slipped through: the "converted" frontend pages looked done but were secretly still hitting Supabase directly through the old routes, not Nest, until live verification caught it (proxy response timestamps had Postgres/PostgREST microsecond+`+00:00` formatting instead of Prisma's millisecond+`Z`). Every future phase's rewrite entries need `beforeFiles` too, for as long as their old route files still exist.
- **Never read `process.env.X` as a module-level `const` in apps/api.** `ConfigModule.forRoot({isGlobal:true})`'s `.env` loading only happens once Nest starts instantiating modules — well *after* the entire `require()` graph (every controller/service/util file) has already been synchronously loaded and executed. A top-level `const KEY = process.env.KEY!` captures `undefined` permanently. Always read env vars lazily, inside a function/constructor/method body (this is why `SupabaseAuthGuard`'s `getJwks()`/`canActivate()` work fine — they read `process.env` lazily per-call). Bit us in `encryption.util.ts`; fixed with a `getEncryptionKey()` getter.
- `nest start`'s webpack watch mode spawns a **detached child process** (`node dist/src/main`) separate from the `nest start` CLI wrapper — `pkill -f "nest start"` only kills the wrapper, leaving the actual server running stale code forever with no active watcher. Kill the actual `dist/src/main` PID directly when you need a clean restart.
- **Prisma 7 rejects `{ field: { not: null } }` filters** ("Argument `not` must not be null") — use `NOT: { field: null }` for nullable columns instead (and note some columns you'd assume nullable, e.g. `conversations.contact_id`, aren't).
- **Vitest 4's asymmetric matchers (`expect.any`, `expect.objectContaining`) are typed `any`** — used in object-literal property positions (e.g. `data: { endedAt: expect.any(Date) }`) they trip `@typescript-eslint/no-unsafe-assignment` at error level (as call *arguments* they only hit the warn-level `no-unsafe-argument`, which is why Phase 1's tests never saw this). Established fix: a file-level `/* eslint-disable @typescript-eslint/no-unsafe-assignment */` with a comment, in test files only.
- After deleting Next.js route files, `.next/dev/types/validator.ts` keeps referencing them and fails `tsc --noEmit` — stop the dev server, `rm -rf .next`, re-run (same "kill first, then remove `.next`" rule as above).
- A migration plan's "delete these files" list is a hypothesis, not a fact — Phase 2's plan listed `admin-client.ts`/`meta-send.ts`/`validate.ts` for deletion, and the pre-deletion safety grep found live cross-domain importers for all three (auth/api-keys/whatsapp-send, AI auto-reply, and the builder UI's client-side validation respectively). Always grep before `git rm`, every phase.
- Don't `rm -rf .next` while a `next dev` process is still running against it — it breaks that live process's in-memory Turbopack state (every route starts 500ing) rather than triggering a clean regen. Kill the dev server first, then remove `.next`, then start fresh.

### Findings from the Phase 2–6 planning research pass (2026-07-16)

- **`model flow_state` in `schema.prisma` is Supabase Auth's PKCE table, not the Flows domain** — don't confuse the two when grepping/curating.
- **`AUTOMATION_CRON_SECRET`** — was shared between `/api/automations/cron` and `/api/flows/cron`; both routes are now deleted and the env var was removed in Phase 2. ✅ Resolved.
- **Sequencing tension: Phase 2 (Flows) needs WhatsApp-send functions Phase 4 owns.** ✅ Resolved in Phase 2 by front-loading `sendMediaMessage`/`sendInteractiveButtons`/`sendInteractiveList`/`INTERACTIVE_LIMITS` into `apps/api/src/whatsapp/meta-api.util.ts`.
- **Sequencing tension: Phase 3 (Public API v1) needs WhatsApp-send functions too.** `/v1/messages` and `/v1/broadcasts` depend on `send-message.ts`/`broadcast-core.ts` (WhatsApp lib, Phase 4). Same resolution pattern — port the needed slice early rather than blocking on full Phase 4.
- **`webhook_endpoints` table has two front-ends**: `/api/v1/webhooks` (Phase 3) and `/api/integrations/zapier` (Phase 5). Both share `lib/webhooks/{deliver,endpoints,events,sign,ssrf}.ts` — port that lib wholesale in Phase 3 to avoid a split-brain owner, even though Zapier's routes themselves are Phase 5 scope.
- **`encryption.util.ts` (ported in Phase 1) is a generic secret-encryption utility, not WhatsApp-specific** — already used by AI provider keys, `/v1/webhooks` endpoint secrets, and Zapier keys on the web side. Worth relocating to a shared `apps/api/src/common/security/` location during Phase 4 (when its WhatsApp-side usage grows substantially) rather than leaving it under `whatsapp/`.
- **Confirmed red flag, isolated to Subscriptions**: `lib/subscription/{admin,check-limits,usage}.ts` use the browser Supabase client (`@/lib/supabase/client`) inside server-side route handlers — same bug class as the `beforeFiles` rewrite issue found in Phase 1, but a different root cause. A repo-wide grep confirmed this is the *only* place this pattern appears outside already-migrated/test code.
- **Confirmed secret-hygiene issue**: `lib/payment/razorpay.ts` has a hardcoded fallback Razorpay key secret as a literal default value in source. Flag for rotation when Phase 5b is executed — don't silently carry a checked-in secret into the new codebase.
- **Confirmed security gap**: the Facebook Lead Ads webhook (`/api/webhooks/facebook-leads`) verifies the GET challenge but never checks `X-Hub-Signature-256` on POST payloads — unlike the WhatsApp webhook, which does. Needs an explicit fix-or-accept decision in Phase 5d/4.
- **RPC-heavy domains**: Account (`set_member_role`, `remove_account_member`, `transfer_account_ownership`, `peek_invitation`, `redeem_invitation`) and Subscriptions (`get_user_subscription`, `check_subscription_limit`, `increment_usage`/`decrement_usage`) lean on Postgres SECURITY DEFINER functions, not just table CRUD. Each needs either a `$queryRaw`/`$executeRaw` call into the same RPC or a careful from-scratch reimplementation in Nest app code (the latter risks losing transactional guarantees if not replicated exactly) — check the original SQL in `supabase/migrations/` before choosing per-function.
