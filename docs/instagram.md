# Instagram DMs & comment moderation

Instagram is a first-class channel alongside WhatsApp: shared contacts,
one inbox, and the same automations, flows, AI assistant and public API.

Built on the **Instagram Login** surface (`graph.instagram.com`) — the
business logs in with their Instagram account directly, no Facebook Page
required. Reference: `notes/Instagram API.postman_collection.json` →
*"Instagram API with Instagram Login"*.

---

## How it differs from WhatsApp

These are not cosmetic. Each one shaped a design decision.

| | WhatsApp | Instagram |
|---|---|---|
| Host | `graph.facebook.com/v21.0` | `graph.instagram.com/v23.0` |
| App credentials | `META_APP_ID` / `META_APP_SECRET` | **`INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`** — a second credential pair inside the *same* Meta app (see below) |
| Identity | E.164 phone (`wa_id`) | IGSID — app-scoped, **no phone** |
| Webhook envelope | `entry[].changes[].value.messages[]` | `entry[].messaging[]` (Messenger-shaped) |
| Timestamps | epoch **seconds** | epoch **milliseconds** |
| Re-engagement | 24h window **+ approved templates** | 24h window, **no templates at all** |
| Beyond 24h | Send a template | `tag: "HUMAN_AGENT"` only — 7 days, needs approval |
| Delivery status | `sent` → `delivered` → `read` | `sent` → `read`. **No delivery receipt** |
| Business replies from the native app | not surfaced | arrive as `is_echo: true` webhooks |
| Broadcasts | Supported | **Impossible** — no templates, so no compliant bulk send |
| Token | Effectively static | **60-day, must be refreshed** or the connection dies |
| Media | Permanent media id, re-resolved on demand | Expiring CDN URL — **mirrored at ingest** |

---

## Data model

There are no `instagram_conversations` / `instagram_messages` tables.
Contacts, conversations and messages are **shared**, discriminated by
`conversations.channel` (migration 050). That is what lets the inbox,
AI auto-reply, automations, flows and the `v1` API work on Instagram
without a parallel implementation of each.

```
contacts
  phone           NULL for Instagram-only contacts
  ig_scoped_id    IGSID, unique per account (partial index)
  ig_username     cached @handle, display only
  CHECK (phone IS NOT NULL OR ig_scoped_id IS NOT NULL)

conversations
  channel          'whatsapp' | 'instagram'
  last_inbound_at  drives the 24-hour reply window

messages
  metadata    JSONB — story-reply context, quick-reply payloads, edits
  deleted_at  tombstone for platform-side deletions

instagram_config     one connection per account (token encrypted at rest)
instagram_comments   moderation queue + the comment → DM link
instagram_media      thin post cache for the Comments view
```

**Identity is not merged across channels.** An IGSID carries no phone,
so there is no reliable way to tell that `@someuser` is the same person
as `+91xxxxxxxxxx`. The same human on both channels is two contacts.
Guessing here would cross-link strangers' conversation histories.

**Every lookup of "the conversation for this contact" must pin the
channel.** A contact can now own one thread per platform; an unfiltered
`findFirst({ account_id, contact_id })` can return the wrong one and
route a reply to the wrong platform.

---

## Setup

Operator-side steps (Meta dashboard, App Review, business prerequisites)
are in `docs/meta-platform-setup.md` — the runbook covering all four Meta
surfaces at once — and `notes/instagram-meta-setup-checklist.md`.

> **These are not a separate Meta app.** Meta generates an *Instagram app
> ID* and *Instagram app secret* inside your existing app, shown at
> **Instagram → API setup with Instagram login**. They are genuinely
> different values from `META_APP_ID` / `META_APP_SECRET` — Instagram
> webhooks are signed with the Instagram secret — but one app holds both.
> Do not create a second app: `ig_scoped_id` is app-scoped, so moving
> Instagram to another app invalidates every stored Instagram identity.

In brief:

```bash
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=              # NOT META_APP_SECRET — different app
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=
INSTAGRAM_REDIRECT_URI=https://<api-domain>/instagram/connect/callback
INSTAGRAM_API_VERSION=v23.0
INSTAGRAM_HUMAN_AGENT_ENABLED=false
```

Two URLs, easily confused, both required:

| Meta dashboard field | URL |
|---|---|
| Webhooks → Callback URL | `https://<api-domain>/instagram/webhook` |
| Business login → OAuth Redirect URI | `https://<api-domain>/instagram/connect/callback` |

The webhook must echo `hub.challenge` as plain text; the OAuth callback
responds with a 302. Putting the latter in the Webhooks field is the
most common setup mistake and produces only a generic
*"couldn't be validated"* error.

### Migrations

```bash
./scripts/apply-migration.sh 050_instagram_channel
./scripts/apply-migration.sh 051_instagram_media_bucket
```

Both idempotent. 050 drops `NOT NULL` from `contacts.phone`; this does
**not** require touching the `phone_normalized` unique index, because
`regexp_replace(NULL, …)` is `NULL` and the partial predicate
`phone_normalized <> ''` excludes those rows automatically.

---

## Connect flow

1. `GET /instagram/connect/start` → returns the consent URL. The `state`
   is an HMAC over `{accountId, userId, nonce, exp}` signed with the app
   secret, so the callback can only ever write to the account that
   started it (see `oauth-state.util.ts`).
2. Business approves on instagram.com.
3. `GET /instagram/connect/callback` → code → short-lived token →
   60-day token → profile → **subscribe webhooks** → persist encrypted.

Step 3's subscription is the one that is easy to forget and impossible
to notice: without it the connection looks perfectly healthy and simply
never receives a message. The settings page surfaces any unsubscribed
field prominently, with a re-subscribe button.

### Token refresh — not optional

Instagram long-lived tokens expire after exactly 60 days with no silent
renewal. `InstagramTokenRefreshService` sweeps daily and renews anything
within 10 days of expiry. **If that job stops running, every Instagram
connection in the system dies 60 days later, all at once**, and each
business must re-authorise by hand.

---

## Webhook ingest

`POST /instagram/webhook` verifies `x-hub-signature-256` against the raw
body using `INSTAGRAM_APP_SECRET`, answers `200` immediately, then
processes fire-and-forget.

Routing is by `entry[].id`, matched against **either** `ig_user_id` or
`ig_app_scoped_id`. One Instagram account reports two different ids
(`GET /me?fields=user_id` vs the envelope's own `id`) and which appears
varies — matching only one silently drops every message.

| Event | Handling |
|---|---|
| `message` | inbound customer message |
| `message.is_echo` | business replied from the Instagram app → stored as `agent`, **deduped on `mid`** |
| `message.attachments[]` | mirrored into the `instagram-media` bucket (CDN URLs expire) |
| `message.reply_to.story` | story reply; context kept in `metadata` |
| `message.is_deleted` | tombstoned via `deleted_at`, not deleted |
| `message_edit` | text updated, original kept in `metadata` |
| `reaction` | `react`/`unreact` → `message_reactions` |
| `read` | marks outbound messages read up to that `mid` |
| `postback` | ice-breaker/button tap → modelled as an interactive reply |
| `referral` | ig.me deep-link attribution |
| `comments` / `live_comments` | `instagram_comments` moderation queue |

Echoes are stored but deliberately **do not** trigger flows, automations
or the AI bot — otherwise the CRM answers its own outbound messages.

---

## Sending

All sends go through `InstagramSendService`, which resolves the target,
proves account ownership, loads a usable token and evaluates the
messaging window **before** any network call. Repeatedly attempting
out-of-window sends is exactly what Meta restricts apps for.

`evaluateSendWindow()` (`ig-window.util.ts`) returns one of:

- inside 24h → send freely
- 24h–7d **and** Human Agent approved → send with `tag: HUMAN_AGENT`
- otherwise → refuse locally, with a reason the UI shows verbatim

The engines do not call this directly. `ChannelSenderService`
(`common/messaging/channel-sender.service.ts`) reads
`conversations.channel` and delegates, so the AI reply service, the flow
runner and the automation step executor all work on both channels with
no platform branch. Capability gaps are explicit:

- **list messages** → `UnsupportedOnChannelError` on Instagram (a list
  cannot be flattened to quick replies without losing rows)
- **templates** → `assertSupported('templates')` refuses on Instagram
- **buttons** → genuinely equivalent; WhatsApp interactive buttons map
  to Instagram quick replies

---

## Comment moderation

Comments are **not** conversations — they are public, attached to a
post, and have no thread. They live in `instagram_comments`.

A **private reply** is the bridge: it opens a real DM thread with
someone who has never messaged the business, and that thread *is* a
conversation. Meta allows exactly **one per comment, within 7 days**;
both limits are enforced locally before the API call, so an agent gets a
clear reason rather than an opaque Graph error.

Webhooks only cover comments made after connecting, so
`POST /instagram/media/sync` and
`POST /instagram/media/:mediaId/comments/sync` backfill the rest.

---

## Endpoints

Dashboard (Supabase cookie auth), reachable from the web app under
`/api/instagram/*`:

| Method | Path |
|---|---|
| GET | `/instagram/connect/start` |
| GET | `/instagram/connect/callback` *(no guard — authorised by signed state)* |
| GET | `/instagram/config` |
| POST | `/instagram/config/resubscribe` |
| DELETE | `/instagram/config` |
| GET | `/instagram/conversations/:id/window` |
| POST | `/instagram/send` |
| POST | `/instagram/react` |
| GET | `/instagram/comments` · `/instagram/media` |
| POST | `/instagram/comments/:id/reply` · `/private-reply` · `/hide` |
| DELETE | `/instagram/comments/:id` |
| POST | `/instagram/media/sync` · `/instagram/media/:mediaId/comments/sync` |

There is deliberately **no broadcast endpoint**.

Public API: `v1/conversations` accepts `?channel=instagram` and every
conversation carries `channel` + `last_inbound_at`; `v1/contacts`
carries `instagram_username` and `channels`; `POST /v1/messages` routes
Instagram conversations automatically and rejects templates and product
messages with `unsupported_on_channel`.

---

## Local testing

```bash
# Attach an account using a dashboard-generated token (skips OAuth)
cd apps/api && npx tsx scripts/instagram-connect-manual.ts --token '<token>'

# Drive the full ingest path with a correctly-signed fake payload
npx tsx scripts/instagram-fake-webhook.ts \
  --ig-user-id <id> --kind text|echo|reaction|seen|postback|story|comment
```

The webhook needs a public HTTPS URL, so a tunnel is required for real
Meta traffic. Whatever sits in front of the API **must preserve the raw
request body** — any middleware that re-serialises JSON breaks the
signature HMAC.

In Development Mode the app can only exchange messages with accounts
holding a role on it. Add them as **Instagram Testers** and accept the
invite from inside the Instagram app.
