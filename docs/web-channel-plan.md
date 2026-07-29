# Web channel implementation plan

> Status: proposed. Covers turning `web` from a nav placeholder into a live
> channel, plus two new channel-agnostic domains — **Forms** and
> **Appointments** — wired into the Automations and Flows engines.

## 1. What is being built

Four deliverables, in dependency order:

| # | Deliverable | Why it comes here |
|---|---|---|
| A | **Web as a real channel** — `conversations.channel = 'web'`, `web_config`, a send path, inbox support | Everything else needs a channel to live on |
| B | **Web widget** (embeddable chat) — loader script, iframe app, live chat, AI replies, pre-chat capture, offline, business hours, sessions | The visible product |
| C | **Form builder** — visual builder, hosted + embedded + in-widget rendering, submissions, contact upsert | Standalone value; also the widget's pre-chat form and the booking front-end |
| D | **Appointments** — service types, availability, slot engine, booking, reminders, reschedule/cancel | Built on top of C's renderer |

Plus **E: engine wiring** — new automation/flow triggers and steps so a form
submission or a booking can drive an automation.

## 2. Architectural decisions (and why)

### 2.1 Web joins the shared core; it does not fork it

Migration `050_instagram_channel.sql` documents the reasoning already: the
inbox, AI auto-reply, Automations, Flows and the public `v1` API all read
`conversations` / `messages`. Web follows the same path — one more value in
`conversations_channel_chk`, one more identity column on `contacts`, one
config table. No `web_*` mirrors of the core tables.

Contact identity for web: **`web_visitor_id`** (an opaque UUID we mint and
store in the visitor's browser). `contacts_identity_chk` becomes
`phone IS NOT NULL OR ig_scoped_id IS NOT NULL OR web_visitor_id IS NOT NULL`.
As with Instagram, identity is **not** auto-merged across channels — but web
is the one channel where a merge is safe *when the visitor gives us a phone or
email*, so pre-chat form capture upgrades an anonymous web contact into the
existing phone-keyed contact (see §5.4).

### 2.2 `replyWindowHours` needs to become nullable

`ChannelCapabilities.replyWindowHours` is `number` today because both existing
channels have a Meta-imposed 24h window. Web has **no window** — we own the
transport. Encoding that as a large number would make window-check code lie.

Change: `replyWindowHours: number | null`, `null` = no window. Then audit
every read (`capabilitiesFor(...).replyWindowHours`, `ig-window.util.ts`, the
inbox composer's window banner) and make `null` mean "always open".

Web capabilities: `templates: false`, `broadcasts: false` (no way to push to a
visitor who closed the tab), `deliveryReceipts: true` (we genuinely have
them — this is the first channel where a "delivered" tick is real),
`buttons: true`, `lists: true` (both render natively in our own UI),
`catalog: false`, `replyWindowHours: null`.

### 2.3 Transport: REST in, SSE out, Redis pub/sub to fan out

Three options were considered:

- **Supabase Realtime direct from the widget** — rejected. It requires handing
  anonymous visitors a Supabase token and relying on RLS to keep them off other
  tenants' rows. That puts the tenant database's wire protocol on every
  customer's marketing site. Too much blast radius for the convenience.
- **socket.io gateway in Nest** — works, but adds a new dependency, a new
  scaling story, and sticky-session requirements behind the proxy.
- **SSE (`text/event-stream`) for server→visitor + plain `POST` for
  visitor→server** — chosen. No new dependency, survives the existing Next
  rewrite proxy, degrades to long-poll trivially, and multi-instance fan-out
  rides the `ioredis` client already in `RedisModule` (`SUBSCRIBE` per
  conversation channel).

Agent-side (dashboard) push keeps using the existing Supabase Realtime
subscription in `use-realtime.ts` — nothing changes for the inbox.

### 2.4 Widget ships as a loader + iframe, not inline DOM

`/widget/v1/loader.js` is a ~2 KB script the customer pastes. It injects an
iframe pointing at `/widget/v1/frame?key=<widget_key>`. The iframe is the real
app (a public Next route group). This is the industry-standard shape and it
buys: total CSS/JS isolation from the host page, no Tailwind leakage in either
direction, and a CSP that can't be widened by the host site.

**Gotcha this creates:** `next.config.ts` currently sends
`X-Frame-Options: DENY` and `frame-ancestors 'none'` on `/:path*`. The widget
routes need their own header rule that drops both and instead sets
`frame-ancestors` from the account's `allowed_origins`. Getting this wrong
means the widget renders as a blank box in production and nowhere else.

### 2.5 Forms and Appointments go on the primary rail, not in the Web panel

`lib/nav/channels.ts` already records this exact lesson for Automations:

> Automations used to sit here as a flat route surfaced inside the WhatsApp
> panel. It moved to the primary rail once the engine became channel-agnostic
> […] Filing it under WhatsApp implied it was WhatsApp-only.

Forms and Appointments are the same: a form link gets sent over WhatsApp, a
booking confirmation goes out as a WhatsApp template, and both are reachable
from the public `v1` API. So:

- Flat routes `/forms` and `/appointments`, rows in `RAIL_WORKSPACE`.
- Surfaced inside `WEB_PANEL` via `matchPaths` (exactly how Flows appears in
  the WhatsApp panel) so the web-channel user still finds them where they
  expect.

### 2.6 Form fields live in JSONB, not a `form_fields` table

Flows and Automations use relational children (`FlowNode`, `AutomationStep`)
because the *engine* traverses them one at a time. A form is always read and
written whole. JSONB `fields` array with a stable `field_key` per item keeps
the builder a single atomic save and avoids ordering columns.

Field→contact mapping reuses the `custom:<uuid>` convention already
established by `UpdateContactFieldStepConfig.field`, so one prefix rule covers
both engines.

## 3. Database migrations

Next number is **053** (last is `052_automations_multi_channel.sql`).

### `053_web_channel.sql`
- Extend `conversations_channel_chk` → `('whatsapp','instagram','web')`.
- Extend `automations_channels_chk` (from 052) to accept `'web'`.
- `contacts.web_visitor_id TEXT`; partial unique index
  `(account_id, web_visitor_id) WHERE web_visitor_id IS NOT NULL`; extend
  `contacts_identity_chk`.
- `web_config` — one row per account, mirroring `instagram_config`'s shape:
  `widget_key` (globally unique, public, embedded in the snippet),
  `widget_secret` (for identity-verification HMAC, encrypted at rest via
  `common/security/encryption.util.ts`), `allowed_origins TEXT[]`,
  `status`, appearance JSONB (`theme`, `position`, `accent`, `logo_url`,
  `launcher_icon`, `greeting`, `teaser`), `prechat_form_id`,
  `offline_form_id`, `business_hours` JSONB, `ai_enabled`,
  `show_branding`, `locale`, timestamps.
- `web_sessions` — visitor session telemetry: `id`, `account_id`,
  `contact_id`, `conversation_id`, `visitor_id`, `started_at`, `ended_at`,
  `page_url`, `referrer`, `utm` JSONB, `user_agent`, `ip_hash` (hashed, never
  raw — this is public traffic), `country`, `pages_viewed`.
- RLS on both, account-scoped, matching the 050/051 pattern.

### `054_forms.sql`
- `forms` — `id`, `account_id`, `user_id`, `name`, `description`,
  `slug` (unique per account; public URL segment), `kind`
  (`'form' | 'booking'`), `status` (`draft|published|archived`),
  `fields` JSONB, `settings` JSONB (submit label, success mode
  `message|redirect`, redirect URL, consent text, honeypot, captcha flag,
  theme), `notify` JSONB (email recipients, in-app notification),
  `submission_count`, timestamps.
- `form_submissions` — `id`, `account_id`, `form_id`, `contact_id` (nullable),
  `conversation_id` (nullable — set when submitted inside the widget),
  `data` JSONB, `meta` JSONB (referrer, utm, page URL, `ip_hash`,
  `user_agent`), `source` (`hosted|embed|widget|whatsapp_flow|api`),
  `status` (`new|read|spam`), `created_at`.
- Indexes: `(account_id, created_at DESC)`, `(form_id, created_at DESC)`,
  `(account_id, slug)`.
- Storage bucket `form-uploads` (private) for file fields, following the
  `051_instagram_media_bucket.sql` pattern.

### `055_appointments.sql`
- `CREATE EXTENSION IF NOT EXISTS btree_gist;` — needed for the
  double-booking guard below.
- `appointment_types` — `name`, `slug`, `description`,
  `duration_minutes`, `buffer_before_minutes`, `buffer_after_minutes`,
  `location_kind` (`in_person|phone|video|custom`), `location_detail`,
  `price_cents`/`currency` (nullable), `capacity` (>1 = group booking),
  `booking_window_days`, `min_notice_minutes`, `assignee_mode`
  (`any|round_robin|specific`), `assignee_ids UUID[]`, `booking_form_id`,
  `confirmation` JSONB, `is_active`.
- `availability_rules` — `appointment_type_id` (nullable = account default),
  `member_id` (nullable = any), `weekday` (0-6), `start_time TIME`,
  `end_time TIME`, `timezone`.
- `availability_exceptions` — `date`, optional `start_time`/`end_time`
  (NULL/NULL = full blackout), `member_id`, `reason`.
- `appointments` — `appointment_type_id`, `contact_id`, `assigned_to`,
  `starts_at`, `ends_at`, `timezone`, `status`
  (`pending|confirmed|cancelled|no_show|completed`), `source`
  (`hosted|widget|whatsapp_flow|manual|api|automation`),
  `form_submission_id`, `conversation_id`, `notes`, `meeting_url`,
  `manage_token` (single opaque token for the reschedule/cancel link),
  `reminder_sent_at`, `cancelled_at`, `cancel_reason`, timestamps.
- **Double-booking guard at the DB level**, not just in application code:
  ```sql
  ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
    EXCLUDE USING gist (
      assigned_to WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status IN ('pending','confirmed') AND assigned_to IS NOT NULL);
  ```
  Two visitors hitting the last slot simultaneously is the single most likely
  real bug in a booking system, and it is not fixable with a read-then-write
  check. Group-capacity types (`capacity > 1`) are excluded from this
  constraint and use a counted insert inside a transaction instead.

Each migration also lands as a Prisma schema update
(`apps/api/prisma/schema.prisma`, both `auth`/`public` schemas already
configured) — write the SQL first, then `prisma db pull`-style reconcile, per
the existing workflow.

## 4. Backend — `apps/api`

### 4.1 New module `src/web/` (mirrors `src/instagram/`)

```
src/web/
  web.module.ts
  controllers/
    web-config.controller.ts        @Controller('web/config')     — dashboard, Supabase guard
    web-public.controller.ts        @Controller('public/web')     — visitor-facing, widget-key auth
    web-stream.controller.ts        @Controller('public/web/stream') — SSE
  services/
    web-config.service.ts           CRUD + key rotation + origin allowlist
    web-session.service.ts          session issue/resume, contact + conversation upsert
    web-send.service.ts             outbound → persist message → publish to Redis
    web-inbound.service.ts          visitor message → persist → AI + automations + flows dispatch
    web-presence.service.ts         typing + read receipts, Redis-backed TTL keys
  guards/
    widget-key.guard.ts             resolves widget_key → account, checks Origin against allowlist
    visitor-session.guard.ts        verifies the signed visitor session token
  utils/
    widget-key.util.ts              key generation + constant-time compare
    visitor-token.util.ts           sign/verify (jose, same lib as supabase-auth.guard)
    business-hours.util.ts          pure; unit-tested
```

Public endpoints (all rate-limited via the existing `RateLimitService`, keyed
on `ip_hash` + `widget_key`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/public/web/bootstrap` | widget config for a `widget_key` (appearance, prechat form, hours, branding) |
| `POST` | `/public/web/session` | issue/resume visitor session token; upserts contact + `web` conversation |
| `POST` | `/public/web/messages` | visitor sends text / media / button reply |
| `GET` | `/public/web/stream` | SSE: new messages, typing, read, agent-assigned |
| `POST` | `/public/web/typing` | visitor typing |
| `POST` | `/public/web/read` | visitor read receipt |
| `POST` | `/public/web/upload` | signed upload to `web-media` bucket |

Two auth layers, deliberately: `widget-key.guard` (public key + Origin
allowlist) gates `bootstrap`/`session`; `visitor-session.guard` (signed token)
gates everything that touches a conversation. A leaked widget key therefore
buys an attacker nothing but the public config.

### 4.2 `ChannelSenderService` gains a third branch

`src/common/messaging/channel-sender.service.ts` currently branches
`instagram` vs. WhatsApp-fallback. Change the fallback to an explicit
three-way switch and inject `WebSendService` (via `forwardRef`, same as the
other two). Every method: `sendText`, `sendMedia`, `sendButtons`, `sendList`,
`react`, plus `sendTemplate` → throws `UnsupportedOnChannelError` for web.

Because the AI reply service, flow runner and automation step executor all go
through this one service, **AI auto-reply and every existing automation and
flow start working on web the moment this branch lands** — no changes in
those engines. That is the payoff of §2.1.

### 4.3 New module `src/forms/`

```
src/forms/
  forms.module.ts
  forms.controller.ts               @Controller('forms')          — dashboard CRUD
  forms-public.controller.ts        @Controller('public/forms')   — render + submit
  services/
    forms.service.ts                CRUD, slug uniqueness, publish/unpublish, duplicate
    form-render.service.ts          public projection (strips internal mapping/notify)
    form-submit.service.ts          validate → spam-check → contact upsert → dispatch
    form-contact-resolver.service.ts  dedupe by phone_normalized, then email, then visitor_id
  form.types.ts                     field union, validation rules, mapping
  form-validate.ts                  server-side re-validation; pure, unit-tested
  dto/
```

Field types (v1): `text`, `textarea`, `email`, `phone`, `number`, `select`,
`multiselect`, `radio`, `checkbox`, `date`, `time`, `file`, `rating`,
`hidden`, `consent`, `heading`, `paragraph`. Plus `appointment_slot` — the
field that turns a form into a booking form (§4.4).

Spam controls: honeypot field, minimum time-to-submit, per-IP rate limit,
optional Cloudflare Turnstile (env-gated so it's opt-in).

**Validation is re-run server-side.** The builder emits client validation for
UX; `form-validate.ts` is the authority. A public endpoint that trusts
client-side `required` is a data-integrity hole.

### 4.4 New module `src/appointments/`

```
src/appointments/
  appointments.module.ts
  appointments.controller.ts            @Controller('appointments')        — dashboard
  appointment-types.controller.ts       @Controller('appointment-types')
  appointments-public.controller.ts     @Controller('public/appointments') — slots + book + manage
  services/
    appointment-types.service.ts
    availability.service.ts             rules + exceptions CRUD
    slot-engine.service.ts              ← the core; see below
    booking.service.ts                 book / reschedule / cancel, transactional
    appointment-reminders.service.ts   schedules + sends
  appointments.processor.ts             BullMQ: reminders + no-show sweep
  slot-engine.util.ts                   PURE function, heavily unit-tested
```

`slot-engine.util.ts` is a pure function — `(rules, exceptions, existing
appointments, type config, range, target timezone) → slot[]` — with no Prisma
and no clock access (`now` is a parameter). Timezone and DST arithmetic is
where booking systems break; making it pure means the DST-transition cases are
cheap table-driven tests rather than integration fixtures.

Reminders ride the existing BullMQ setup (`queue` module) as delayed jobs.
Delivery goes through `ChannelSenderService`, which means:

> **A reminder to a WhatsApp contact 24h before the appointment is almost
> always outside the 24h customer-service window, so it must be a
> *template* send, not a text send.** The reminder config therefore requires
> a `template_name`, and the UI must say why. This is the one place where the
> capability model has a sharp edge that a user will otherwise hit blind.

Web-channel contacts can't be reminded at all (no push). For those, reminders
fall back to email if we captured one, and the UI states that plainly.

### 4.5 Wiring into `app.module.ts`

Add `WebModule`, `FormsModule`, `AppointmentsModule`. `MessagingModule` gains
`WebSendService` in its exports.

## 5. Engine integration (Automations + Flows)

### 5.1 New automation trigger types

In `src/automations/automation.types.ts` (and its duplicate in
`apps/web/src/types/index.ts` — the file's own header flags this duplication;
this is a good moment to hoist both into `packages/shared-types`, but that is
a separate change and should not be smuggled in here):

```ts
| 'form_submitted'          // config: { form_id?: string }  — omitted = any form
| 'appointment_booked'      // config: { appointment_type_id?: string }
| 'appointment_cancelled'
| 'appointment_rescheduled'
| 'web_chat_started'        // config: {}  — first message on a new web conversation
```

`TRIGGER_CHANNEL_LOCK` gains `web_chat_started: 'web'`. The three
appointment/form triggers are **channel-agnostic** — a booking made on a
hosted page has no channel, so these must not be channel-locked, and the
dispatcher must tolerate a null channel (see §5.3).

`automation-validate.ts` gains branches for each new trigger. The existing
keyword-conflict warning logic (recent commits `41bf68c`, `1e96331`) needs no
change.

### 5.2 New automation step types

```ts
| 'send_form'          // { form_id, message_text? } — sends the form link; inline card on web
| 'send_booking_link'  // { appointment_type_id, message_text? }
```

Both are implemented in `automation-step-executor.service.ts` on top of
`ChannelSenderService.sendText` with an interpolated public URL, so they work
on every channel for free. `send_form` on web additionally emits a structured
message (`content_type: 'form'`, form id in `messages.metadata`) so the widget
renders the form inline rather than as a link — the `metadata` column already
exists for exactly this kind of channel-specific extra.

### 5.3 The dispatch problem: submissions without a conversation

`AutomationDispatchService.dispatch()` takes a `contactId`, and send steps
need a `conversationId`. A hosted form submission has neither guaranteed.
Resolution, in order:

1. Submission came from the widget → use its `web` conversation.
2. Contact has a phone → find-or-create the contact's **WhatsApp**
   conversation (channel-pinned lookup — `channel.ts` warns explicitly that
   unpinned `findFirst({ account_id, contact_id })` can now return the wrong
   thread).
3. Otherwise → dispatch with `conversationId: null`. Non-messaging steps
   (`add_tag`, `create_deal`, `update_contact_field`, `send_webhook`) run;
   messaging steps are skipped and logged as skipped, reusing the
   `UnsupportedOnChannelError` handling path that already exists for
   Instagram capability gaps.

Step 3 requires making `conversationId` optional on the dispatch input and
auditing the step executor for unguarded reads — the largest single piece of
engine surgery in this plan, and worth doing carefully.

### 5.4 Contact identity upgrade on capture

When a form (or the widget's pre-chat form) captures a phone or email for a
visitor who is currently an anonymous `web_visitor_id`-only contact:

- If no other contact matches → fill `phone`/`email` on the existing row.
- If an existing contact matches by `phone_normalized` → **merge**: move the
  web conversation and `web_visitor_id` onto the established contact, delete
  the stub. Wrapped in a transaction.

This is the deliberate, evidence-backed merge that 050 said to leave for
later — we do it here only because the visitor *told* us the phone number, so
there is no guessing.

### 5.5 Flows

- New flow trigger `form_submitted` in `src/flows/flow.types.ts`, matching the
  automation config shape.
- Web works with every existing flow node the moment §4.2 lands.
- **Out of scope, noted as follow-up:** a `collect_form` flow node that sends
  a form and blocks the run until submission. It needs a new resume path in
  `flows-sweep.service.ts` and deserves its own change.

## 6. Frontend — `apps/web`

### 6.1 Nav

`src/lib/nav/channels.ts`:
- `CHANNELS.web.status`: `'placeholder'` → `'live'`.
- Rewrite `WEB_PANEL`:
  - *Action*: Channel Settings (`/channels/web/settings`), Web Widget
    (`/channels/web/widget`), Forms (`/forms`, `matchPaths: ['/forms']`),
    Appointments (`/appointments`, `matchPaths: ['/appointments']`).
  - *Assets*: Knowledge Base (`/channels/web/knowledge`).
  - *Analytics*: Sessions (`/channels/web/sessions`).

`src/lib/nav/nav-config.ts`: add `forms` and `appointments` rows to
`RAIL_WORKSPACE`.

`src/hooks/use-channel-status.tsx`: add a `GET /api/web/config` fetch so the
rail dot and panel chip reflect real web status. Note the file's comment about
keeping this to one fetch per channel per page load.

Keep `channels/web/[[...section]]/page.tsx` as the backstop — the Instagram
comments explain that concrete segments beat the optional catch-all, so
adding real pages is pure addition.

### 6.2 Dashboard routes

```
src/app/(dashboard)/channels/web/
  settings/page.tsx        connection, allowed origins, key rotation, business hours
  widget/page.tsx          appearance + live preview + install snippet
  knowledge/page.tsx       reuse ai_knowledge_documents UI
  sessions/page.tsx        session list + funnel
  [[...section]]/page.tsx  (unchanged backstop)

src/app/(dashboard)/forms/
  page.tsx                 list
  new/page.tsx
  [id]/page.tsx            builder
  [id]/submissions/page.tsx

src/app/(dashboard)/appointments/
  page.tsx                 calendar + list
  types/page.tsx
  types/[id]/page.tsx
  availability/page.tsx
```

`src/middleware.ts`: add `/forms` and `/appointments` to `protectedPaths`.
`next.config.ts` rewrites: add `/api/web/:path*`, `/api/forms/:path*`,
`/api/appointments/:path*`, `/api/appointment-types/:path*`.

### 6.3 Public routes (new route group, no dashboard shell, no auth)

```
src/app/(public)/
  layout.tsx               minimal; no DashboardShell, no ChannelStatusProvider
  f/[slug]/page.tsx        hosted form
  book/[slug]/page.tsx     hosted booking page
  appointments/[token]/page.tsx   reschedule / cancel via manage_token
  widget/v1/frame/page.tsx        the widget app (iframe target)
```

Plus `apps/web/public/widget/v1/loader.js` — or better, a build step that
emits it, so it can be minified and versioned. `v1` in the path is deliberate:
the snippet lives on customers' sites forever and can never be
breaking-changed.

Two required config changes, both easy to miss:

1. **`middleware.ts`** does `supabase.auth.getUser()` on every matched
   request. Add an early return for `/widget`, `/f/`, `/book/`,
   `/api/public/` — otherwise every widget load on every customer site pays a
   Supabase round trip.
2. **`next.config.ts` `headers()`** — a rule for `/widget/:path*` that omits
   `X-Frame-Options: DENY` and replaces `frame-ancestors 'none'`. Also add the
   API origin to `connect-src` for the SSE stream if the widget is ever served
   cross-origin.

### 6.4 Components

```
src/components/channels/web/
  web-config.tsx                connection + origins + key rotation
  web-widget-appearance.tsx     theme editor
  web-widget-preview.tsx        live iframe preview
  web-install-snippet.tsx       copy-paste snippet + verify-installation check
  web-sessions.tsx

src/components/forms/
  form-builder.tsx              shell: canvas + palette + inspector
  form-field-palette.tsx        drag source (@dnd-kit — already a dependency)
  form-canvas.tsx               sortable field list
  form-field-inspector.tsx      per-field settings incl. contact mapping
  form-renderer.tsx             ← SHARED: hosted page, embed, widget, preview
  form-field-input.tsx          one renderer per field type
  form-settings-panel.tsx
  form-submissions-table.tsx
  form-share-panel.tsx          link, embed snippet, QR

src/components/appointments/
  appointment-calendar.tsx
  appointment-type-editor.tsx
  availability-editor.tsx       weekly grid + exceptions
  slot-picker.tsx               ← SHARED with the public booking page
  booking-panel.tsx
  appointment-detail-sheet.tsx

src/components/widget/
  widget-app.tsx                root state machine
  widget-launcher.tsx
  widget-header.tsx
  widget-message-list.tsx
  widget-composer.tsx           text, emoji, file
  widget-prechat.tsx            wraps form-renderer
  widget-offline.tsx
  widget-booking.tsx            wraps slot-picker
  widget-typing.tsx
  use-widget-stream.ts          SSE client with reconnect + backoff
```

`form-renderer.tsx` and `slot-picker.tsx` being shared between the dashboard
preview, the hosted page and the widget is the main thing keeping this from
becoming three divergent form implementations. Both must therefore be pure
presentational components with no dashboard-only imports (no `useAuth`, no
Supabase client) — worth a lint boundary or at least a comment.

### 6.5 Inbox

- `src/lib/inbox/channel.ts` — the `=== "instagram" ? "instagram" : "whatsapp"`
  coercion becomes a real three-way check.
- Channel filter tab and per-message channel badge gain web.
- Composer: web has no 24h window, so the window banner must not render;
  templates and broadcast actions hide.
- Web-only affordances: visitor's current page URL, session referrer/UTM,
  and a real "delivered" tick (the first channel where it is truthful).

## 7. Widget feature checklist ("complete the web widget")

| Feature | Notes |
|---|---|
| Launcher bubble | position, accent colour, custom icon, unread badge |
| Greeting / teaser bubble | delay-triggered, dismissible |
| Pre-chat form | any published form via `web_config.prechat_form_id` |
| Live agent chat | inbox integration; SSE both ways |
| AI auto-reply | free once §4.2 lands — `AiReplyService` is already channel-agnostic |
| Knowledge-base answers | reuses `ai_knowledge_documents` / `ai_knowledge_chunks` |
| Quick-reply buttons & lists | `sendButtons` / `sendList` render natively |
| File upload (both directions) | `web-media` bucket |
| Typing indicators | Redis TTL keys; both directions |
| Read receipts | both directions |
| Business hours | outside hours → offline form instead of live chat |
| Offline capture | `web_config.offline_form_id` |
| Inline booking | `slot-picker` inside the widget |
| Inline forms | `send_form` automation step → `content_type: 'form'` message |
| Conversation history | resumed by visitor token across reloads and sessions |
| Sound + browser notification | opt-in |
| Identity verification | HMAC over the customer's own user id using `widget_secret`, so a logged-in visitor can't be impersonated |
| Locale | `next-intl` messages passed into the frame |
| Branding toggle | gated on plan tier via the existing subscription checks |
| Install verification | dashboard button that checks for a bootstrap hit from an allowed origin |

## 8. Testing

Vitest in both apps (not Jest). Priority order — these are the parts where a
bug is either silent or expensive:

- `slot-engine.util.test.ts` — DST transitions, buffers, min-notice, capacity,
  multi-member round-robin, timezone conversion. Table-driven, no DB.
- `form-validate.test.ts` — every field type, required/optional, coercion,
  rejection of client-only trust.
- `form-contact-resolver.service.test.ts` — the dedupe/merge matrix, including
  the "phone matches an existing contact in a *different* account" case, which
  must never merge.
- `visitor-token.util.test.ts` — expiry, tampering, cross-account replay.
- `widget-key.guard` origin allowlist — subdomain and port edge cases,
  `null` Origin.
- `business-hours.util.test.ts` — timezone + midnight-spanning windows.
- `channel-sender.service` web branch — including every
  `UnsupportedOnChannelError` path.
- `nav-config.test.ts` / `instagram-routes.test.ts` already exist and assert
  nav invariants; extend rather than add parallel files.
- Booking concurrency: an integration test that fires two simultaneous
  bookings at the same slot and asserts exactly one succeeds.

## 9. Sequencing

Each phase is independently shippable and leaves `main` working.

| Phase | Content | Depends on |
|---|---|---|
| **1** | Migration 053; `channel.ts` + `replyWindowHours: number \| null` audit; `web_config` CRUD; nav flip to `live`; settings page | — |
| **2** | `WebSendService`, `ChannelSenderService` branch, inbound service, SSE + Redis fan-out, inbox web support | 1 |
| **3** | Loader + iframe frame app, launcher, live chat, AI replies, header carve-outs, install snippet | 2 |
| **4** | Migration 054; forms CRUD + builder + renderer + hosted page + submissions | 1 |
| **5** | `form_submitted` trigger, `send_form` step, dispatch `conversationId` nullability, contact merge, pre-chat + offline in widget | 3, 4 |
| **6** | Migration 055; appointment types, availability, slot engine, booking pages, in-widget booking | 4 |
| **7** | Appointment triggers, reminder queue (with the template caveat surfaced in the UI), reschedule/cancel | 5, 6 |
| **8** | Sessions analytics, typing/read, identity verification, locale, branding gate, polish | 3 |

Phases 4 and 6 (Forms, Appointments) only depend on phase 1, so they can run
in parallel with 2–3 if there's more than one person on this.

## 10. Risks and things that will bite

1. **`replyWindowHours` nullability** touches shared capability code used by
   Instagram. Audit every reader; a missed one silently changes Instagram
   behaviour.
2. **`conversationId` becoming optional in automation dispatch** is the
   riskiest edit in the plan — it changes a long-standing invariant in the
   step executor. Do it with tests first.
3. **Widget CSP / framing headers** — will look fine locally and break on the
   first real customer domain. Test against an actual third-party origin
   before shipping phase 3.
4. **Booking race conditions** — the `EXCLUDE USING gist` constraint is the
   real fix; application-level checks are UX only. `btree_gist` must be
   installable on the Supabase instance (it is, but confirm before writing
   055).
5. **Public endpoints are new attack surface.** Every one is rate-limited,
   origin-checked, size-capped, and stores `ip_hash` rather than raw IPs.
6. **Reminders on WhatsApp need approved templates.** A user who configures a
   reminder with plain text will get silent failures 24h before every
   appointment. Surface this at config time, not in logs.
7. **The duplicated types file** (`automation.types.ts` ⇄
   `apps/web/src/types/index.ts`) will drift as five new trigger/step types
   land in both. Either hoist to `packages/shared-types` first as a
   standalone change, or accept the duplication knowingly and update both in
   the same commit every time.
