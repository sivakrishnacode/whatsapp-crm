import type { Metadata } from 'next';
import Link from 'next/link';

import { PlanForm } from '@/components/plans/plan-form';
import { Badge, Pill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { StatRow, StatTile } from '@/components/ui/stat';
import { requireAdmin } from '@/lib/auth';
import { currency } from '@/lib/env';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { listPlans } from '@/lib/queries/plans';

export const metadata: Metadata = {
  title: 'Plans & pricing · Converse360 Admin',
};

export default async function PlansPage() {
  await requireAdmin();
  const plans = await listPlans();
  const currencyCode = currency();

  const totalMrr = plans.reduce((sum, plan) => sum + plan.mrr, 0);
  const totalActive = plans.reduce((sum, plan) => sum + plan.active, 0);
  const offered = plans.filter((plan) => plan.isActive).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-ink text-xl font-semibold">Plans &amp; pricing</h1>
        <p className="text-muted mt-1 text-sm">
          The subscription amounts themselves. Everything else in this panel is
          priced from here.
        </p>
      </header>

      <StatRow>
        <StatTile
          label="Plans"
          value={formatNumber(plans.length)}
          context={`${offered} offered to new signups`}
        />
        <StatTile
          label="Active subscriptions"
          value={formatNumber(totalActive)}
          context="across all plans"
        />
        <StatTile
          label="Recurring revenue"
          value={formatMoney(totalMrr)}
          context="monthly, at the prices below"
        />
        <StatTile
          label="Currency"
          value={currencyCode}
          context="set by ADMIN_CURRENCY; the plan table stores bare numbers"
        />
      </StatRow>

      {plans.map((plan) => (
        <Card key={plan.id}>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {plan.displayName}
                <Badge tone="outline">{plan.name}</Badge>
                {plan.isActive ? null : <Pill>Not offered</Pill>}
              </span>
            }
            description={plan.description ?? undefined}
            action={
              <Link
                href={`/subscribers?plan=${encodeURIComponent(plan.name)}`}
                className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
              >
                View subscribers
              </Link>
            }
          />

          <CardBody className="space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-muted text-xs">Monthly</p>
                <p className="text-ink tabular mt-0.5 font-semibold">
                  {formatMoney(plan.priceMonthly)}
                </p>
              </div>
              <div>
                <p className="text-muted text-xs">Yearly</p>
                <p className="text-ink tabular mt-0.5 font-semibold">
                  {formatMoney(plan.priceYearly)}
                </p>
                {plan.priceMonthly > 0 && plan.priceYearly > 0 ? (
                  <p className="text-muted mt-0.5 text-xs">
                    {formatMoney(plan.priceYearly / 12)}/mo effective
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-muted text-xs">Subscriptions</p>
                <p className="text-ink tabular mt-0.5 font-semibold">
                  {formatNumber(plan.active)} active
                </p>
                <p className="text-muted mt-0.5 text-xs">
                  {formatNumber(plan.subscribers)} total
                  {plan.trial > 0
                    ? `, ${formatNumber(plan.trial)} on trial`
                    : ''}
                </p>
              </div>
              <div>
                <p className="text-muted text-xs">Contributes</p>
                <p className="text-ink tabular mt-0.5 font-semibold">
                  {formatMoney(plan.mrr)}
                </p>
                <p className="text-muted mt-0.5 text-xs">
                  {totalMrr > 0
                    ? `${((plan.mrr / totalMrr) * 100).toFixed(0)}% of MRR`
                    : 'no revenue yet'}
                </p>
              </div>
            </div>

            <details className="border-line border-t pt-4">
              <summary className="text-ink-2 hover:text-ink cursor-pointer text-sm font-medium">
                Edit {plan.displayName}
              </summary>
              <div className="mt-5">
                <PlanForm
                  planId={plan.id}
                  displayName={plan.displayName}
                  description={plan.description}
                  priceMonthly={plan.priceMonthly}
                  priceYearly={plan.priceYearly}
                  trialDays={plan.trialDays}
                  maxContacts={plan.maxContacts}
                  maxMessagesMonthly={plan.maxMessagesMonthly}
                  maxBroadcastsMonthly={plan.maxBroadcastsMonthly}
                  maxFlows={plan.maxFlows}
                  maxTeamMembers={plan.maxTeamMembers}
                  maxStorageMb={plan.maxStorageMb}
                  isActive={Boolean(plan.isActive)}
                  activeSubscribers={plan.active}
                  currencyCode={currencyCode}
                />

                <dl className="text-muted border-line mt-6 grid gap-2 border-t pt-4 text-xs sm:grid-cols-3">
                  <div>
                    <dt>Razorpay plan id</dt>
                    <dd className="text-ink-2 break-all">
                      {plan.razorpayPlanId ?? 'not set'}
                    </dd>
                  </div>
                  <div>
                    <dt>Stripe price (monthly)</dt>
                    <dd className="text-ink-2 break-all">
                      {plan.stripePriceIdMonthly ?? 'not set'}
                    </dd>
                  </div>
                  <div>
                    <dt>Stripe price (yearly)</dt>
                    <dd className="text-ink-2 break-all">
                      {plan.stripePriceIdYearly ?? 'not set'}
                    </dd>
                  </div>
                </dl>
                <p className="text-muted mt-2 text-xs leading-relaxed">
                  Gateway ids are read-only here on purpose: the price a
                  customer is charged by Stripe or Razorpay lives at the
                  gateway, and repointing a plan at a different one from an
                  admin form is how someone ends up billed an amount nobody
                  chose. Change those in the gateway dashboard, then mirror the
                  number above.
                </p>
                <p className="text-muted mt-2 text-xs">
                  Last changed {formatDate(plan.updatedAt)}.
                </p>
              </div>
            </details>
          </CardBody>
        </Card>
      ))}

      <DerivedNote>
        <code className="text-ink-2">subscription_plans</code> has no currency
        column, so all prices are assumed to be in {currencyCode}. If you ever
        sell in a second currency, that needs a schema change rather than a
        second set of plans.
      </DerivedNote>
    </div>
  );
}
