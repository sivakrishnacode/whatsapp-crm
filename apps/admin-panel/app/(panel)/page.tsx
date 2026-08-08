import type { Metadata } from 'next';
import Link from 'next/link';

import { BarList } from '@/components/chart/bar-list';
import { SubscriberMiniTable } from '@/components/subscriber/mini-table';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { HeroStat, StatRow, StatTile } from '@/components/ui/stat';
import { requireAdmin } from '@/lib/auth';
import {
  formatCredits,
  formatMinor,
  formatMoney,
  formatNumber,
} from '@/lib/format';
import { creditTotals } from '@/lib/queries/credits';
import { getOverview } from '@/lib/queries/overview';

export const metadata: Metadata = { title: 'Overview · Converse360 Admin' };

export default async function OverviewPage() {
  await requireAdmin();

  // Credits are fetched alongside rather than folded into `getOverview()`:
  // subscription revenue is derived from plan prices and credit revenue is
  // collected money, and keeping the two queries apart keeps that distinction
  // legible in the code as well as on the page.
  const [{ subscriptions, tenants, plans, trials, renewals, recent }, credits] =
    await Promise.all([getOverview(), creditTotals()]);

  const arr = subscriptions.mrr * 12;
  const arpa =
    subscriptions.paying > 0 ? subscriptions.mrr / subscriptions.paying : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-ink text-xl font-semibold">Overview</h1>
        <p className="text-muted mt-1 text-sm">
          Where the subscriber base and its recurring revenue stand right now.
        </p>
      </header>

      {/* The one number the dashboard leads with, with the figures that qualify
       * it immediately beside it rather than buried in a tile row. */}
      <Card>
        <CardBody className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center">
          <HeroStat
            label="Monthly recurring revenue"
            value={formatMoney(subscriptions.mrr)}
            context={
              <>
                {formatNumber(subscriptions.paying)} paying subscription
                {subscriptions.paying === 1 ? '' : 's'} · {formatMoney(arpa)}{' '}
                average · {formatMoney(arr)} annualised
              </>
            }
          />

          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-muted text-xs">At risk (past due)</dt>
              <dd className="text-ink mt-1 flex items-center gap-2 font-semibold">
                {subscriptions.pastDue > 0 ? (
                  <span
                    aria-hidden
                    className="bg-warning size-2 rounded-full"
                  />
                ) : null}
                {formatMoney(subscriptions.atRiskMrr)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(subscriptions.pastDue)} subscription
                {subscriptions.pastDue === 1 ? '' : 's'}
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">Trial pipeline</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatMoney(subscriptions.trialMrr)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(subscriptions.trial)} on trial, worth this per
                month if they convert
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">Due in the next 30 days</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatMoney(subscriptions.renewalsDue30Amount)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                across {formatNumber(subscriptions.renewalsDue30)} renewal
                {subscriptions.renewalsDue30 === 1 ? '' : 's'}
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">This month</dt>
              <dd className="text-ink mt-1 font-semibold">
                +{formatNumber(subscriptions.newThisMonth)} / −
                {formatNumber(subscriptions.churnedThisMonth)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">started / ended</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <StatRow>
        <StatTile
          label="Active subscriptions"
          value={formatNumber(subscriptions.active)}
          context={`${formatNumber(subscriptions.subscriptions)} total, all statuses`}
          tone="good"
        />
        <StatTile
          label="On trial"
          value={formatNumber(subscriptions.trial)}
          context={`${formatNumber(subscriptions.trialsEndingSoon)} ending within 7 days`}
          tone={subscriptions.trialsEndingSoon > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Accounts"
          value={formatNumber(tenants.accounts)}
          context={`${formatNumber(tenants.newAccountsThisMonth)} created this month`}
        />
        <StatTile
          label="Users"
          value={formatNumber(tenants.users)}
          context={`${formatNumber(tenants.profiles)} with an account profile`}
        />
      </StatRow>

      {/* AI credits sit apart from the revenue above because they are a
        * different kind of number: a top-up is money we actually collected,
        * and an outstanding balance is inference we still owe. Neither belongs
        * in MRR. */}
      <Card>
        <CardHeader
          title="AI credits"
          description="Workspaces running the agent on our Gemini key spend credits; the ones on their own provider key spend nothing."
          action={
            <Link
              href="/credits"
              className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
            >
              Manage credits
            </Link>
          }
        />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted text-xs">Credits outstanding</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatCredits(credits.outstanding)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                across {formatNumber(credits.wallets)} wallets
              </dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Consumed, 30 days</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatCredits(credits.consumed30d)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                on {formatNumber(credits.onPlatform)} workspaces using our key
              </dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Top-up revenue, this month</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatMinor(credits.topUpRevenueMinorThisMonth)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                collected, not derived — the only such figure here
              </dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Wallets empty</dt>
              <dd className="text-ink mt-1 flex items-center gap-2 font-semibold">
                {credits.walletsEmpty > 0 ? (
                  <span
                    aria-hidden
                    className="bg-warning size-2 rounded-full"
                  />
                ) : null}
                {formatNumber(credits.walletsEmpty)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(credits.walletsLow)} more running low
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader
            title="Recurring revenue by plan"
            description="Active subscriptions only, normalised to a monthly figure."
            action={
              <Link
                href="/plans"
                className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
              >
                Edit pricing
              </Link>
            }
          />
          <CardBody>
            <BarList
              rows={plans.map((plan) => ({
                label: plan.displayName,
                value: plan.mrr,
                valueLabel: formatMoney(plan.mrr),
                meta: `${plan.active} active${plan.trial > 0 ? `, ${plan.trial} trial` : ''}`,
              }))}
            />
            <DerivedNote>
              Priced from the plan table, not from payments — this database
              keeps no invoice or transaction record, so every amount here is
              &ldquo;what the current subscriptions are worth&rdquo;, not
              &ldquo;what was collected&rdquo;.
            </DerivedNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Trials ending soon"
            description="Soonest first. These convert, lapse, or need a nudge."
          />
          <SubscriberMiniTable
            rows={trials}
            dateLabel="Trial ends"
            dateOf={(row) => row.trialEndAt}
            amountLabel="Then pays"
            emptyMessage="No trials are running."
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Renewals due"
          description="Current periods ending in the next 30 days, and what each one bills."
          action={
            <Link
              href="/sales"
              className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
            >
              Full sales view
            </Link>
          }
        />
        <SubscriberMiniTable
          rows={renewals}
          dateLabel="Renews"
          dateOf={(row) => row.periodEnd}
          emptyMessage="Nothing renews in the next 30 days."
        />
      </Card>

      <Card>
        <CardHeader
          title="Recently started"
          description="The newest subscriptions, however they were created."
          action={
            <Link
              href="/subscribers"
              className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
            >
              All subscribers
            </Link>
          }
        />
        <SubscriberMiniTable
          rows={recent}
          dateLabel="Started"
          dateOf={(row) => row.subscribedAt}
          emptyMessage="No subscriptions yet."
          relativeDate={false}
        />
      </Card>
    </div>
  );
}
