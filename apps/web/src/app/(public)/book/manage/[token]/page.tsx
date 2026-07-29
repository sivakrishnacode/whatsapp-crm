import type { Metadata } from 'next';

import { ManageBooking } from '@/components/forms/manage-booking';

/**
 * Reschedule or cancel, from the link in a confirmation.
 *
 * WHY IT LIVES UNDER `/book/` AND NOT `/appointments/<token>`
 *   `/appointments` is (or was) an authenticated dashboard route. The
 *   middleware decides what is public by path prefix, so an
 *   `/appointments/` public prefix would ALSO have matched
 *   `/appointments/types` and silently dropped the auth check on a dashboard
 *   page. Public and authenticated surfaces must not share a prefix — putting
 *   this under the already-public `/book/` keeps that impossible rather than
 *   merely avoided.
 *
 * `noindex` matters more here than anywhere else in the app: the URL IS the
 * credential, so a crawled and cached link is a leaked booking.
 */
export const metadata: Metadata = {
  title: 'Your booking',
  robots: { index: false, follow: false, nocache: true },
};

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="min-h-screen bg-slate-50 py-8 text-slate-900 transition-colors md:py-16 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-lg px-4">
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card px-6 py-8 text-card-foreground shadow-xl shadow-slate-900/5 sm:px-8 dark:shadow-none">
          <ManageBooking token={token} />
        </div>
        <p className="mt-8 text-center text-xs font-medium text-muted-foreground/70">
          Powered by{' '}
          <span className="font-semibold text-foreground/80">Converse360</span>
        </p>
      </div>
    </div>
  );
}
