import type { Metadata } from 'next';

/**
 * Public data-deletion status page.
 *
 * Meta links here from the confirmation it shows a user after they request
 * deletion of their data (see `AdsPrivacyController.dataDeletion`). It sits
 * at the app root rather than under `/ads/*` on purpose: those routes are
 * inside the dashboard group behind an auth gate and the Ads Manager
 * feature flag, and a page shown to someone who has just revoked access
 * must not ask them to sign in to the product they have left.
 *
 * It deliberately does not look the code up. Confirming whether a given
 * code ever existed would make this an oracle for "did this Facebook user
 * use this product", which is precisely the disclosure a deletion flow
 * should avoid. The code is echoed back only so the person can see they
 * are looking at the right request.
 */
export const metadata: Metadata = {
  title: 'Ad account data deletion',
  robots: { index: false, follow: false },
};

export default async function AdsDataDeletionPage({
  searchParams,
}: {
  // Async in Next 16 — see AGENTS.md.
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Ad account data deletion
      </h1>

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Any Meta ad-account connection associated with this request has been
        deleted, together with the access tokens that were stored for it. No
        further ads can be created or read on your behalf.
      </p>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Advertising records that belong to the business — which campaigns ran
        and what they spent — are kept, because they are the company&apos;s own
        financial history rather than personal data. Custom audiences that were
        uploaded to Meta are removed by Meta as part of the same request.
      </p>

      {code ? (
        <dl className="mt-6 rounded-xl border border-border bg-card p-4">
          <dt className="text-xs font-medium text-muted-foreground">
            Confirmation code
          </dt>
          <dd className="mt-1 font-mono text-sm text-foreground">{code}</dd>
        </dl>
      ) : null}

      <p className="mt-6 text-xs text-muted-foreground">
        If you believe data is still being held, contact support and quote the
        confirmation code above.
      </p>
    </main>
  );
}
