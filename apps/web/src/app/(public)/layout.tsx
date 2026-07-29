import type { Metadata } from 'next';

/**
 * The public surface: the widget frame, hosted forms, booking pages.
 *
 * Separate from `(dashboard)` because it must NOT carry the dashboard
 * shell — no sidebar, no `ChannelStatusProvider`, no auth context. Those
 * providers fetch account-scoped data, which for an anonymous visitor is
 * a burst of requests that all 401.
 *
 * No `globals.css` import and no `<html>`/`<body>`: the root
 * `src/app/layout.tsx` already owns both, and this group nests inside it.
 * A second stylesheet import here would duplicate the reset, and the
 * theme boot script in the root layout is what makes light/dark work in
 * the widget frame too.
 *
 * `noindex` on all of it. A hosted form or booking page is a tool for one
 * person who was given the link, not a landing page — indexing them puts
 * customers' forms in search results and makes their slugs enumerable.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
