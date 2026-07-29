import { existsSync } from "node:fs";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     baseline OWASP hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — public, brief s-maxage + generous
   *     stale-while-revalidate. The edge serves instantly from cache
   *     for the first 5 min, then returns cached content while
   *     refreshing in the background for up to 24 h. A deploy's
   *     chunk-hash drift self-heals within ~5 min with no user-
   *     visible latency.
   *
   *   Note: dynamic dashboard routes (/inbox, /contacts, /pipelines,
   *   /broadcasts, etc.) are server-rendered per request — Next.js
   *   and Supabase auth already prevent them from being served
   *   from a shared cache. The s-maxage here is a ceiling; Next.js
   *   and auth middleware still set `private` / `no-store` for
   *   per-user responses.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  /**
   * Strangler-fig proxy to the NestJS backend (apps/api).
   *
   * Same-origin rewrite rather than a cross-origin fetch from the
   * browser: every existing `fetch('/api/...')` call keeps working
   * unchanged, CORS never enters the picture, and the existing
   * Cache-Control / security `headers()` rules below still apply
   * (they match on request path, independent of whether a local
   * route handler or an external rewrite destination resolves it).
   *
   * Phase 1 adds the first real migrated domain (Automations) — every
   * later phase adds one entry here as the corresponding
   * src/app/api/** folder is deleted.
   */
  async rewrites() {
    // Docker MUST win over NEST_API_URL here: rewrites are resolved at
    // BUILD time (routes-manifest.json), and the image build copies
    // .env.local (required for NEXT_PUBLIC_* client inlining) whose
    // NEST_API_URL=http://localhost:8001 would otherwise get baked in.
    // Dockerfile sets DOCKERIZED=true so the build takes this branch.
    const isDocker =
      existsSync("/.dockerenv") || process.env.DOCKERIZED === "true";
    const nestApiUrl = isDocker
      ? "http://api:8001"
      : process.env.NEST_API_URL || "http://localhost:8001";
    return {
      // `beforeFiles` so these take priority over the still-present
      // src/app/api/** route handlers they're replacing — Next's default
      // (a plain array = `afterFiles`) only applies a rewrite when no
      // filesystem route matches, which would let the old handlers keep
      // silently shadowing the new backend until their files are deleted.
      beforeFiles: [
        { source: "/api/_internal/nest-health", destination: `${nestApiUrl}/health` },
        { source: "/api/automations", destination: `${nestApiUrl}/automations` },
        { source: "/api/automations/:path*", destination: `${nestApiUrl}/automations/:path*` },
        { source: "/api/flows", destination: `${nestApiUrl}/flows` },
        { source: "/api/flows/:path*", destination: `${nestApiUrl}/flows/:path*` },
        { source: "/api/v1/:path*", destination: `${nestApiUrl}/v1/:path*` },
        { source: "/api/whatsapp/:path*", destination: `${nestApiUrl}/whatsapp/:path*` },
        // Dashboard-facing Instagram endpoints (config, send, comments).
        // NOT the webhook or the OAuth callback — Meta calls those on the
        // API's own public domain, so they never pass through here.
        { source: "/api/instagram/:path*", destination: `${nestApiUrl}/instagram/:path*` },
        // Web channel — dashboard-facing widget configuration.
        { source: "/api/web/:path*", destination: `${nestApiUrl}/web/:path*` },
        // The widget's own visitor-facing surface, called by anonymous
        // browsers on customers' websites. Same-origin through this proxy
        // so the widget iframe never makes a cross-origin request and CORS
        // stays out of the picture — the origin allowlist in
        // widget-key.guard is what actually gates access, not CORS.
        { source: "/api/public/:path*", destination: `${nestApiUrl}/public/:path*` },
        // Phase 5 Migrations
        { source: "/api/account", destination: `${nestApiUrl}/account` },
        { source: "/api/account/:path*", destination: `${nestApiUrl}/account/:path*` },
        { source: "/api/invitations/:path*", destination: `${nestApiUrl}/invitations/:path*` },
        { source: "/api/subscription", destination: `${nestApiUrl}/subscription` },
        { source: "/api/subscription/:path*", destination: `${nestApiUrl}/subscription/:path*` },
        { source: "/api/webhooks/:path*", destination: `${nestApiUrl}/webhooks/:path*` },
        { source: "/api/ecommerce/:path*", destination: `${nestApiUrl}/ecommerce/:path*` },
        { source: "/api/integrations/:path*", destination: `${nestApiUrl}/integrations/:path*` },
        { source: "/api/internal/:path*", destination: `${nestApiUrl}/internal/:path*` },
        { source: "/api/ai/:path*", destination: `${nestApiUrl}/ai/:path*` },
        { source: "/api/ctwa/:path*", destination: `${nestApiUrl}/ctwa/:path*` },
        { source: "/api/campaigns/:path*", destination: `${nestApiUrl}/campaigns/:path*` },
        // Phase 4 — Form builder
        { source: "/api/forms", destination: `${nestApiUrl}/forms` },
        { source: "/api/forms/:path*", destination: `${nestApiUrl}/forms/:path*` },
        // Phase 6 — Appointments
        // Booking lives under /api/forms and /api/public/forms: a booking IS
        // a form carrying a slot-picker field, so it needs no routes of its
        // own. There were /api/appointments* rewrites here pointing at Nest
        // controllers that never existed — every call 404'd.
        { source: "/api/bookings", destination: `${nestApiUrl}/bookings` },
        { source: "/api/bookings/:path*", destination: `${nestApiUrl}/bookings/:path*` },
      ],

      afterFiles: [],
      fallback: [],
    };
  },
  /**
   * Legacy flat routes → their channel-scoped homes.
   *
   * The dual-sidebar IA moved every WhatsApp-specific page under
   * `/channels/whatsapp/*`. These keep bookmarks, shared links and any
   * still-cached HTML working.
   *
   * `permanent: false` (307/308) on purpose: a permanent redirect gets
   * cached hard by browsers and the CDN, which would make a future
   * reshuffle of this IA very painful to undo. Flip to `true` once the
   * structure has settled.
   *
   * Query strings pass through automatically, so `/ecommerce?tab=orders`
   * lands on `/channels/whatsapp/commerce?tab=orders`. Note that
   * `redirects` run BEFORE proxy/middleware — the destinations must
   * therefore also be covered by `protectedPaths` in middleware.ts.
   */
  async redirects() {
    const moved: [string, string][] = [
      ["/broadcasts", "/channels/whatsapp/broadcasts"],
      ["/campaigns", "/channels/whatsapp/campaigns"],
      ["/templates", "/channels/whatsapp/templates"],
      ["/whatsapp-flows", "/channels/whatsapp/flows"],
      ["/ecommerce", "/channels/whatsapp/commerce"],
      ["/ctwa", "/channels/whatsapp/ctwa"],
    ];
    return moved.flatMap(([from, to]) => [
      { source: from, destination: to, permanent: false },
      // Nested paths too: /broadcasts/new, /broadcasts/<id>, /whatsapp-flows/<id>.
      { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: false },
    ]);
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        //
        // EXCLUDES /widget, /f, /book — see the next rules for why.
        source: "/:path((?!widget/|f/|book/).*)",
        headers: [...SECURITY_HEADERS],
      },
      {
        // Forms can be embedded in iframes on customer sites.
        // We apply the same baseline security headers but omit
        // X-Frame-Options and relax frame-ancestors in CSP.
        source: "/f/:path*",
        headers: SECURITY_HEADERS.filter(h => h.key !== "X-Frame-Options").map(h => 
          h.key === "Content-Security-Policy-Report-Only" 
            ? { ...h, value: h.value.replace("frame-ancestors 'none'", "frame-ancestors *") }
            : h
        ),
      },
      {
        // Booking pages can be embedded in iframes on customer sites.
        source: "/book/:path*",
        headers: SECURITY_HEADERS.filter(h => h.key !== "X-Frame-Options").map(h => 
          h.key === "Content-Security-Policy-Report-Only" 
            ? { ...h, value: h.value.replace("frame-ancestors 'none'", "frame-ancestors *") }
            : h
        ),
      },
      {
        /**
         * The widget is the ONE surface that must be framable.
         *
         * Every other route in this app is protected by
         * `X-Frame-Options: DENY` + `frame-ancestors 'none'`, which is
         * correct: an authenticated dashboard has no business being
         * embedded. But the widget's entire delivery mechanism is an
         * iframe on somebody else's website, so those two headers make it
         * render as a blank box — and only in production, only on a real
         * customer domain, because nothing frames it in local dev. This
         * is the single most likely way this feature ships broken.
         *
         * Next.js merges headers from every matching rule and cannot
         * *remove* one, so the rule above is negated-path-matched to skip
         * `/widget/` entirely, and this rule re-adds the subset that is
         * still safe here.
         *
         * `frame-ancestors *` rather than a per-account allowlist: this is
         * a static config evaluated at build time and has no access to
         * which origins a given account permits. The real enforcement is
         * server-side in `WidgetKeyGuard`, which checks the request
         * Origin against `web_config.allowed_origins` and refuses —
         * strictly stronger than a CSP the browser applies, since it also
         * covers non-browser callers. Framing the widget from a
         * disallowed origin therefore renders an error, not a chat.
         */
        source: "/widget/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // No Referer to third-party sites from inside the frame.
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Content-Security-Policy",
            // Enforced, not report-only, unlike the app-wide policy: this
            // is a small surface we fully control, so there is no legacy
            // to shake out first.
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              // Visitor attachments and agent avatars come from Supabase
              // public buckets; data: covers inline placeholder assets.
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: https://*.supabase.co",
              "font-src 'self' data:",
              // Same-origin only: the widget reaches the API through this
              // app's own /api/public/* rewrite, never cross-origin.
              "connect-src 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
