import type { NextConfig } from 'next';

/**
 * Baseline hardening. All straight blocks — nothing here is report-only, because
 * this panel serves no third-party content, embeds nothing, and needs no device
 * permissions, so there is no legitimate traffic for these to break.
 *
 * `frame-ancestors 'none'` plus X-Frame-Options is the one that matters most:
 * every mutation here is a Server Action reachable by POST, and a clickjacked
 * admin session can change what customers are billed.
 */
const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next injects inline bootstrap and RSC payload scripts.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  // Belt and braces alongside the `robots` metadata in app/layout.tsx.
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
