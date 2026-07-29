# Deploying converse360.in

Three containers, three loopback ports. **You own the reverse proxy and TLS** —
nothing in this repo touches nginx.

| Hostname | Proxy to | Container | What it serves |
|---|---|---|---|
| `converse360.in` | `127.0.0.1:3032` | `wacrm-site` | Marketing site (static) |
| `app.converse360.in` | `127.0.0.1:3031` | `wacrm-web` | Dashboard, hosted forms, booking pages, chat widget |
| `api.converse360.in` | `127.0.0.1:8001` | `wacrm-api` | Webhooks, OAuth callbacks, `v1` partner API |

Redis has no published port — it is reached only over the compose network.

```bash
docker compose up -d --build
ss -tlnp | grep -E '3031|3032|8001'
# want 127.0.0.1 on all three. If you see 0.0.0.0, the loopback binds in
# docker-compose.yml were reverted — see the comment on the api `ports:` entry.
```

---

## How traffic actually flows

The thing that surprises people: **the browser almost never talks to
`api.converse360.in`.**

```
browser ──> app.converse360.in/api/*  ──(Next rewrite)──> api:8001
                                          container-to-container

Meta / Stripe / Razorpay ──> api.converse360.in/whatsapp/webhook ──> api:8001
```

Everything the dashboard and the widget do goes through the app host, because
Next.js rewrites `/api/*` to the API container internally. That is a same-origin
hop, so **CORS never enters the picture** — including for the widget, whose
iframe is itself served from `app.converse360.in`.

`api.converse360.in` exists only for callers we don't control. See
[WEBHOOKS.md](WEBHOOKS.md).

---

## Three things your proxy must get right

Everything else is a plain `proxy_pass`. These three are the ones that break in
production only, and each fails in a way that doesn't point at the cause.

### 1. Don't buffer the widget's SSE stream

`app.converse360.in/api/public/web/stream` is an event stream. nginx buffers
proxied bodies by default, so events sit in the buffer until it fills — chat
works perfectly on localhost and is **minutes delayed** behind the proxy, with
nothing in any log.

The API sends `X-Accel-Buffering: no`, which nginx honours, so you may get away
with nothing. Being explicit is cheaper than diagnosing it:

```nginx
location /api/public/web/stream {
    proxy_pass http://127.0.0.1:3031;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;   # API heartbeats every 25s; default 60s is tight
}
```

### 2. Do NOT add `X-Frame-Options` on the app host

The widget **must** be framable on customers' websites; the dashboard must not.
`next.config.ts` already encodes exactly that split — `DENY` +
`frame-ancestors 'none'` everywhere except a carve-out for `/widget/*`.

A host-wide `add_header X-Frame-Options DENY` in your proxy overrides that
carve-out and the widget renders as a **blank box** — in production only, on
customer domains only, because nothing frames it locally. This is the single most
likely way this feature ships broken.

Verify:

```bash
curl -sI https://app.converse360.in/widget/v1/frame | grep -i x-frame-options   # want NOTHING
curl -sI https://app.converse360.in/login           | grep -i x-frame-options   # want DENY
```

### 3. Raise `client_max_body_size` on the app host

Default 1 MB silently 413s every attachment. The widget posts files as base64 in
a JSON body (no multipart parser on a public endpoint), and base64 inflates by
~33%: the API's caps are 20 MB chat / 10 MB form uploads, so the largest
legitimate body is ~27 MB encoded.

```nginx
client_max_body_size 32m;   # app host
client_max_body_size 12m;   # api host — no browser uploads here
```

Also pass `X-Forwarded-For` through on both hosts. The API hashes it for
rate-limit bucketing; without it every visitor on the internet shares one bucket.
It is never used for authorisation.

> **Optional hardening.** `api.converse360.in` mounts ~35 controllers but only
> needs ~10 paths public — everything else is reached via the app host. If you
> want to allowlist rather than blanket-proxy, [WEBHOOKS.md](WEBHOOKS.md) is the
> exact list, with `location / { return 404; }` as the default.

---

## Environment

Copy the domain-dependent values from these into your existing env files. Leave
every secret alone.

- [`env/api.env.production`](env/api.env.production) → `apps/api/.env`
- [`env/web.env.production`](env/web.env.production) → `apps/web/.env.local`

Then rebuild — **not restart**:

```bash
docker compose up -d --build
```

`NEXT_PUBLIC_*` values are baked into the JS bundle by `next build`, and the
`/api/*` rewrite target is baked into `routes-manifest.json`. A plain
`docker compose restart web` silently keeps the old values, which presents as
"I changed the env and nothing happened".

### The two traps in there

**`NEXT_PUBLIC_SITE_URL` must be `https://app.converse360.in`, not the marketing
domain.** Despite the name it is the base for team invite links
(`/join/<token>`) and the fallback origin for the WhatsApp webhook URL. Point it
at `converse360.in` and every invitation you send lands on the static site.

**Don't set `NEST_API_URL` in the env file.** docker-compose injects
`http://api:8001`, which keeps the rewrite and all server-side rendering inside
the compose network. Setting it to the public API URL routes internal calls out
to the internet and back — and then fails anyway if you allowlist the api host.

---

## Third-party reconfiguration

**[WEBHOOKS.md](WEBHOOKS.md)** — every URL Meta, Instagram, Facebook Lead Ads,
Razorpay, Stripe and Supabase need, with the exact events to subscribe and the
verification curls.

Two things from it worth knowing before you start:

- **WhatsApp's verify token is not an env var.** It is per-account, set in the
  dashboard, stored encrypted in `whatsapp_config.verify_token`. So changing
  `ENCRYPTION_KEY` breaks every stored WhatsApp token at once.
- **The widget's domain allowlist is empty by default and empty denies
  everything.** Add `converse360.in` under Channels → Web → Channel Settings or
  the widget won't load on your own site.

---

## Verify

```bash
# Site
curl -sI https://converse360.in | head -3

# App
curl -sI https://app.converse360.in/login | head -3

# Widget framing — the check that catches the most likely breakage
curl -sI https://app.converse360.in/widget/v1/frame | grep -iE 'x-frame|content-security'
#   want: NO x-frame-options; a CSP WITHOUT frame-ancestors 'none'

# Loader reachable, and not cached forever (customers paste this URL once
# and never touch it again)
curl -sI https://app.converse360.in/widget/v1/loader.js | grep -iE 'content-type|cache-control'

# API
curl -s https://api.converse360.in/health

# SSE responds promptly rather than hanging. 401/403 for bogus credentials is
# the CORRECT answer — what you're checking is that it answers at all.
curl -N -s "https://app.converse360.in/api/public/web/stream?widget_key=x&session=y" | head -3
```

---

## Still to do before this serves real traffic

- **Migrations 053–055 have not been applied to any database.** They are written
  and idempotent and `prisma validate` passes, but no schema has changed. Run
  them with `scripts/run-migration.sh` against Supabase — the web channel, forms
  and bookings all fail at the first query without them.
- **Migration 055 needs `btree_gist`.** It issues `CREATE EXTENSION IF NOT
  EXISTS btree_gist`. If that fails for lack of privilege, the double-booking
  constraint is not created and **nothing else reports a problem** — bookings
  become racy. Confirm:
  `select extname from pg_extension where extname = 'btree_gist';`
- **Redis runs with persistence off** (`--save '' --appendonly no`). A restart
  drops queued broadcasts, scheduled campaigns and pending automation waits.
  Fine if understood; not fine by accident.
