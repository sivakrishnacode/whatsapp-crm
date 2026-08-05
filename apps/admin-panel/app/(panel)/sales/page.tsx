import type { Metadata } from 'next';

import { BarList } from '@/components/chart/bar-list';
import { MovementChart } from '@/components/chart/movement-chart';
import { SubscriberMiniTable } from '@/components/subscriber/mini-table';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { HeroStat, StatRow, StatTile } from '@/components/ui/stat';
import { requireAdmin } from '@/lib/auth';
import { formatMoney, formatMonth, formatNumber } from '@/lib/format';
import { getSalesReport } from '@/lib/queries/sales';

export const metadata: Metadata = { title: 'Sales · Converse360 Admin' };

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'Monthly billing',
  yearly: 'Yearly billing',
  none: 'No cycle (free)',
};

const METHOD_LABELS: Record<string, string> = {
  razorpay: 'Razorpay',
  stripe: 'Stripe',
  manual: 'Manual / assigned',
  unrecorded: 'Unrecorded',
};

export default async function SalesPage() {
  await requireAdmin();
  const { summary, byPlan, byCycle, byMethod, monthly, renewals, top } =
    await getSalesReport(12);

  const arr = summary.mrr * 12;
  const arpa =
    summary.payingSubscribers > 0 ? summary.mrr / summary.payingSubscribers : 0;
  const collectable = renewals.reduce((sum, bucket) => sum + bucket.amount, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-ink text-xl font-semibold">Sales</h1>
        <p className="text-muted mt-1 text-sm">
          What the subscription base is worth, where it comes from, and what is
          due to be collected.
        </p>
      </header>

      <Card>
        <CardBody className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
          <HeroStat
            label="Monthly recurring revenue"
            value={formatMoney(summary.mrr)}
            context={
              <>
                {formatMoney(arr)} annualised ·{' '}
                {formatNumber(summary.payingSubscribers)} paying ·{' '}
                {formatMoney(arpa)} each on average
              </>
            }
          />
          <p className="text-muted text-xs leading-relaxed">
            <strong className="text-ink-2 font-semibold">
              How this is calculated.
            </strong>{' '}
            This database records subscriptions, not payments — there is no
            invoice or transaction table anywhere in the schema. So every amount
            on this page is the plan price for each subscription&apos;s billing
            cycle, summed: exact for &ldquo;what the base is worth today&rdquo;
            and for &ldquo;what is due next&rdquo;, and silent about what was
            actually banked. Editing a plan price rewrites these figures, past
            months included. If you need real revenue history, that needs a
            payments ledger the app writes to on every successful charge.
          </p>
        </CardBody>
      </Card>

      <StatRow>
        <StatTile
          label="Annual run rate"
          value={formatMoney(arr)}
          context="MRR × 12, at today's prices"
        />
        <StatTile
          label="At risk"
          value={formatMoney(summary.atRiskMrr)}
          context="Past-due subscriptions, excluded from MRR"
          tone={summary.atRiskMrr > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Trial pipeline"
          value={formatMoney(summary.trialMrr)}
          context="Monthly value if every trial converts as-is"
        />
        <StatTile
          label="Due in 90 days"
          value={formatMoney(collectable)}
          context="Sum of the renewal buckets below"
        />
      </StatRow>

      <Card>
        <CardHeader
          title="Subscriptions started and ended"
          description="Last 12 months. Counts of subscriptions, not money — see the note on the hero figure."
        />
        <CardBody>
          <MovementChart
            points={monthly.map((row) => ({
              label: formatMonth(row.month),
              started: row.started,
              churned: row.churned,
              startedMrr: formatMoney(row.startedMrr),
            }))}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="By plan"
            description="Active subscriptions, monthly-normalised."
          />
          <CardBody>
            <BarList
              rows={byPlan.map((row) => ({
                label: row.label,
                value: row.mrr,
                valueLabel: formatMoney(row.mrr),
                meta: `${row.subscribers} active`,
              }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="By billing cycle"
            description="Where the annual-vs-monthly mix sits."
          />
          <CardBody>
            <BarList
              rows={byCycle.map((row) => ({
                label: CYCLE_LABELS[row.label] ?? row.label,
                value: row.mrr,
                valueLabel: formatMoney(row.mrr),
                meta: `${row.subscribers} active`,
              }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="By payment method"
            description="How each subscription is paid for, as recorded."
          />
          <CardBody>
            <BarList
              rows={byMethod.map((row) => ({
                label: METHOD_LABELS[row.label] ?? row.label,
                value: row.mrr,
                valueLabel: formatMoney(row.mrr),
                meta: `${row.subscribers} active`,
              }))}
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Expected collections"
          description="Current periods ending in the next 90 days, priced at one full cycle each. Free plans excluded."
        />
        <CardBody>
          <BarList
            rows={renewals.map((bucket) => ({
              label: bucket.label,
              value: bucket.amount,
              valueLabel: formatMoney(bucket.amount),
              meta: `${bucket.subscribers} subscription${bucket.subscribers === 1 ? '' : 's'}`,
            }))}
          />
          <DerivedNote>
            A renewal appears here because its period ends, not because a charge
            is scheduled. Subscriptions with no gateway subscription attached
            will not bill themselves.
          </DerivedNote>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Highest-value subscribers"
          description="By monthly recurring value."
        />
        <SubscriberMiniTable
          rows={top}
          dateLabel="Renews"
          dateOf={(row) => row.periodEnd}
          amountLabel="MRR"
          amountOf={(row) => row.mrr}
          emptyMessage="No paying subscriptions yet."
        />
      </Card>
    </div>
  );
}
