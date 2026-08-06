import { Suspense } from 'react';

import { AdsSetup } from '@/components/ads/ads-setup';

/**
 * Ads Manager → Setup. Connect a Meta ad account and pick the assets
 * ads run against.
 *
 * The Suspense boundary is required, not decorative: `AdsSetup` reads
 * `useSearchParams` to report the `?ads_connected` / `?ads_error` the
 * OAuth callback redirects back with, and Next needs a boundary around
 * any component that does.
 */
export default function AdsSetupPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Ads Manager setup
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your Meta ad account to run Facebook and Instagram ads that
        land in WhatsApp. Ads run on your own ad account — Meta bills you
        directly.
      </p>
      <div className="mt-6">
        <Suspense
          fallback={
            <div className="h-64 animate-pulse rounded-xl border border-border bg-card/40" />
          }
        >
          <AdsSetup />
        </Suspense>
      </div>
    </div>
  );
}
