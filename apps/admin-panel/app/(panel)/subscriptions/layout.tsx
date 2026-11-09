import type { ReactNode } from 'react';

import { PageHeader } from '@/components/ui/page';
import { RouteTabs } from '@/components/ui/route-tabs';
import { requireCapability } from '@/lib/auth';
import { currency } from '@/lib/env';

/**
 * Subscriptions & Renewals — one section, three views of the same rows:
 * every subscription, what renews soon (C360-030), and what the base is
 * worth. Each tab is its own route, so a link to the renewal watchlist
 * survives a refresh and back/forward.
 *
 * The capability check here protects the section render; every page checks
 * again, because a layout check protects nothing else.
 */
export default async function SubscriptionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireCapability('billing.read');

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader
          eyebrow="Revenue"
          title="Subscriptions & Renewals"
          description={`What every workspace is on, what renews next and what the base is worth. Amounts in ${currency()}, derived from plan prices — this database records subscriptions, not payments.`}
        />
        <RouteTabs
          label="Subscriptions views"
          tabs={[
            { href: '/subscriptions', label: 'All subscriptions', exact: true },
            { href: '/subscriptions/renewals', label: 'Renewals watchlist' },
            { href: '/subscriptions/revenue', label: 'Revenue' },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
