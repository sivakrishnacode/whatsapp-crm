import type { Metadata } from 'next';

/**
 * Public Instagram data-deletion status page.
 *
 * Meta links here from the confirmation it shows after someone requests
 * deletion of their data, or removes the app from their Instagram settings
 * (see `InstagramConnectController.dataDeletion`).
 *
 * It sits at the app root, NOT under `(dashboard)`, and that is the whole
 * point of the file: the previous status URL pointed at
 * `/settings/data-deletion`, which is inside the dashboard's auth gate — a
 * reviewer following it hit a login wall, and so would any real person who
 * had just revoked access to a product they have left. Mirrors
 * `ads-data-deletion/page.tsx` deliberately; the two should stay diffable.
 *
 * It does not look the code up. Confirming whether a given code ever
 * existed would make this an oracle for "did this Instagram account use
 * this product", which is precisely the disclosure a deletion flow should
 * avoid. The code is echoed back only so the person can see they are
 * looking at the right request.
 */
export const metadata: Metadata = {
  title: 'Instagram data deletion',
  robots: { index: false, follow: false },
};

export default async function InstagramDataDeletionPage({
  searchParams,
}: {
  // Async in Next 16 — see AGENTS.md.
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Instagram data deletion
      </h1>

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Any Instagram connection associated with this request has been deleted,
        together with the access token that was stored for it. We can no longer
        read or send messages, or read comments, on that Instagram account.
      </p>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Conversations and contact records already saved in a business&apos;s
        workspace belong to that business rather than to the connection, so they
        are not removed by this request. If you messaged a business and want
        your conversation deleted, contact that business — they control it — or
        write to us and we will help.
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
