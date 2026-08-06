import { Suspense } from 'react';

import { AdWizard } from '@/components/ads/wizard/ad-wizard';

/**
 * Ads Manager → Create Ad. The four-step wizard.
 *
 * The Suspense boundary is required, not decorative: the wizard keeps the
 * ad type and step in the query string (`useWizardPersistence`), and Next
 * needs a boundary around any component that reads `useSearchParams`.
 */
export default function AdsCreatePage() {
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Create new ad
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Runs on Facebook and Instagram, from your own Meta ad account.
      </p>
      <div className="mt-6">
        <Suspense
          fallback={
            <div className="h-96 animate-pulse rounded-xl border border-border bg-card/40" />
          }
        >
          <AdWizard />
        </Suspense>
      </div>
    </div>
  );
}
