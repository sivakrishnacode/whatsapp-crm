# Instagram DM — Implementation Plan

Scope decided with the product owner (2026-07-28):

| Decision | Choice |
|---|---|
| API surface | **Instagram Login** — `graph.instagram.com`, IG user access token, no Facebook Page required |
| v1 scope | **DMs + comment moderation** (incl. private replies). No publishing, no insights, no welcome-flows/ice-breakers |
| Data model | **Unified `channel` column** — one contact, one inbox, one automation engine (rationale below) |
| Engine reuse | Unified inbox, AI auto-reply, Automations, Flows + public `v1` API |

Reference: `notes/Instagram API.postman_collection.json` → *"Instagram API with Instagram Login"*.
The *"Instagram API with Facebook Login"* half of that collection is **out of scope** — it is a
different token model and only carries Token + Reels Publishing anyway.

---

## 0. Why the unified data model

You asked me to pick. **Add a `channel` column; do not fork the tables.**

The deciding factor is engine reuse. You want Instagram wired into the inbox, AI auto-reply,
Automations, Flows *and* the partner `v1` API. Separate `instagram_*` tables means a parallel
implementation of every one of those five — five forks that then drift. The unified model pays
one migration cost and everything downstream works by default.

It is also what the codebase already assumes. [channels.ts:41-51](../apps/web/src/lib/nav/channels.ts#L41-L51)
says so explicitly:

> *"there is no `channel` column anywhere in the schema yet … When the schema gains a channel enum,
> flipping a channel to 'live' is what turns its panel into real routes."*

The one thing that scared me off it initially turned out to be cheap. `contacts.phone` is
`NOT NULL` with `@@unique([account_id, phone_normalized]) WHERE phone_normalized <> ''`. Dropping
the `NOT NULL` **does not require touching that index**: `phone_normalized` defaults to
`regexp_replace(phone, '\D', '', 'g')`, which is `NULL` for a `NULL` phone, and `NULL <> ''`
evaluates to `NULL` — so Instagram-only contacts fall outside the partial index automatically.
No reindex, no backfill, no downtime.

The real cost is the ~40-60 read sites that assume `contact.phone` is a string. That cost is
**findable** — `prisma:generate` turns it into a compile error list. Budget a focused pass; do
not let it leak into every phase.

---

## 1. Architecture at a glance

```
                    ┌────────────────────────────────┐
  Meta ──POST──▶    │ /instagram/webhook             │  object:"instagram"
                    │  sig: INSTAGRAM_APP_SECRET     │  entry[].messaging[]  (DMs)
                    └───────────────┬────────────────┘  entry[].field=comments
                                    │
                    ┌───────────────▼────────────────┐
                    │ InstagramWebhookService        │  routes by event kind
                    └───────────────┬────────────────┘
                                    │  resolves ig_user_id → instagram_config → account_id
                    ┌───────────────▼────────────────┐
                    │ contacts / conversations /     │  channel='instagram'
                    │ messages   (SHARED with WA)    │
                    └───────────────┬────────────────┘
                                    │  same fan-out the WA webhook already does
        ┌───────────────┬───────────┴───────┬──────────────────┐
        ▼               ▼                   ▼                  ▼
   FlowDispatch   AutomationDispatch    AiReplyService   WebhookDeliverService
        └───────────────┴───────────┬───────┴──────────────────┘
                                    ▼
                    ┌────────────────────────────────┐
                    │ ChannelSenderService  (NEW)    │  ← the pivotal abstraction
                    └───────┬────────────────┬───────┘
                            ▼                ▼
                 FlowMetaSendService   InstagramSendService
                  (graph.facebook)      (graph.instagram)
```

`ChannelSenderService` is the load-bearing piece. Today `AiReplyService`, the flow executor and
the automation step executor all call `FlowMetaSendService` directly, i.e. they are hard-wired to
WhatsApp. Introducing one channel-routing sender is what makes Instagram work in all three engines
without editing any of their logic.

### Where Instagram genuinely differs from WhatsApp

These are not cosmetic; each one needs deliberate handling.

| | WhatsApp | Instagram |
|---|---|---|
| Host | `graph.facebook.com/v21.0` | `graph.instagram.com/v23.0` |
| Identity | E.164 phone (`wa_id`) | IGSID — **app-scoped**, no phone, differs per app |
| Webhook envelope | `entry[].changes[].value.messages[]` | `entry[].messaging[]` (Messenger-shaped) |
| Re-engagement | 24h window **+ approved templates** | 24h window, **no templates at all** |
| Beyond 24h | Template message | `tag: "HUMAN_AGENT"` only — 7 days, needs Human Agent approval |
| Delivery status | `sent`/`delivered`/`read` per message | **No delivery receipts.** Only `messaging_seen` (read) |
| Business replies from native app | not surfaced | arrive as `is_echo: true` webhooks — must ingest + dedupe |
| Broadcasts | Supported via templates | **Impossible.** Must be blocked in UI |
| Token | Long-lived, effectively static | 60-day, **must be refreshed** by a scheduled job |
| Signature secret | `META_APP_SECRET` | `INSTAGRAM_APP_SECRET` (separate app, separate secret) |

The two that will bite if forgotten: **no delivery receipts** (the inbox tick UI must not show
"delivered" for IG) and **echo dedupe** (otherwise every agent reply sent from the phone appears
twice).

---

## Phase 1 — Schema & migration  `size: M`  `blocking: everything`

**Files:** `apps/api/prisma/schema.prisma`, new `supabase/migrations/<ts>_instagram_channel.sql`

```sql
-- 1. Channel enum as a CHECK-constrained text (matches existing style; no PG enum in this schema)
ALTER TABLE conversations
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN last_inbound_at timestamptz,      -- drives the 24h window
  ADD CONSTRAINT conversations_channel_chk CHECK (channel IN ('whatsapp','instagram'));

CREATE INDEX idx_conversations_account_channel_time
  ON conversations (account_id, channel, last_message_at DESC);

-- 2. Contacts gain an Instagram identity; phone becomes optional
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN ig_scoped_id text,
  ADD COLUMN ig_username  text,
  ADD CONSTRAINT contacts_identity_chk
    CHECK (phone IS NOT NULL OR ig_scoped_id IS NOT NULL);

CREATE UNIQUE INDEX idx_contacts_account_igsid
  ON contacts (account_id, ig_scoped_id) WHERE ig_scoped_id IS NOT NULL;

-- 3. Per-account Instagram connection (mirrors whatsapp_config)
CREATE TABLE instagram_config (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id),
  ig_user_id        text NOT NULL UNIQUE,        -- webhook entry[].id resolves through this
  ig_username       text,
  access_token      text NOT NULL,               -- encrypted at rest (encryption.util)
  token_expires_at  timestamptz,
  token_refreshed_at timestamptz,
  status            text NOT NULL DEFAULT 'disconnected',
  subscribed_fields text[] DEFAULT '{}',
  subscribed_at     timestamptz,
  connected_at      timestamptz,
  last_error        text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- 4. Comment moderation
CREATE TABLE instagram_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ig_comment_id  text NOT NULL,
  ig_media_id    text NOT NULL,
  parent_comment_id text,
  from_igsid     text,
  from_username  text,
  contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,
  text           text,
  is_from_business boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'open',   -- open | replied | hidden | deleted
  replied_at     timestamptz,
  private_reply_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (account_id, ig_comment_id)
);

CREATE TABLE instagram_media (             -- thin cache so the Posts/Comments UI has context
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ig_media_id   text NOT NULL,
  media_type    text,
  media_product_type text,
  permalink     text,
  thumbnail_url text,
  caption       text,
  synced_at     timestamptz DEFAULT now(),
  UNIQUE (account_id, ig_media_id)
);
```

**Must not be skipped:**
- RLS policies on the three new tables, matching the `account_id`-scoping pattern used by
  `whatsapp_config` / `whatsapp_orders`. The web inbox reads Supabase **directly**
  ([inbox/page.tsx:124](../apps/web/src/app/(dashboard)/inbox/page.tsx#L124)), so a missing policy
  is a silent empty list, not an error.
- `findOrCreateConversation` currently looks up by `(account_id, contact_id)` with **no channel
  filter** and there is no unique constraint backing it. Once a contact can have both a WhatsApp
  and an Instagram thread, that lookup **must** add `channel`. This is the single most likely
  cross-channel bug in the whole project.
- Then: `npm run prisma:generate`, `npm run typecheck`, and fix the `contact.phone` nullability
  fallout in one pass.

---

## Phase 2 — Instagram module skeleton + OAuth connect  `size: M`

**New:** `apps/api/src/instagram/`

```
instagram.module.ts
ig-api.util.ts                          named-options fetch wrappers (mirror meta-api.util.ts style)
controllers/
  instagram-connect.controller.ts       @Controller('instagram') + SupabaseAuthGuard
services/
  instagram-connect.service.ts
  instagram-token-refresh.service.ts
processors/
  instagram-token-refresh.processor.ts  BullMQ repeatable — precedent: messaging-limits.processor.ts
```

OAuth (Instagram Login — **verify each URL against live docs before coding**):

1. `GET /instagram/connect/start` → redirect to
   `https://www.instagram.com/oauth/authorize?client_id={IG_APP_ID}&redirect_uri={cb}&response_type=code&scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments`
   with a signed, account-bound `state` (CSRF + tenant binding).
2. `GET /instagram/connect/callback` → `POST https://api.instagram.com/oauth/access_token`
   (`grant_type=authorization_code`) → short-lived token + `user_id`.
3. Exchange: `GET graph.instagram.com/access_token?grant_type=ig_exchange_token` → 60-day token.
4. `GET graph.instagram.com/{ig_user_id}?fields=user_id,username,profile_picture_url`.
5. `POST graph.instagram.com/{ig_user_id}/subscribed_apps` with
   `["messages","messaging_postbacks","messaging_seen","messaging_referral","message_reactions","comments","live_comments","mentions"]`.
   *(Drop `standby` and `messaging_handover` — handover protocol is out of scope.)*
6. Persist encrypted token via `common/security/encryption.util`. Never log it.

Token refresh job — **not optional, the integration dies at day 60 without it**:
- `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
- Constraint: token must be **≥24h old** and **not yet expired**. Run daily; refresh anything
  with `token_expires_at < now() + 10 days`. On failure, set `status='token_expired'` and surface
  a reconnect banner in the UI.

Also: `GET /instagram/config` (status for `use-channel-status.tsx`), `DELETE /instagram/config`
(disconnect → `DELETE /subscribed_apps` then soft-delete the row).

---

## Phase 3 — Webhook ingest  `size: L`  `the core`

**New:** `controllers/instagram-webhook.controller.ts`, `services/instagram-webhook.service.ts`,
`services/instagram-message.service.ts`, `utils/ig-webhook-signature.util.ts`

**Refactor first:** [webhook-signature.util.ts](../apps/api/src/whatsapp/utils/webhook-signature.util.ts)
hard-codes `process.env.META_APP_SECRET`. Parameterise the secret and move it to
`common/security/meta-signature.util.ts`; the WhatsApp controller keeps passing `META_APP_SECRET`,
Instagram passes `INSTAGRAM_APP_SECRET`. Keep the fail-closed behaviour exactly as-is.

Controller mirrors the WhatsApp one: `GET` for `hub.challenge`, `POST` verifying
`x-hub-signature-256` against the **raw** body, then respond `200` immediately and process
fire-and-forget.

> ⚠️ Verify token strategy: WhatsApp stores a per-config encrypted `verify_token` and scans all
> rows. Instagram has **one webhook URL per Meta app**, not per account, so use a single
> `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` env var. Simpler and correct for this surface.

Router — `entry[].messaging[]` for DMs, `entry[].field` for comments:

| Event | Handling |
|---|---|
| `message` (text) | upsert contact by IGSID → find/create conversation (`channel='instagram'`) → insert message `sender_type='customer'` |
| `message.attachments[]` | `image`/`video`/`audio`/`file`/`share`/`story_mention` → map to existing `content_type`; store CDN URL. **These URLs expire — mirror to storage, same reasoning as the WhatsApp media proxy** |
| `message.reply_to.story` | inbound story reply → set `content_type='text'`, stash story id/url; this is a high-value automation trigger |
| `message.reply_to.mid` | map to `messages.reply_to_message_id` via existing `lookupInternalIdByMetaId` |
| `message.is_echo: true` | business sent it (from the IG app or another tool) → insert as `sender_type='agent'`, **dedupe on `message_id`** against sends we made ourselves |
| `message.is_deleted` | soft-delete / tombstone the message row |
| `message_edit` | update `content_text`, keep an edit count |
| `reaction` | `action: react|unreact` → `message_reactions` upsert/delete, `actor_type='customer'`. Shape differs from WhatsApp (`reaction.mid`, not `reaction.message_id`) |
| `read` (`messaging_seen`) | mark our outbound messages up to `mid` as `read` |
| `postback` | ice-breaker / button tap → store `interactive_reply_id = payload`, feed to flows exactly like a WhatsApp button reply |
| `referral` | `ig.me` deep-link `ref` param → attribution; same slot the CTWA click tracking uses |
| `field: comments` | Phase 6 |

Contact resolution: `findOrCreateInstagramContact(accountId, igsid, username)`. Look up
`GET graph.instagram.com/{igsid}?fields=name,username,profile_pic` for name + avatar on first
sight. **Do not attempt phone-based dedupe against WhatsApp contacts** — the IGSID carries no
phone, and cross-channel identity merging is a separate feature. Ship them as distinct contacts
with `ig_scoped_id` set; add merge later.

Set `conversations.last_inbound_at` on every inbound. This is what Phase 4 gates sends on.

---

## Phase 4 — Outbound send + the 24-hour window  `size: M`

**New:** `services/instagram-send.service.ts`, `ig-window.util.ts`

All sends: `POST graph.instagram.com/{ig_user_id}/messages`, `Bearer {access_token}`.

| Capability | Body |
|---|---|
| Text | `{recipient:{id}, message:{text}}` |
| Media | `{message:{attachment:{type:'image'|'video'|'audio', payload:{url}}}}` |
| Reusable asset | upload via `POST /{ig_user_id}/message_attachments` → send `payload:{attachment_id}` |
| Sticker | `{message:{attachment:{type:'like_heart'}}}` |
| Reaction | `{sender_action:'react', payload:{message_id, reaction:'love'}}` |
| Quick replies | `{messaging_type:'RESPONSE', message:{text, quick_replies:[{content_type:'text',title,payload}]}}` |
| Button template | `{message:{attachment:{type:'template', payload:{template_type:'button', text, buttons}}}}` |
| Generic template | carousel — `template_type:'generic'` |
| Published post | `{message:{attachment:{type:'MEDIA_SHARE', payload:{id: post_id}}}}` |
| Beyond 24h | add `tag:'HUMAN_AGENT'` |

`ig-window.util.ts` — one pure function, unit-tested:

```ts
canSend(conv): { allowed: true } | { allowed: true, requiresTag: 'HUMAN_AGENT' } | { allowed: false, reason }
```

- inside 24h of `last_inbound_at` → free
- 24h–7d → `HUMAN_AGENT` tag, **only if the app has Human Agent approval** (env flag
  `INSTAGRAM_HUMAN_AGENT_ENABLED`, default `false`)
- beyond 7d → refuse before the network call, with a message the UI can render

**Hard block:** broadcasts. `POST /whatsapp/broadcast` and the broadcast UI must reject Instagram
contacts outright. There is no template mechanism; bulk unsolicited DMs will get the app banned.

---

## Phase 5 — Engine wiring  `size: L`  `the payoff`

**New:** `apps/api/src/common/messaging/channel-sender.service.ts`

```ts
@Injectable()
export class ChannelSenderService {
  // reads conversations.channel, delegates. forwardRef both ways — the
  // codebase already uses this pattern for AiReplyService ↔ WhatsappWebhookService.
  sendText(args: { accountId; conversationId; text; ... }): Promise<{ message_id: string }>
  sendMedia(...)
  sendButtons(...)   // WA interactive buttons ⟷ IG button template / quick replies
  sendList(...)      // WA only — throws UnsupportedOnChannel for IG
}
```

Then swap the three call sites off `FlowMetaSendService`:
- [ai-reply.service.ts:24](../apps/api/src/ai/services/ai-reply.service.ts#L24)
- the flow step executor
- the automation step executor

Once that lands, Instagram inherits AI auto-reply and both engines with **no further changes to
their logic**.

Remaining wiring:
- **Automations** — add `channel` to `AutomationDispatchInput` + the trigger matcher. New IG
  triggers: `instagram_story_reply`, `instagram_comment`, `instagram_postback`. Guard
  WhatsApp-only actions (send-template, send-list, send-catalog) so they no-op with a logged
  reason on IG rather than throwing.
- **Flows** — `channel` on `FlowRun`; the builder must grey out WhatsApp-only node types when a
  flow's trigger is Instagram.
- **v1 public API** — `channel` filter + field on `v1/conversations`, `v1/messages`,
  `v1/contacts`; allow `POST v1/messages` with an IG conversation. Update `docs/public-api.md`.
- **Outbound webhooks** — add `channel` to every `WebhookDeliverService` payload; new events
  `instagram.comment.created`, `instagram.comment.replied`.

---

## Phase 6 — Comment moderation + private replies  `size: M`

**New:** `controllers/instagram-comments.controller.ts`, `services/instagram-comments.service.ts`

- Ingest the `comments` / `live_comments` webhook → `instagram_comments`. Skip
  `is_from_business` echoes for the "needs attention" count.
- `GET graph.instagram.com/{ig_media_id}/comments?fields=from,text,timestamp,replies` — backfill.
- **Public reply:** `POST /{ig_comment_id}/replies` `{message}`.
- **Private reply:** `POST /{ig_user_id}/messages` `{recipient:{comment_id}, message:{text}}`.
  This opens a real DM thread → create/attach a `conversations` row and link it via
  `private_reply_conversation_id`, so the resulting thread lands in the unified inbox.
  ⚠️ One private reply per comment, and only within 7 days of the comment.
- Hide / delete: `POST /{ig_comment_id}` `{hide:true}`, `DELETE /{ig_comment_id}`.
- **Comment → DM automation**: keyword on a comment fires a private reply. This is the headline
  growth feature of the whole phase; make sure the automation trigger lands with it.

---

## Phase 7 — Frontend  `size: L`

- [channels.ts](../apps/web/src/lib/nav/channels.ts) — flip `instagram` to `status: 'live'`,
  update the stale comment at lines 41-51.
- [use-channel-status.tsx](../apps/web/src/hooks/use-channel-status.tsx) — fetch
  `GET /instagram/config` alongside WhatsApp; drop the "only WhatsApp has a real backend" note.
- Replace the `[[...section]]` catch-all
  ([instagram/[[...section]]/page.tsx](<../apps/web/src/app/(dashboard)/channels/instagram/[[...section]]/page.tsx>))
  with real routes: `page.tsx` (overview + connect CTA), `settings/`, `comments/`, `posts/`,
  `dm-agents/`. Keep the catch-all as the fallback for anything not yet built.
- **Inbox** ([inbox/page.tsx](<../apps/web/src/app/(dashboard)/inbox/page.tsx>)) — this is the
  bulk of the work:
  - select `channel`, render a channel badge per thread, add an all/WhatsApp/Instagram filter
  - composer switches on channel: hide template picker + list messages for IG, show quick-reply
    and button-template builders instead
  - **24h window banner** with a live countdown; disable the composer past the window (or offer
    the HUMAN_AGENT path if enabled)
  - **no delivery ticks for IG** — only sent and read. Showing a "delivered" tick that can never
    arrive is a bug report waiting to happen
  - contact panel handles `phone === null` gracefully; show `@username` instead
- Broadcast composer: exclude Instagram-only contacts from audience selection, with an
  explanatory empty state.

---

## Phase 8 — Tests & docs  `size: M`

Vitest, matching existing `*.test.ts` placement:
- `ig-webhook-signature.util.test.ts` — valid / tampered / missing secret (fail-closed)
- `instagram-webhook.service.test.ts` — one fixture per event kind from the Postman collection's
  *Webhook payload reference* folder. **Echo dedupe and reaction unreact are the two to get right.**
- `ig-window.util.test.ts` — boundary cases at 24h, 7d, and with the HUMAN_AGENT flag off
- `instagram-send.service.test.ts` — body shape per message type
- `instagram-comments.service.test.ts` — private-reply-opens-conversation
- Update `docs/public-api.md`; add `docs/instagram.md` mirroring `docs/razorpay.md`.

---

## Suggested sequencing

```
Phase 1 (schema)  ──▶ Phase 2 (connect) ──▶ Phase 3 (webhook) ──▶ Phase 4 (send)
                                                                        │
                              ┌─────────────────────────────────────────┤
                              ▼                                         ▼
                        Phase 5 (engines)                        Phase 7 (frontend)
                              │                                         │
                              ▼                                         │
                        Phase 6 (comments) ◀────────────────────────────┘
                                                    Phase 8 (tests) throughout
```

Phases 1→4 are strictly serial and are the real integration. 5 and 7 parallelise. There is a
**demoable milestone at the end of Phase 4 + a minimal slice of Phase 7**: DMs arriving and being
answered in the inbox.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `contacts.phone` nullability breaks unrelated code | Do it in Phase 1 as one focused typecheck-driven pass; do not spread it |
| `findOrCreateConversation` ignores channel → cross-channel message leak | Add the channel filter *in the same commit* as the column; add a regression test |
| 60-day token expiry silently kills the integration | Refresh job in Phase 2, not later. Alert + reconnect banner on failure |
| Echo webhooks duplicate every agent reply | Dedupe on `messages.message_id` (already indexed) |
| Instagram media CDN URLs expire | Mirror to storage on ingest, same as the WhatsApp media path |
| App gets restricted for bulk DMs | Hard-block broadcasts for IG in Phase 4 |
| Meta App Review rejects the permissions | Start the review **now**, in parallel with Phase 1 — see `instagram-meta-setup-checklist.md` |

The last one is the schedule risk, not a code risk. App Review is the long pole.
