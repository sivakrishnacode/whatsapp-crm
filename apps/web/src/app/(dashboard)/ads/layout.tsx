import { notFound } from 'next/navigation';

import { ADS_ENABLED } from '@/lib/nav/ads';

/**
 * Gate for every `/ads/*` route.
 *
 * A layout rather than a check repeated in each page: one place to
 * forget is better than seven, and a new page under `/ads` inherits the
 * gate without having to remember it.
 *
 * This is NOT the security boundary — `AdsEnabledGuard` 404s every
 * `/ads/*` endpoint on the API independently. This only stops a
 * deep-linked URL rendering a shell whose every request would fail while
 * the feature is unreleased.
 */
export default function AdsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!ADS_ENABLED) notFound();
  return <>{children}</>;
}
