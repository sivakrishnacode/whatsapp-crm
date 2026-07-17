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
    // NEST_API_URL always wins (docker-compose sets it to http://api:8001);
    // the /.dockerenv probe only covers a container started without it.
    const isDocker =
      existsSync("/.dockerenv") || process.env.DOCKERIZED === "true";
    const nestApiUrl =
      process.env.NEST_API_URL ||
      (isDocker ? "http://api:8001" : "http://localhost:8001");
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
      ],
      afterFiles: [],
      fallback: [],
    };
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
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
