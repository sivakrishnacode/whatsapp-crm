# Instagram DM — What YOU need to do outside the codebase

Companion to `instagram-dm-implementation-plan.md`. Nothing here is code — it is Meta Dashboard
configuration, business-account prerequisites, App Review, and env vars. **Items marked 🔴 block
development**; start them before or alongside Phase 1.

---

## 0. The one thing to start today

🔴 **Meta App Review for `instagram_business_manage_messages`.**

Until it is approved, your app is in Development Mode and can only message Instagram accounts
that hold a **role on the app** (admin/developer/tester). Review turnaround is typically days to
weeks and can bounce for a bad screencast. Everything else on this list is an afternoon; this is
the schedule risk. See §5.

---

## 1. Instagram Professional account prerequisites

For **every** business that will connect (including your own test account):

- [ ] The Instagram account is a **Professional account** — Business or Creator.
      Personal accounts cannot use the messaging API at all.
      *Instagram app → Settings → Account type and tools → Switch to professional account*
- [ ] **Allow access to messages** is ON.
      *Instagram app → Settings → Messages and story replies → Message controls →
      "Connected tools" / "Allow access to messages" → ON*
      🔴 If this is off, webhooks silently never fire. It is the #1 cause of "my integration
      receives nothing" and there is no error anywhere to tell you.
- [ ] The account has **no active Business Manager / Page-based messaging integration** that would
      conflict — an IG account can only be connected to one messaging app at a time in practice.

> With **Instagram Login** (the surface we chose) a linked Facebook Page is **not** required.
> This is the main reason to prefer it — your customers onboard with just their Instagram login.

---

## 2. Meta App Dashboard configuration

You said you already created the app. Verify it is the right *type* and finish the setup.

### 2.1 Confirm the app type 🔴
- [ ] App has the **Instagram** product added, configured under
      **Instagram → API setup with Instagram login**
      *(NOT "API setup with Facebook login" — that is the other, out-of-scope surface)*
- [ ] From that page, record:
  - **Instagram App ID** → `INSTAGRAM_APP_ID`
  - **Instagram App Secret** → `INSTAGRAM_APP_SECRET`
      ⚠️ These are **different values** from the app-level `META_APP_ID` / `META_APP_SECRET` you
      already use for WhatsApp. Webhook signature verification uses the *Instagram* secret. Mixing
      them up produces a 100% signature-rejection rate with no other symptom.

### 2.2 OAuth redirect URIs
Under **Instagram → API setup with Instagram login → Business login settings**:

- [ ] **OAuth Redirect URI** — add all of these:
  - `https://<your-api-domain>/instagram/connect/callback`
  - `https://<ngrok-or-tunnel>/instagram/connect/callback` (local dev)
- [ ] **Deauthorize callback URL** — `https://<your-api-domain>/instagram/deauthorize`
- [ ] **Data deletion request URL** — `https://<your-api-domain>/instagram/data-deletion`

> The last two are **required for App Review approval**, not optional. Plan a small endpoint for
> each (they can be minimal, but they must respond correctly to Meta's signed request).

### 2.3 Webhooks 🔴
Under **Instagram → Webhooks** (or **Products → Webhooks → Instagram**):

- [ ] **Callback URL:** `https://<your-api-domain>/instagram/webhook`
- [ ] **Verify Token:** generate a random string, save it as `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
- [ ] Subscribe these fields:
  - `messages` 🔴
  - `messaging_postbacks`
  - `messaging_seen`
  - `messaging_referral`
  - `message_reactions`
  - `comments` (Phase 6)
  - `live_comments` (Phase 6)
  - `mentions` (Phase 6)
  - *Skip:* `standby`, `messaging_handover`, `story_insights` — out of scope
- [ ] Click **Verify and Save**. It will fail until the endpoint exists — expect to come back here
      during Phase 3.

> The callback URL must be **public HTTPS with a valid certificate**. For local development use
> `ngrok` / `cloudflared`; the URL changes on every restart unless you have a reserved domain —
> get a reserved one, you will re-enter this URL a lot otherwise.

### 2.4 Permissions to request
Under **App Review → Permissions and Features**:

| Permission | Needed for | Access level |
|---|---|---|
| `instagram_business_basic` | profile, account info | Standard |
| `instagram_business_manage_messages` | **send/receive DMs** 🔴 | **Advanced — requires review** |
| `instagram_business_manage_comments` | comment moderation, private replies | **Advanced — requires review** |
| `instagram_business_content_publish` | *not needed* — publishing is out of scope | — |
| **Human Agent** | replying 24h–7d after last user message | **Separate review, request only if needed** |

- [ ] Request Advanced Access for the first three.
- [ ] Decide on **Human Agent**. It lets human staff reply up to 7 days out instead of 24 hours.
      For a CRM with human agents this is genuinely valuable — but it is a separate review with
      a higher bar. **Recommendation: ship v1 without it**, keep the code path behind
      `INSTAGRAM_HUMAN_AGENT_ENABLED=false`, and apply once you have live usage to show reviewers.

### 2.5 App roles for development 🔴
Under **App roles → Roles**:
- [ ] Add the Instagram accounts you will test with as **Instagram Testers**
- [ ] **Accept the invite from inside the Instagram app**:
      *Settings → Apps and websites → Tester invites → Accept*
      Easy to miss; without acceptance the account behaves as if it were never added.

---

## 3. Infrastructure

- [ ] **Public HTTPS endpoint** for the webhook, with a valid (non-self-signed) certificate.
- [ ] **Reserved dev tunnel domain** (ngrok paid / Cloudflare Tunnel) so the webhook URL is stable.
- [ ] Confirm your reverse proxy / load balancer **preserves the raw request body**. Signature
      verification HMACs the exact bytes — any middleware that re-serialises JSON breaks it.
      The existing WhatsApp webhook already relies on `req.rawBody`, so this is likely fine, but
      verify it holds for the new path.
- [ ] Webhook responses must return **200 within a few seconds**. Meta retries and eventually
      disables a consistently slow subscription. (The code answers immediately and processes
      async — just don't regress that.)
- [ ] Media storage bucket for mirroring Instagram CDN attachments (their URLs expire).
      Reuse whatever the WhatsApp media path already uses.

---

## 4. Environment variables to add

Add to `.env` for API, plus your deploy environment (and Docker Compose):

```bash
# Instagram Login app — NOTE: distinct from META_APP_ID / META_APP_SECRET
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=          # random string; must match the Dashboard exactly
INSTAGRAM_REDIRECT_URI=https://<api-domain>/instagram/connect/callback
INSTAGRAM_API_VERSION=v23.0              # check the Dashboard for the newest available
INSTAGRAM_HUMAN_AGENT_ENABLED=false      # flip only after Human Agent approval
```

- [ ] Also set in: production/staging secrets, `docker-compose.yml`, and any `.env.example`.
- [ ] Confirm `ENCRYPTION_KEY` (used by `common/security/encryption.util`) is present in every
      environment — Instagram tokens are stored encrypted with it.

---

## 5. App Review submission — what to prepare

This is where most integrations lose weeks. Prepare before submitting:

- [ ] **Screencast** showing the *complete* user journey: a business logs into your CRM →
      clicks Connect Instagram → completes the Instagram OAuth dialog → an end user sends a DM
      from Instagram → the message appears in your inbox → an agent replies → the reply appears
      in Instagram. Uninterrupted, narrated, no cuts. Reviewers reject vague or partial videos.
- [ ] **Step-by-step written instructions** for the reviewer, including **working test
      credentials** for your app (a demo account with Instagram already connected).
- [ ] **Detailed use-case description** per permission. Be concrete: *"Businesses using our CRM
      manage customer support conversations from Instagram Direct in a shared team inbox"* — not
      *"we need to read messages."*
- [ ] **Privacy Policy URL** — publicly reachable, must specifically cover what Instagram data you
      collect, why, how long you retain it, and how a user requests deletion.
- [ ] **Terms of Service URL**.
- [ ] **App icon** (1024×1024) and a completed **Business Verification** for your Meta business.
      🔴 Business Verification can itself take days and requires legal documents — check whether
      your business is already verified from the WhatsApp onboarding. If not, **start it now**;
      it gates the review.
- [ ] Confirm the app's **Data Use Checkup** is current (Meta prompts annually; an overdue one
      blocks review).

**Realistic timeline:** Business Verification 1–5 business days if documents are clean, App Review
3–14 days, with a decent chance of one rejection round. Budget 3–4 weeks wall-clock and start it
in parallel with Phase 1 coding, not after.

---

## 6. Policy limits to design around (not configurable — just know them)

- **24-hour messaging window.** You may reply freely within 24h of the user's last message.
  After that: nothing, unless you have the HUMAN_AGENT tag (7 days).
- **No message templates.** Unlike WhatsApp there is no pre-approved template mechanism, so there
  is **no compliant way to run Instagram broadcasts**. Do not let this feature get promised to a
  customer.
- **Private replies:** one per comment, within 7 days of the comment.
- **Rate limits:** roughly 100 API calls per user per second for messaging, and conversation-level
  throttling on top. Should not bind for a CRM, but the send path should handle 429 with backoff.
- **IGSIDs are app-scoped.** The same Instagram user has a different ID in a different Meta app.
  If you ever migrate apps, every stored `ig_scoped_id` becomes worthless. Worth knowing before
  anyone proposes splitting the app.
- **Group threads and disappearing/vanish-mode messages are not delivered** by the API.

---

## 7. Pre-launch verification checklist

Once the code is built, walk this before declaring it done:

- [ ] Webhook subscription shows **Active** in the Dashboard with all fields subscribed
- [ ] Send a test DM from a non-tester account (post-approval) → appears in the inbox
- [ ] Reply from the inbox → arrives in Instagram
- [ ] Reply from the **native Instagram app** → appears in the inbox exactly **once**
      (this is the echo-dedupe check)
- [ ] React to a message from Instagram → reaction shows in the inbox; un-react removes it
- [ ] Reply to a story → arrives with the story context attached
- [ ] Wait past 24h on a test thread → composer blocks with a clear explanation
- [ ] Comment on a post → appears in the Comments view; public reply and private reply both work
- [ ] Force a token refresh (manually age `token_expires_at`) → job refreshes cleanly
- [ ] Revoke access from Instagram (*Settings → Apps and websites → Remove*) → app shows
      disconnected and prompts reconnect rather than erroring in a loop
