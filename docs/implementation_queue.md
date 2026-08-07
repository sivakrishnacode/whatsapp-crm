# Production-Level Message Queue System for Bulk Broadcasts

> **STATUS: BUILT.** Shipped as the fan-out queue described below, plus
> six more queues for the other fire-and-forget paths and a Bull Board
> dashboard at `/admin/queues`. This file keeps the original design for
> context; **[what actually shipped, and the decisions taken on Q1–Q4,
> is recorded at the bottom](#what-shipped)**. Read that first — where
> the two disagree, the bottom wins.

## Background & Problem Statement

The current broadcast delivery in both surfaces has a critical architectural flaw: **each recipient is processed sequentially in a `for` loop** inside a single BullMQ job. This means:

- **Dashboard flow** (`DashboardBroadcastService.deliver`): One BullMQ job iterates over every `pending` recipient in a `for` loop, calling `sendTemplateMessage` one at a time with a naive `sleep()` batch delay.
- **Public API flow** (`BroadcastSendService.deliverBroadcast`): Called via `void` (fire-and-forget from the HTTP handler — no queue at all!) and loops through all recipients in a single synchronous pass.

### Current Problems

| Problem | Impact |
|---|---|
| 1000 recipients in one job | Memory pressure, single point of failure, no parallelism |
| `for` loop with `await` per recipient | Sequential bottleneck — 1000 msgs × ~200ms each = ~3.3 min blocked |
| `void deliverBroadcast()` in the public API | No retry, no persistence, silently lost on crash |
| No per-recipient job isolation | One Meta error can corrupt the entire batch state |
| Concurrency=1 on the processor | Intentional rate limit, but too coarse — no per-account isolation |
| No dead-letter handling | Failed broadcasts are just marked `failed`, no alerting or retry audit |
| No rate-limit compliance | Meta enforces per-phone-number rate limits; current batch pacing is ad-hoc |

---

## Proposed Architecture: Fan-Out Queue System

The core idea: **one broadcast = one "orchestrator" job that fans out into N individual "recipient" jobs**, one per contact. Each recipient job is atomic, retryable, and isolated.

```
POST /v1/broadcasts  or  POST /whatsapp/broadcasts
         │
         ▼
  BroadcastSendService.createBroadcast()
  (validates, creates DB rows, enqueues orchestrator job)
         │
         ▼
  ┌─────────────────────────────────┐
  │  QUEUE: "broadcast-orchestrate" │  ← one job per broadcast_id
  └─────────────────────────────────┘
         │  BroadcastOrchestratorProcessor
         │  - reads all pending broadcast_recipients
         │  - fans out one job per recipient into →
         ▼
  ┌────────────────────────────────────┐
  │  QUEUE: "broadcast-send"           │  ← N jobs (one per recipient row)
  │  concurrency: 10 (configurable)    │
  │  rate-limiter: per phoneNumberId   │
  └────────────────────────────────────┘
         │  BroadcastSendProcessor
         │  - calls sendTemplateMessage for 1 recipient
         │  - updates broadcast_recipients row to sent/failed
         │  - on last recipient: updates broadcasts.status
         ▼
  ┌──────────────────────────────────┐
  │  QUEUE: "broadcast-finalize"     │  ← triggered by BullMQ flow events
  │  (optional, via BullMQ Flows)    │
  └──────────────────────────────────┘
```

### BullMQ Rate Limiter

BullMQ natively supports per-queue rate limiting. We'll set:
- **Max**: 80 messages per 1000ms per `phoneNumberId` group (below Meta's 80 msg/s limit for Tier 1)
- Implemented via `{ limiter: { max: 80, duration: 1000 } }` on the queue registration

---

## Detailed File Changes

### Phase 1 — New Queue & Processors

---

#### [NEW] `apps/api/src/whatsapp/queues/broadcast-orchestrator.processor.ts`

**Purpose**: Reads the broadcast record, fans out individual `broadcast-send` jobs (one per pending recipient), marks broadcast as `queuing` → `sending`.

```typescript
// Pseudocode outline
@Processor(BROADCAST_ORCHESTRATE_QUEUE, { concurrency: 5 })
export class BroadcastOrchestratorProcessor extends WorkerHost {
  async process(job: Job<{ broadcastId: string }>): Promise<void> {
    // 1. Load broadcast + config
    // 2. Get all pending recipient IDs (paginated, no N+1)
    // 3. Fan out: sendQueue.addBulk(recipients.map(r => ({ data: { recipientId: r.id, broadcastId } })))
    // 4. Update broadcast.status = 'sending'
  }
}
```

**Key design decisions**:
- Uses `queue.addBulk()` — single Redis round-trip for all recipient jobs
- Paginated recipient load (PAGE=500) prevents OOM on 10k+ broadcasts
- `jobId: broadcastId` on orchestrator = idempotent re-enqueues

---

#### [NEW] `apps/api/src/whatsapp/queues/broadcast-send.processor.ts`

**Purpose**: Processes ONE recipient per job. Fully atomic and retryable.

```typescript
// Pseudocode outline
@Processor(BROADCAST_SEND_QUEUE, { concurrency: 10 })
export class BroadcastSendProcessor extends WorkerHost {
  async process(job: Job<BroadcastSendJobData>): Promise<void> {
    // 1. Load recipient row + contact + broadcast config
    // 2. Resolve template variables
    // 3. Call sendTemplateMessage (with phoneVariants fallback)
    // 4. Update broadcast_recipients row
    // 5. Check if all recipients done → update broadcasts.status
  }
}

interface BroadcastSendJobData {
  broadcastId: string;
  recipientId: string;        // broadcast_recipients.id
  phoneNumberId: string;      // pre-resolved at orchestration time
  // accessToken NOT stored in job — fetched fresh from DB inside processor
}
```

**Security**: The access token is **never stored in the BullMQ job payload** (it's in Redis — visible in BullMQ dashboard). It's re-fetched from the encrypted DB on every job execution.

---

#### [NEW] `apps/api/src/whatsapp/queues/broadcast-finalize.service.ts`

**Purpose**: A service (not a separate queue) called by `BroadcastSendProcessor` when `pending_count = 0`. Updates `broadcasts.status` to `sent` or `failed`. Uses atomic SQL to avoid race conditions:

```sql
UPDATE broadcasts SET 
  status = CASE WHEN sent_count > 0 THEN 'sent' ELSE 'failed' END,
  updated_at = now()
WHERE id = $broadcastId 
  AND NOT EXISTS (
    SELECT 1 FROM broadcast_recipients 
    WHERE broadcast_id = $broadcastId AND status = 'pending'
  );
```

This is executed via `prisma.$executeRaw` — eliminates the race condition where multiple finishing jobs simultaneously try to finalize.

---

#### [NEW] `apps/api/src/whatsapp/queues/broadcast-queue.constants.ts`

```typescript
export const BROADCAST_ORCHESTRATE_QUEUE = 'broadcast-orchestrate';
export const BROADCAST_SEND_QUEUE = 'broadcast-send';
```

Centralizes queue name constants to prevent typos across modules.

---

### Phase 2 — Module Registration

---

#### [MODIFY] [queue.module.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/queue/queue.module.ts)

Register both new queues with rate limiting:

```typescript
BullModule.registerQueue({
  name: BROADCAST_SEND_QUEUE,
  limiter: {
    max: 80,          // Meta Tier 1: 80 messages per second per phone number
    duration: 1000,   // per 1000ms window
  },
}),
BullModule.registerQueue({ name: BROADCAST_ORCHESTRATE_QUEUE }),
```

> [!IMPORTANT]
> The rate limiter uses a shared Redis key. If you run multiple API instances (horizontal scaling), this automatically throttles globally across all pods — which is exactly what we want.

---

#### [MODIFY] [whatsapp.module.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/whatsapp.module.ts)

- Remove `BroadcastsProcessor` (old processor, delete it) and `DashboardBroadcastService` from current form
- Register: `BroadcastOrchestratorProcessor`, `BroadcastSendProcessor`
- Provide: `BroadcastFinalizeService`, refactored `DashboardBroadcastService`

---

### Phase 3 — Refactor Existing Services

---

#### [MODIFY] [dashboard-broadcast.service.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/services/dashboard-broadcast.service.ts)

The `createAndQueue` method stays mostly the same but now enqueues into `BROADCAST_ORCHESTRATE_QUEUE` instead of directly into `BROADCASTS_QUEUE`.

**Remove**: The entire `deliver()` method (moved to processors).
**Keep**: `createAndQueue()`, `resolveAudience()`, `upsertCsvContacts()`, `resolveBroadcastVariables()` (exported pure function).

New enqueue call:
```typescript
await this.orchestrateQueue.add(
  'orchestrate',
  { broadcastId: broadcast.id },
  {
    jobId: broadcast.id,           // idempotent
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: { count: 100 },  // keep last 100 failed for audit
  },
);
```

---

#### [MODIFY] [broadcast-send.service.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/v1/services/broadcast-send.service.ts)

The public API (`v1/broadcasts`) currently calls `void deliverBroadcast(plan)` — no queue at all. This is replaced with an enqueue to `BROADCAST_ORCHESTRATE_QUEUE`.

**Changes**:
- `createBroadcast()` now saves the broadcast with `status: 'queued'` (new status) before enqueueing
- Remove `deliverBroadcast()` entirely — delivery is now processor-driven
- Add `@InjectQueue(BROADCAST_ORCHESTRATE_QUEUE) private orchestrateQueue: Queue`

---

#### [MODIFY] [broadcasts.controller.ts (v1)](file:///c:/Users/OMEN/Siva\whatsapp-crm/apps/api/src/v1/controllers/broadcasts.controller.ts)

Remove the `void this.broadcastSendService.deliverBroadcast(plan)` call. The response now returns `status: 'queued'` instead of `'sending'`.

---

#### [DELETE] `apps/api/src/whatsapp/broadcasts.processor.ts`

The old single-job processor is fully replaced by the two new processors.

---

### Phase 4 — Dead Letter & Observability

---

#### [MODIFY] `apps/api/src/whatsapp/queues/broadcast-send.processor.ts`

On `onFailed` hook (BullMQ `WorkerHost` lifecycle):

```typescript
async onFailed(job: Job<BroadcastSendJobData>, error: Error): Promise<void> {
  // Only mark failed after all retries exhausted
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await this.prisma.broadcast_recipients.update({
      where: { id: job.data.recipientId },
      data: { status: 'failed', error_message: error.message.slice(0, 500) },
    });
    this.logger.error(
      `broadcast-send DLQ: recipientId=${job.data.recipientId} broadcastId=${job.data.broadcastId}`,
      error.stack,
    );
  }
}
```

---

#### [NEW] Broadcast status state machine

Add a new `'queued'` status between `'draft'` and `'sending'` to the DB enum/check constraint. This requires a **migration**.

```
draft → queued → sending → sent
                         ↘ failed
```

This lets the UI distinguish "accepted but not yet dispatching" from "actively delivering".

> [!WARNING]
> A **new Prisma migration** is required to add `'queued'` to the `broadcasts.status` check constraint. The existing SQL migration in `supabase/migrations/` must be updated accordingly.

---

### Phase 5 — V1 Module Wiring

---

#### [MODIFY] [v1.module.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/v1/v1.module.ts)

Import `QueueModule` (already global via BullModule.forRootAsync) and inject the `BROADCAST_ORCHESTRATE_QUEUE` into `BroadcastSendService`. Since `V1Module` is imported by `WhatsappModule`, and both need the queue, the cleanest approach is to move `BroadcastSendService` into `WhatsappModule` and re-export it, OR have `V1Module` import a shared `BroadcastQueueModule`.

> [!IMPORTANT]
> **Design decision needed**: The public API's `BroadcastSendService` currently lives in `V1Module`, which doesn't import BullMQ queues. Two options:
> 
> **Option A** _(Recommended)_: Move the queue injection into a new shared `BroadcastQueueModule` that both `V1Module` and `WhatsappModule` import.
>
> **Option B**: Keep `BroadcastSendService` in `V1Module` and pass the orchestrate queue via a service injected from `WhatsappModule` (adds coupling).

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| Access token in Redis (BullMQ job) | **Never store access tokens in job data.** Fetch fresh from encrypted DB inside processor. |
| Multi-tenant isolation | Always scope queries with `account_id` — verified in orchestrator before fanout |
| Recipient double-send on retry | Idempotency via `status = 'pending'` check — only send to `pending` recipients |
| BullMQ dashboard exposure | Do not expose Bull Board without auth in production |

---

## Rate Limiting Compliance (Meta API)

| Meta Tier | Limit | Our Config |
|---|---|---|
| Tier 1 | 1,000 msgs/day, ~10/sec | `max:10, duration:1000` |
| Tier 2 | 10,000 msgs/day, ~80/sec | `max:80, duration:1000` |
| Tier 3 | 100,000 msgs/day, ~80/sec+ | `max:80, duration:1000` |

The rate limiter is set conservatively at **Tier 1 defaults** and can be tuned per account if/when tier info is stored. This replaces the current ad-hoc `sleep(1000)` every 10 messages.

---

## Open Questions

> [!IMPORTANT]
> **Q1**: Should the `BroadcastSendService` (public API) be moved to `WhatsappModule` to share queue infrastructure cleanly, or kept in `V1Module` with a cross-module queue injection?

> [!IMPORTANT]
> **Q2**: Do you want a **BullMQ Flow** (parent-child job) so the orchestrator job only completes after all recipient jobs finish? This gives precise lifecycle control but adds complexity. Or is DB-driven finalization (polling `pending` count to 0) sufficient?

> [!IMPORTANT]
> **Q3**: Should the new `'queued'` status be added, or should we keep `'sending'` as the initial status (set before enqueue)?

> [!NOTE]
> **Q4**: Should we expose a **BullMQ Admin Board** (Bull-Board or Arena) behind the internal dashboard auth for operational visibility? Useful for monitoring stuck jobs.

---

## Verification Plan

### Automated Tests

```bash
# Run existing broadcast tests (must still pass after refactor)
cd apps/api && npm test -- --filter "dashboard-broadcast"

# New tests to write
cd apps/api && npm test -- --filter "broadcast-orchestrator"
cd apps/api && npm test -- --filter "broadcast-send.processor"
```

Tests to write:
- `BroadcastOrchestratorProcessor`: verifies `addBulk` called with correct recipient IDs, handles empty recipients, retries on DB failure
- `BroadcastSendProcessor`: verifies single send, marks sent/failed, calls finalize when last recipient
- `BroadcastFinalizeService`: verifies atomic SQL, no race condition under concurrent calls

### Manual Verification

1. Create a broadcast via `POST /whatsapp/broadcasts` — verify status returns `sending` (or `queued`)
2. Poll `GET /whatsapp/broadcasts/:id` — verify `sent_count` increments over time (not all-at-once)
3. Simulate a Meta API failure mid-broadcast — verify only that recipient is marked `failed`, others continue
4. Restart the API mid-delivery — verify delivery resumes from where it left off (no double-sends)
5. Send a 1000-recipient broadcast — verify BullMQ rate limiter keeps throughput ≤80 req/s

---

## Migration Steps (Execution Order)

1. `[NEW]` `broadcast-queue.constants.ts`
2. `[NEW]` `broadcast-finalize.service.ts`
3. `[NEW]` `broadcast-orchestrator.processor.ts`
4. `[NEW]` `broadcast-send.processor.ts`
5. `[MODIFY]` `queue.module.ts` — register new queues with rate limiter
6. `[MODIFY]` `dashboard-broadcast.service.ts` — remove `deliver()`, update `createAndQueue()` enqueue target
7. `[MODIFY]` `broadcast-send.service.ts` — remove `deliverBroadcast()`, add queue injection
8. `[MODIFY]` `broadcasts.controller.ts` (v1) — remove `void deliverBroadcast()` call
9. `[MODIFY]` `whatsapp.module.ts` — swap old processor for two new processors
10. `[MODIFY]` `v1.module.ts` — wire queue module
11. `[DELETE]` `broadcasts.processor.ts` — old single-job processor
12. `[MIGRATION]` Add `'queued'` to `broadcasts.status` check constraint (if Q3 is yes)
13. `[NEW]` Tests for orchestrator and send processors

---

## What shipped

Delivered in one pass. `docs/implementation_queue.md` described broadcasts
only; the same treatment was applied to every other `void this.…()` path
in the API, because they all failed the same way — external I/O, no
retry, silently lost on restart.

### The four open questions, answered

| # | Question | Decision |
|---|---|---|
| Q1 | Where does the public API's `BroadcastSendService` get its queue? | **Option A, generalised.** `BroadcastQueueService` lives in `src/queue/`, owns the job options, and is exported by `QueueModule`. Both `whatsapp` and `v1` import it. Neither module knows the other exists. |
| Q2 | BullMQ Flows for the parent/child lifecycle? | **No — DB-driven finalization.** `BroadcastFinalizeService` runs ONE atomic SQL statement that tests "any recipient still pending?" and writes the terminal status in the same snapshot. Flows would add a second source of truth for something the recipient rows already answer, and the race the parent job was meant to solve is solved better by the `NOT EXISTS` clause. |
| Q3 | Add a `'queued'` status? | **Yes** — migration 070 widens the CHECK constraint; the web UI has a pulsing amber "Queued" badge and treats it as in-flight for polling and the delete guard. With fan-out there is a real, sometimes long interval between acceptance and the first message, and "nothing has arrived yet" needed to be a state rather than a mystery. |
| Q4 | Expose a queue dashboard? | **Yes — Bull Board at `/admin/queues`**, behind its own ops credential (`QUEUE_DASHBOARD_USER` / `QUEUE_DASHBOARD_PASSWORD`), not mounted at all when unset. |

### Queues

| Queue | Replaces | Notes |
|---|---|---|
| `broadcast-orchestrate` | `broadcasts-send` (deleted) | One job per broadcast; fans out, then gets out of the way |
| `broadcast-send` | the in-process `for` loop | One job per recipient. The only rate-limited queue |
| `webhook-delivery` | `void dispatchWebhookEvent()` × ~15 call sites | One job per (event, endpoint) |
| `ai-reply` | `void dispatchInboundToAiReply()` × 4 | Concurrency 20 — speed is the requirement |
| `automation-trigger` | `void fanOut()` in forms / web / bookings | Distinct from `automations-pending`, which resumes parked runs |
| `ecommerce-sync` | `void this.runSync()` | `jobId` = integration id, so double-clicking "Sync now" cannot import twice |
| `lead-fetch` | `void this.processLead()` | `jobId` = leadgen id, so Meta's own webhook redelivery collapses into one job |

Every name lives in `src/queue/queue.constants.ts`, which is also what the
dashboard enumerates — a queue added without a line there still works, it
is just invisible, and that is the one thing this file exists to prevent.

### Things worth knowing before changing this

- **Idempotency is layered, not incidental.** `jobId` = the recipient row
  id stops the orchestrator queueing a second send; the send processor
  re-checks `status = 'pending'` before calling Meta, which covers the
  case where the first job already completed and was removed from Redis.
  Either alone is insufficient.
- **Access tokens never enter a job payload.** Job data is plaintext in
  Redis and is rendered in the dashboard. Every processor re-reads and
  decrypts what it needs, which also means a rotated token takes effect
  on the next job rather than the next deploy.
- **Per-recipient params are in Postgres, not Redis** — that is what
  `broadcast_recipients.template_params` (migration 070) is for. Redis is
  a work list; the database is the system of record, and a flushed queue
  must be fully resumable from it.
- **Transient vs permanent is decided from Meta's status code**, not by
  matching on the message string — `isTransientSendError` in
  `broadcast-recipient-send.service.ts`. `sendTemplateMessage` now throws
  classified `MetaApiError` subclasses to make that possible. A throttle
  retries; a rejected template is recorded and never retried, because
  four more attempts would produce the identical answer twenty minutes
  later.
- **`BroadcastRecoveryService` re-enqueues unfinished broadcasts on
  boot.** This is what drains broadcasts stranded by the deploy that
  removed the old queue, and it doubles as crash recovery for good.
- **The webhook endpoint failure counter is incremented once per event**,
  after retries are exhausted — not once per attempt. Otherwise a brief
  outage would disable a working integration in three events instead of
  fifteen.
- **The rate limiter is global, not per phone number.** Grouped rate
  limiting is a BullMQ Pro feature. One very large broadcast does slow
  other accounts' broadcasts down; the alternative was risking a real
  customer's number being throttled by Meta.

### Verified

Monorepo typecheck clean · **921 API tests** (up from 806) and **676 web
tests** passing · `nest build` clean · Nest boots with the full DI graph
and all 13 queues register · an enqueued job round-trips through Redis to
its worker · `/admin/queues` returns 401 with no credentials, 401 with a
wrong password, 200 with the right one, and **404 when the credentials
are unset**.

### Not done

- `whatsapp` and `instagram` inbound webhooks still call
  `automationDispatch.dispatch()` inline. They were out of the agreed
  scope: both interleave dispatch with flow-consumption logic that
  decides whether an automation should run at all, so moving them is its
  own change with its own tests.
- The public API's 1000-recipient cap per request is unchanged. Fan-out
  removes the reason for it, but raising it is a product decision.
