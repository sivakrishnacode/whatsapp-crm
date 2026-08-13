# WhatsApp Calling — feasibility, requirements, and the steps

Voice calling on the WhatsApp number we already connect, via Meta's **Cloud API
Calling** product. This file is both the plan and the inbox: §1–§3 are what the
thing is and the one decision that shapes everything, §4 is what I need from you
before it can go live, §5 onward is the work itself.

Nothing here is built yet. Status: **proposed**.

Legend: 🔴 blocks go-live · 🟡 blocks a specific phase · 🟢 just confirm my default

---

## 1. Verdict

**Yes, it's possible**, and it is a first-party Meta product on the same WABA and
the same phone number `whatsapp_config` already stores — not a workaround, not a
third-party bridge.

The API half is small: JSON signalling over Graph, on the webhook endpoint we
already run and already verify signatures for. The audio half is the whole
project. See §3.

| | User-initiated (they call us) | Business-initiated (we call them) |
| --- | --- | --- |
| Cost | **Free** | Paid — billed in **6-second pulses**, rounded up (a 56s call = 10 pulses). INR rate card live since 1 Apr 2026. |
| Gate | Calling enabled on the number | An explicit **call permission** from that user |
| Rate limits | — | **1 permission request / day, 2 / week** per user pair in production (25/day, 100/week in sandbox); 10,000 call initiations / 24h per business number |
| Availability | Global | **Not available** in US, Canada, Egypt, Vietnam, Nigeria. India is fine. |

Prerequisites Meta imposes:

- Number on **Cloud API**, not the WhatsApp Business app.
- App subscribed to the **`calls`** webhook field.
- `whatsapp_business_messaging` permission (we already hold it).
- **≥ 2,000 daily messaging limit** for production calling. We already sync this
  into `whatsapp_config.messaging_limit_tier`, so the UI can gate on it rather
  than letting someone enable calling and discover the failure from Meta.

---

## 2. What the customer actually gets

- A **call button in the WhatsApp thread** on their customers' phones, subject to
  `call_icon_visibility` and to **call hours** (weekly schedule + holiday
  schedule, in the business's timezone).
- **Voicemail** when a call is rejected or times out — an announcement audio the
  business uploads, with a configurable timeout.
- Calls landing on their agents (see §3) and being **recorded as events in the
  same conversation thread** as the messages, which is the part a CRM is
  actually for. Duration, direction, missed/answered, who took it.
- Later: **click-to-call** from the inbox and from a deal, once permission is in
  place.

---

## 3. The one hard problem: we have to terminate the audio

Signalling is Graph + webhooks. **Media is WebRTC** — ICE, DTLS-SRTP, Opus
(G.711 PCMA/PCMU also accepted). Node cannot do that, and NestJS is not where
that lives. Meta supports three configurations:

| # | Configuration | What we would have to run |
| --- | --- | --- |
| 1 | Graph API + webhooks, **WebRTC** | Our own WebRTC endpoint (mediasoup / Janus / Pion). We exchange SDP offer/answer as JSON over the calls API. |
| 2 | **SIP** + WebRTC media | A SIP server that speaks WebRTC media |
| 3 | **SIP** + SDES SRTP | A standard SIP server — Asterisk / FreeSWITCH, or a trunk from Twilio / Telnyx / Plivo |

### ⚠️ Recommendation: take the SIP path (3, falling back to 2)

Meta sends a **SIP INVITE** to a server we nominate; calls ring the agents'
softphones or desk phones; wacrm never handles a media packet. For a team this
size that is the difference between a two-week feature and a two-month one, and
the media path becomes somebody else's uptime problem.

What SIP requires of the server:

- Standards-compliant SIP over **TLS**, typically **port 5061**.
- A valid TLS certificate whose subject name matches the configured SIP domain.
- **Digest authentication** — mandatory for business-initiated calls (Meta sends
  a first INVITE, takes the `407` challenge, then re-INVITEs with credentials),
  recommended for user-initiated.
- WebRTC media (ICE, DTLS-SRTP, Opus) **or** SDES-based SRTP key exchange.

Two constraints to design around, both non-obvious:

- ⚠️ **SIP mode is exclusive.** With `sip.status = ENABLED`, the calling-related
  Graph endpoints are unavailable. We cannot half-use both, so the accept /
  reject / terminate code path in §6.2 only exists on the non-SIP route.
- ⚠️ **One SIP server per phone number.** If a second app configures a different
  server for the same number, Meta terminates the calls. This is a
  coexistence-style trap: a customer who already routes their number through
  another vendor cannot also route it through us.

`webhook_delivery` on the SIP block is **disabled by default**. Turn it on or we
get no call lifecycle events at all and the CRM records nothing. SIP webhooks
carry no SDP (the SIP server owns the media), and the `id` field is the
**WACID**, which maps to the `x-wa-meta-wacid` custom SIP header — that
correlation is how a call in our database is tied to a call leg on the SIP side.

---

## 4. What I need from you

### 4.1 The media decision 🔴

**→ Confirm SIP, and tell me which SIP infrastructure.** Three shapes, in the
order I'd pick them:

1. **Managed trunk** (Twilio Elastic SIP Trunking, Telnyx, Plivo). Fastest, has
   a TLS cert and an SLA on day one, costs per-minute on top of Meta's pulses.
2. **Self-hosted FreeSWITCH / Asterisk** on the existing VPS. No per-minute
   markup, but it is a new always-on service with its own TLS cert, its own
   ports (5061/TLS + an RTP range), and its own on-call burden. Note the VPS
   currently publishes everything on 127.0.0.1 behind the host proxy — SIP needs
   a genuinely public port, which is a deliberate change to that posture.
3. **A CPaaS voice API** that hides SIP entirely. Least work, most lock-in, and
   the pricing compounds with Meta's.

Everything in §5–§7 is written to be independent of this choice except §6.1,
which is where the hostname and credentials land.

### 4.2 Meta app configuration 🔴

In the app that already holds `META_APP_ID` / `META_APP_SECRET`:

- [ ] App Dashboard → Webhooks → WhatsApp Business Account → subscribe the
      **`calls`** field. This is an **app-level field subscription** — it is not
      covered by the per-WABA `subscribeWabaToApp` call in
      [connect-account.service.ts](../apps/api/src/whatsapp/services/connect-account.service.ts).
      If this box is unticked, everything else works and no call ever arrives.
- [ ] Confirm the app is approved for `whatsapp_business_messaging` (it is) —
      calling needs no new App Review permission, which is the good news
      relative to Ads Manager.
- [ ] For each customer number: confirm the messaging tier is ≥ 2,000/day.

### 4.3 Cost sign-off 🟡 (blocks Phase 2 only)

Business-initiated calls are billed **by Meta to the customer's own WABA**, on
the token they gave us. Same posture as Ads Manager: no wallet, no ledger, no
money through us — do not build one without re-opening this decision.

But per [CLAUDE.md](../CLAUDE.md), plan limits are enforced nowhere, so nothing
stops a tenant burning their own money in 6-second increments via an automation
loop.

- **My default:** a server-side daily ceiling, `WA_CALLING_MAX_OUTBOUND_PER_DAY`
  per account, independent of any UI validation — the same reasoning as
  `ADS_MAX_DAILY_BUDGET_MINOR`. 🟢 confirm, or give me a number.

### 4.4 Environment variables 🔴

```bash
# apps/api/.env
WA_CALLING_ENABLED=false          # the real gate — guards every /whatsapp/calls/* route
WA_CALLING_SIP_DEFAULT_HOST=      # optional: platform-wide SIP host, if we run one for everyone
WA_CALLING_MAX_OUTBOUND_PER_DAY=  # per-account backstop (§4.3)

# apps/web/.env.local
NEXT_PUBLIC_WA_CALLING_ENABLED=false   # courtesy flag: hides the UI, is not access control
```

Off by default twice, exactly like Ads Manager. The API guard is the gate; the
web flag is a courtesy.

---

## 5. Phase 0 — the version with no calling API at all

**~1–2 days, zero infrastructure, no Meta configuration.**

A `PHONE_NUMBER` call-to-action button on a template, or a "Call us" action in
the composer, opens the *customer's own dialer* against the business's ordinary
phone line. No WebRTC, no SIP, no permissions, no per-pulse billing.

Steps:

1. Extend the template builder to emit the `PHONE_NUMBER` CTA button type
   (`whatsapp-templates.controller.ts` already submits template components).
2. Record the tap as a timeline entry when the resulting inbound message arrives
   — there is no webhook for "user pressed the call button".
3. Ship it as "Call button" in the template editor, not as "Calling".

This is not a stepping stone to the rest — it is a separate, cheaper feature
that covers most of the business value. **Worth shipping first regardless of
whether Phases 1–3 ever happen.**

---

## 6. Phase 1 — inbound calling, recorded in the CRM

**~2–3 weeks. The SIP setup is the schedule risk, not the code.**

### 6.1 Call settings API

One new file, `apps/api/src/whatsapp/calling-api.util.ts`, in the house style —
**named-options objects, never positional args**.

```
GET  /<PHONE_NUMBER_ID>/settings[?include_sip_credentials=true]
POST /<PHONE_NUMBER_ID>/settings
```

The `POST` body shape (all of it lives under `calling`):

```jsonc
{
  "calling": {
    "status": "ENABLED",                      // ENABLED | DISABLED
    "call_icon_visibility": "DEFAULT",        // DEFAULT | DISABLE_ALL
    "callback_permission_status": "ENABLED",  // auto-grants permission when they call us
    "call_hours": {
      "status": "ENABLED",
      "timezone_id": "Asia/Kolkata",
      "weekly_operating_hours": [
        { "day_of_week": "MONDAY", "open_time": "0900", "close_time": "1800" }
      ],
      "holiday_schedule": [
        { "date": "2027-01-01", "start_time": "0000", "end_time": "2359" }
      ]
    },
    "sip": {
      "status": "ENABLED",
      "servers": [{ "hostname": "sip.example.com", "port": 5061 }]
    },
    "voicemail": {
      "status": "ENABLED",
      "triggers": ["REJECT", "TIMEOUT"],
      "audio": { "default": { "announcement_media_id": "…", "timeout_seconds": 20 } }
    }
  }
}
```

`GET` returns the same shape plus `audio.additional_codecs` and, with
`include_sip_credentials=true`, a `sip_user_password`.

> ⚠️ `sip_user_password` is a credential. It is encrypted at rest like every
> other token here, **never returned to the browser**, and — per the queue rules
> — **never put in a job payload**. Redis stores job data in plaintext and Bull
> Board renders it.

### 6.2 API version pin

[`META_API_VERSION`](../apps/api/src/whatsapp/meta-api.util.ts) is `v21.0` at
line 21. Calling is not on v21.0.

CLAUDE.md already tracks **three** independent version pins (Cloud API v21.0,
Pages v20.0, Marketing v23.0) as a deliberate choice — three upgrade risks
instead of one shared one. 🟢 **My default: bump the Cloud API pin** rather than
add a fourth, since calling rides the same phone number and the same token, and
re-run the WhatsApp test suite. Say so if you'd rather isolate it.

### 6.3 Webhook ingestion

`calls` arrives as a new `change.field` on the **existing** endpoint —
`@Controller('whatsapp/webhook')`, signature verification and all. Today the
loop in
[whatsapp-webhook.service.ts:301-317](../apps/api/src/whatsapp/services/whatsapp-webhook.service.ts#L301-L317)
routes `field` through `isTemplateWebhookField` / `isLimitWebhookField` and then
falls through to `value.statuses` / `value.messages` — an unrecognised field is
**silently dropped**. So:

1. Add `apps/api/src/whatsapp/utils/call-webhook.util.ts` with
   `isCallWebhookField()` + a parser, mirroring
   [limit-webhook.util.ts](../apps/api/src/whatsapp/utils/limit-webhook.util.ts)
   and its test file.
2. Add the branch next to the other two, before the `statuses` handling.
3. Resolve the tenant the same way messages do: `value.metadata.phone_number_id`
   → `whatsapp_config` → `account_id`. **Prisma bypasses RLS** — scope by hand,
   every query, no exceptions.

Three webhook events to handle:

| Event | Carries |
| --- | --- |
| **Call connect** | WACID (`wacid.*`), caller wa_id + profile, direction (`USER_INITIATED` / `BUSINESS_INITIATED`), SDP offer (non-SIP only) |
| **Call status** | `RINGING` \| `ACCEPTED` \| `REJECTED` |
| **Call terminate** | `COMPLETED` \| `FAILED`, start/end timestamps, duration, error detail |

All three echo `biz_opaque_callback_data` (≤512 chars) if we set it — use it to
carry our own call row id on outbound calls.

> ⚠️ **Signalling must not go on a queue.** We have **30–60 seconds** from the
> Call Connect webhook to accept, or Meta terminates the call as unanswered.
> This is a deliberate, documented exception to "anything that calls somebody
> else's API on behalf of a request runs on a queue"
> ([docs/implementation_queue.md](implementation_queue.md)) — signalling runs
> inline in the webhook path; only the follow-up (call record enrichment,
> notifications, AI summaries) is enqueued. Write the comment where the
> exception lives, or the next reader will "fix" it.

On the non-SIP route only, the response actions all hit one endpoint:

```
POST /<PHONE_NUMBER_ID>/calls
  { messaging_product, call_id, action: "pre_accept", session: { sdp_type: "answer", sdp } }
  { messaging_product, call_id, action: "accept",     session: { sdp_type: "answer", sdp } }
  { messaging_product, call_id, action: "reject" }
  { messaging_product, call_id, action: "terminate" }
```

`pre_accept` is optional but recommended: it establishes the WebRTC connection
before media flows, so the audio is not clipped at the start. DTMF needs an
**8000 Hz clock rate** — 48000 Hz is not supported.

### 6.4 Schema — migration `080_whatsapp_calling.sql`

Latest applied is `079_inbox_presence_channel.sql`, so `080` is free. Raw SQL in
`supabase/migrations/`, mirrored into
[packages/database/prisma/schema.prisma](../packages/database/prisma/schema.prisma),
then `npm run db:generate` from the root.

**`whatsapp_calls`** — one row per call:

```
id, account_id (FK, NOT NULL), conversation_id (FK), contact_id (FK),
wacid TEXT UNIQUE, direction TEXT, status TEXT,
started_at, answered_at, ended_at TIMESTAMPTZ,
duration_seconds INT, billed_pulses INT,
termination_reason TEXT, error_detail JSONB,
sip_call_id TEXT, agent_user_id UUID, created_at, updated_at
```

- Index `(account_id, created_at DESC)` for the call log and
  `(conversation_id, created_at DESC)` for the thread.
- RLS on, account-scoped policies matching `messages`.
- `wacid` UNIQUE is the **idempotency latch**: webhooks retry, and a duplicate
  terminate must not write a second row or double a duration.

**Widen `messages_content_type_check`** to allow `'call'`, following the exact
pattern of
[062_message_content_types.sql](../supabase/migrations/062_message_content_types.sql)
(drop the constraint, re-add with the full list — Postgres has no "add a value").
Direction, duration and outcome go in the existing `messages.metadata` JSONB.

Why put a call in `messages` at all: it gets the inbox timeline, Realtime
push, ordering, and the conversation's `last_message_at` for free, rather than a
second parallel feed that has to be merged on read.

**Calling config** — add to `whatsapp_config` rather than a new table (it is
1:1 with the phone number): `calling_status`, `call_icon_visibility`,
`callback_permission_status`, `call_hours JSONB`, `sip_hostname`, `sip_port`,
`sip_password_encrypted`, `calling_settings_synced_at`.

### 6.5 Channel and unread semantics

- ⚠️ A call stays on `channel = 'whatsapp'`. A channel is a value of
  `conversations.channel`, and a call does not arrive on a new one — the same
  reasoning that keeps Ads Manager from being a channel. **Do not touch
  `conversations_channel_chk`.**
- ⚠️ Check `nextUnreadCount` in
  [apps/web/src/lib/inbox/conversations.ts](../apps/web/src/lib/inbox/conversations.ts).
  It gates on `sender_type` so our own replies don't count. A **missed inbound
  call** should almost certainly count as unread; an *answered* one should not.
  That is a deliberate decision with a test, not an accident of whatever
  `sender_type` we happen to write.

### 6.6 Routes and UI

- `apps/api/src/whatsapp/controllers/whatsapp-calling.controller.ts` —
  `GET/PUT /whatsapp/calling/settings`, `GET /whatsapp/calling/calls`. Supabase
  cookie auth (internal dashboard surface, not `v1/*`).
- `WhatsAppCallingEnabledGuard`, copied from
  [ads-enabled.guard.ts](../apps/api/src/ads/guards/ads-enabled.guard.ts) —
  **404, not 403**, for the same reason stated there.
- Web: a Calling section under the WhatsApp channel settings — enable toggle,
  call hours editor, voicemail upload, SIP status (read-only for the customer if
  we run the trunk). Call events render in the thread; a filter for calls in the
  inbox.
- Gate the enable toggle on `messaging_limit_tier ≥ 2000` with an explanatory
  message, rather than surfacing Meta's error.

---

## 7. Phase 2 — outbound calling

**~1–2 weeks. Do not start before Phase 1 is live and calls are landing.**

### 7.1 Permission

Two ways to hold permission:

1. A **permission request message** (free-form or template) sent inside the
   customer service window.
2. `callback_permission_status: ENABLED` — anyone who calls *us* grants
   permission automatically. Cheapest path to a usable outbound feature, and the
   one to turn on first.

New table `whatsapp_call_permissions`: `(account_id, contact_id)` unique,
`granted_at`, `expires_at`, `source`, plus daily/weekly request counters.

> ⚠️ **Enforce the 1/day, 2/week request limits server-side before calling
> Meta.** Meta answers a call attempt without permission with **error 138006**;
> discovering the ceiling by being rejected burns the customer's quota and logs
> a failure against their number. Same shape as every other counter here: the
> check is ours, Meta's is the backstop.

### 7.2 Initiating

```
POST /<PHONE_NUMBER_ID>/calls
  { messaging_product, to | recipient, action: "connect",
    session: { sdp_type: "offer", sdp },        // non-SIP route only
    biz_opaque_callback_data: "<our call row id>" }
```

Returns a call id. `action: "terminate"` with `call_id` hangs up. Meta's ceiling
is 10,000 initiations / 24h per number; ours is §4.3.

### 7.3 Surfaces

Click-to-call from the inbox header and from a deal; a `call_missed` automation
trigger and a `request_call_permission` automation step; permission state shown
on the contact so an agent knows *before* clicking whether the call is legal.

---

## 8. Phase 3 — AI voice agent (sketch only)

Bridge the media leg to a realtime speech model and let the existing agent
(`ai_configs`, knowledge, skills, tools) answer the phone, metered against
`ai_credit_wallets`. Multi-week, and the credit maths in
[`creditsForGeneration()`](../apps/api/src/ai/credits/credits.constants.ts) does not describe
audio tokens — that is a new pricing question, not a new call site. **Only worth
scoping once Phase 1 proves customers answer the calls at all.**

---

## 9. Tests

Vitest, alongside the code, in the style of the existing WhatsApp tests:

- `call-webhook.util.test.ts` — field detection; all three event shapes; a
  malformed payload returns null rather than throwing (a webhook parser that
  throws drops the whole batch).
- Idempotency: the same `wacid` terminate delivered twice writes one row.
- Tenant scoping: a `calls` webhook for a `phone_number_id` we don't hold writes
  nothing.
- `nextUnreadCount` — missed call counts, answered call does not (§6.5).
- Permission counters — the 2nd request in a day is refused locally without an
  HTTP call.

---

## 10. Endpoint cheat sheet

| Purpose | Call |
| --- | --- |
| Read call settings | `GET /<PHONE_NUMBER_ID>/settings[?include_sip_credentials=true]` |
| Write call settings | `POST /<PHONE_NUMBER_ID>/settings` — body under `calling` |
| Answer / decline / hang up | `POST /<PHONE_NUMBER_ID>/calls` — `pre_accept` \| `accept` \| `reject` \| `terminate` |
| Place a call | `POST /<PHONE_NUMBER_ID>/calls` — `action: "connect"` |
| Events | webhook field **`calls`**, on the existing `whatsapp/webhook` endpoint |

Meta's docs: [Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling)
· [SIP configuration](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip)
· [Call settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)
· [Business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls)
· [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing)

---

## 11. Open risks

| Risk | Note |
| --- | --- |
| SIP exclusivity | With SIP on, the calling Graph endpoints are unavailable — the choice in §4.1 is close to irreversible per number. |
| One server per number | A customer already routing that number through another vendor cannot also route it through us; Meta terminates calls when two apps disagree. |
| Public SIP port | Breaks the "everything on 127.0.0.1 behind the host proxy" posture of `docker-compose.yml`. Needs its own firewall thinking, and SIP endpoints attract scanners within hours. |
| 30–60s answer budget | Any latency added between webhook receipt and `accept` is a dropped call. This is the reason for the queue exception in §6.3. |
| Business-initiated geography | Dead in US, Canada, Egypt, Vietnam, Nigeria — Phase 2 must degrade to "inbound only" per account, not error. |
| Voice ≠ text auditing | Calls are not transcribed by default, so the AI gates, the automation gate and the audit trail all see nothing. Worth stating in the customer-facing copy. |
