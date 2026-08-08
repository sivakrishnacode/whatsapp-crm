# Webhooks & callbacks to reconfigure

Every URL a third party calls, verified against the controllers in
`apps/api/src`. All of them live on **`api.converse360.in`** — they are called
by servers we don't control, so they cannot go through the app's `/api/*` proxy.

Until these are updated, **inbound messages just stop arriving.** There is no
error anywhere in this app, because the webhook never reaches it.

---

## Meta — WhatsApp Cloud API

| Field | Value |
|---|---|
| Callback URL | `https://api.converse360.in/whatsapp/webhook` |
| Verify token | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `apps/api/.env`. See below. |

*Where:* Meta App Dashboard → WhatsApp → Configuration → Webhook → Edit.

**Subscribe these fields** (the app parses all of them; a missing one fails
silently — the feature just never fires):

- `messages` — inbound messages **and** delivery/read statuses. Without it
  nothing works at all.
- `message_template_status_update` — template approvals/rejections.
- `business_capability_update` — messaging tier and quality-rating changes.

> **Two tokens are accepted, and you want the first one.**
>
> `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is the **app-level** token, checked first.
> Under Tech Provider / Embedded Signup the webhook is configured once at app
> level and we subscribe our app to each customer's WABA afterwards, so this is
> the value that belongs in the dashboard field above. **Without it a fresh
> deployment deadlocks**: no connected accounts means no per-account token to
> match, so the handshake 403s, so Meta refuses to save the webhook, so no
> account can connect.
>
> The **per-account** fallback remains for the older bring-your-own-Meta-app
> path, where each customer set their own token in *Channels → WhatsApp →
> Channel Settings*. The handshake walks those accounts and matches against
> `whatsapp_config.verify_token`, which is encrypted at rest.
>
> Consequence of the fallback: **changing `ENCRYPTION_KEY` breaks every stored
> verify token and access token at once.** Keep it stable across deploys.

Handshake check — works on a completely fresh deployment:

```bash
curl -s "https://api.converse360.in/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_WEBHOOK_VERIFY_TOKEN&hub.challenge=ok123"
# -> ok123
```

---

## Meta — Instagram

| Field | Value |
|---|---|
| Webhook callback URL | `https://api.converse360.in/instagram/webhook` |
| Verify token | `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` in `apps/api/.env` |
| Valid OAuth Redirect URI | `https://api.converse360.in/instagram/connect/callback` |
| Deauthorize callback URL | `https://api.converse360.in/instagram/deauthorize` |
| Data Deletion Request URL | `https://api.converse360.in/instagram/data-deletion` |

*Where:* App Dashboard → Instagram → API setup with Instagram login →
2. Configure webhooks, and → 3. Set up Instagram business login → Business login
settings.

**Subscribe these fields.** A partial subscription is the difference between
DMs working and comments silently not — the dashboard's Channel Settings page
shows which are actually live:

`messages`, `messaging_postbacks`, `messaging_seen`, `message_reactions`,
`messaging_referral`, `comments`, `live_comments`, `mentions`

> The redirect URI must match `INSTAGRAM_REDIRECT_URI` **character for
> character** — a trailing slash or `http://` gets a generic "couldn't be
> validated" that says nothing about which part is wrong.

> Deauthorize and Data Deletion are **required to pass app review**. Nothing in
> this app ever calls them, so a misconfiguration shows up as a review rejection
> rather than a runtime error.
>
> Both verify Meta's `signed_request` HMAC using **`INSTAGRAM_APP_SECRET`** and
> then actually delete the connection and its encrypted token. If that env var
> is unset they return 500 rather than accepting the request — failing closed,
> because honouring an unverified deletion request would let anyone delete any
> workspace's Instagram connection. The status URL Meta shows the user is the
> **public** `/instagram-data-deletion` page on the web app, not anything behind
> the dashboard's auth gate.

```bash
curl -s "https://api.converse360.in/instagram/webhook?hub.mode=subscribe&hub.verify_token=$INSTAGRAM_WEBHOOK_VERIFY_TOKEN&hub.challenge=ok123"
# -> ok123
```

---

## Meta — Facebook Lead Ads

| Field | Value |
|---|---|
| Callback URL | `https://api.converse360.in/webhooks/facebook-leads` |
| Verify token | `FACEBOOK_WEBHOOK_VERIFY_TOKEN` in `apps/api/.env` |
| Field to subscribe | `leadgen` |

*Where:* App Dashboard → Webhooks → Page → `leadgen`.

Separate from the Instagram/WhatsApp webhook because it is a **Page**
subscription, not an Instagram or WABA one. Also note this integration is pinned
to Graph `v20.0` while the WhatsApp module uses `v21.0` — intentionally distinct
surfaces.

---

## Razorpay

| Field | Value |
|---|---|
| Webhook URL | `https://api.converse360.in/webhooks/razorpay` |
| Secret | `RAZORPAY_WEBHOOK_SECRET` in `apps/api/.env` |

*Where:* Razorpay Dashboard → Settings → Webhooks → Add New Webhook.

**Events** — exactly what `subscription-webhooks.controller.ts` switches on.
Anything else is accepted and ignored; anything *missing* here is a feature that
silently never fires:

`order.paid`, `payment.authorized`, `payment.captured`,
`subscription.activated`, `subscription.authenticated`,
`subscription.updated`, `subscription.cancelled`

> **Not** `/subscription/razorpay/*`. Despite the name, that controller only
> holds `create-order` and `confirm-payment`, which the **dashboard** calls from
> the browser — those go through `app.converse360.in/api/*`. The actual webhook
> is `POST /webhooks/razorpay`.

---

## Stripe

| Field | Value |
|---|---|
| Endpoint URL | `https://api.converse360.in/webhooks/stripe` |
| Signing secret | `STRIPE_WEBHOOK_SECRET` in `apps/api/.env` (starts `whsec_`) |

*Where:* Stripe Dashboard → Developers → Webhooks → Add endpoint.

**Events** — exactly what the handler switches on:

`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_failed`

(No `invoice.payment_succeeded` — renewals are picked up from
`customer.subscription.updated`.)

> Same naming trap as Razorpay: `/subscription/stripe/create-checkout-session`
> is browser-called and belongs on the app host. The webhook is
> `POST /webhooks/stripe`.

> Stripe signs the **raw body**. If your proxy re-encodes, re-chunks or adds a
> charset to it, signature verification fails and every event is rejected — which
> presents as "payments silently stopped working". Pass the body through
> untouched (`proxy_request_buffering off` on nginx).

---

## Supabase

Not a webhook, but it has a redirect allowlist that will silently break auth:

*Where:* Supabase Dashboard → Authentication → URL Configuration.

| Field | Value |
|---|---|
| Site URL | `https://app.converse360.in` |
| Redirect URLs | `https://app.converse360.in/**` |

Password reset and email-confirmation links bounce off this list. Miss it and
the emails send fine but every link lands on an error page.

---

## Your own widget

Not third-party, but it fails closed and so looks broken until done.

*Where:* Channels → Web → Channel Settings → Allowed domains.

Add **`converse360.in`** so the widget works on your own marketing site.

The origin that matters is **the page doing the embedding**, not where the
loader script came from — so a customer embedding on `shop.example.com` lists
`shop.example.com`, even though the script is served from
`app.converse360.in`. Subdomains are not implicit; each host is listed
separately (a `*.example.com` rule would admit any subdomain an attacker can get
onto).

An **empty allowlist denies everything**. That is deliberate — an open default
would make every new account an anonymous-conversation relay — but it does mean
a fresh account's widget loads nowhere until a domain is added.

---

## Quick verification

```bash
# The API host answers, and the health check is public
curl -s https://api.converse360.in/health

# Webhook GET handshakes reachable (403/challenge, not 404/502)
curl -so /dev/null -w 'whatsapp   %{http_code}\n' "https://api.converse360.in/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"
curl -so /dev/null -w 'instagram  %{http_code}\n' "https://api.converse360.in/instagram/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"
curl -so /dev/null -w 'fb-leads   %{http_code}\n' "https://api.converse360.in/webhooks/facebook-leads?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"

# Payment webhooks reachable (405/400 is fine — they only accept POST with a
# valid signature; 404 means the route is not being proxied)
curl -so /dev/null -w 'razorpay   %{http_code}\n' -X POST https://api.converse360.in/webhooks/razorpay
curl -so /dev/null -w 'stripe     %{http_code}\n' -X POST https://api.converse360.in/webhooks/stripe

# OAuth + review callbacks
curl -so /dev/null -w 'ig-cb      %{http_code}\n' https://api.converse360.in/instagram/connect/callback
curl -so /dev/null -w 'ig-deauth  %{http_code}\n' -X POST https://api.converse360.in/instagram/deauthorize
curl -so /dev/null -w 'ig-del     %{http_code}\n' -X POST https://api.converse360.in/instagram/data-deletion
```

Anything returning **404** is not reaching the API — a proxy problem, not an app
problem. **502** means the container is down.
