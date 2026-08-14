# apps/site — update drop-in

Copy every file in this folder into `apps/site/`, overwriting:

    index.html      features.html   solutions.html
    pricing.html    contact.html
    privacy.html    terms.html
    Dockerfile      robots.txt      sitemap.xml

Then: `docker compose up -d --build site`

`privacy.html` and `terms.html` are byte-for-byte the copies already in
`apps/site/` — included so this folder is a complete web root, not because they
changed. Overwriting them with these is a no-op.

## What changed

- Four new pages (features, solutions, pricing, contact) joined the homepage.
- `Dockerfile` gained COPY lines for the new pages plus `sitemap.xml`, and the
  cache-control block became a regex over all seven HTML routes.
- `robots.txt` now advertises the sitemap.
- `privacy.html` / `terms.html` carried over unchanged.
- Internal links use extensionless paths (`/pricing`, `/contact`, `/privacy`),
  resolved by the existing `try_files $uri $uri.html` rule.

## ⚠ Read before deploying: crawlability

The previous `index.html` was a hand-written static page precisely because the
design-tool bundle replaces `document.documentElement` at runtime, so Google's
renderer never sees a static shell. **This update replaces that page with a
bundle**, so the homepage loses its static crawlable body copy.

Each page does ship correct `<title>`, meta description, canonical and Open
Graph tags in the shell, so link previews and titles are intact — but body copy
is JS-rendered.

Two ways forward, both fine:

1. Deploy as-is and accept JS-rendered content (Google does render JS, just
   slower and less reliably).
2. Keep the old static `index.html` at `/` and mount this design at `/home` or
   similar. Say the word and I can also hand-write a static, crawlable version
   of the new homepage that mirrors the design — that gets you both.
