import type { Metadata } from 'next';
import Link from 'next/link';

import { BarList } from '@/components/chart/bar-list';
import { PackForm } from '@/components/credits/pack-form';
import { Badge, Pill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { HeroStat, StatRow, StatTile } from '@/components/ui/stat';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { requireAdmin } from '@/lib/auth';
import { maxCreditAdjustment } from '@/lib/env';
import {
  formatCredits,
  formatDate,
  formatDateTime,
  formatDelta,
  formatMinor,
  formatMonth,
  formatNumber,
  minorToMajor,
} from '@/lib/format';
import { getCreditsOverview } from '@/lib/queries/credits';
import { LOW_CREDIT_THRESHOLD } from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'AI credits · Converse360 Admin' };

const FEATURE_LABELS: Record<string, string> = {
  draft: 'Inbox drafts',
  auto_reply: 'Auto-replies',
  playground: 'Playground',
  embedding: 'Knowledge indexing',
};

/**
 * AI credits across every tenant.
 *
 * This is the one page in the panel whose money is *collected* rather than
 * derived: a credit top-up writes `ai_credit_orders.amount_minor`, so top-up
 * revenue is a fact and can safely sit on a time axis. Subscription revenue
 * cannot — see lib/queries/sql.ts.
 */
export default async function CreditsPage() {
  await requireAdmin();
  const { totals, features, months, consumers, packs, orders, adjustments } =
    await getCreditsOverview();

  const consumedNet = totals.lifetimeConsumed;
  const grantedFree = Math.max(
    totals.outstanding + consumedNet - totals.lifetimePurchased,
    0
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-ink text-xl font-semibold">AI credits</h1>
        <p className="text-muted mt-1 text-sm">
          What the platform Gemini key is costing us, what customers have paid
          to use it, and the packs they buy it in.
        </p>
      </header>

      <Card>
        <CardBody className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center">
          <HeroStat
            label="Credits outstanding"
            value={formatCredits(totals.outstanding)}
            context={
              <>
                across {formatNumber(totals.wallets)} wallet
                {totals.wallets === 1 ? '' : 's'} ·{' '}
                {formatCredits(totals.consumed30d)} consumed in the last 30 days
              </>
            }
          />

          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-muted text-xs">Top-up revenue, all time</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatMinor(totals.topUpRevenueMinor)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(totals.paidOrders)} paid order
                {totals.paidOrders === 1 ? '' : 's'} — actually collected
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">This month</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatMinor(totals.topUpRevenueMinorThisMonth)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(totals.unpaidOrders)} checkout
                {totals.unpaidOrders === 1 ? '' : 's'} started and never paid
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">Wallets out of credits</dt>
              <dd className="text-ink mt-1 flex items-center gap-2 font-semibold">
                {totals.walletsEmpty > 0 ? (
                  <span
                    aria-hidden
                    className="bg-critical size-2 rounded-full"
                  />
                ) : null}
                {formatNumber(totals.walletsEmpty)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                {formatNumber(totals.walletsLow)} more under{' '}
                {LOW_CREDIT_THRESHOLD}
              </dd>
            </div>

            <div>
              <dt className="text-muted text-xs">Given away, not sold</dt>
              <dd className="text-ink mt-1 font-semibold">
                {formatCredits(grantedFree)}
              </dd>
              <dd className="text-muted mt-0.5 text-xs">
                welcome grants and manual adjustments
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <StatRow>
        <StatTile
          label="On our key"
          value={formatNumber(totals.onPlatform)}
          context="workspaces spending credits"
        />
        <StatTile
          label="On their own key"
          value={formatNumber(totals.onOwnKey)}
          context="metered by their provider, not by us"
        />
        <StatTile
          label="Granted by hand, 30d"
          value={formatDelta(totals.adminGranted30d)}
          context={
            totals.adminRevoked30d > 0
              ? `${formatCredits(totals.adminRevoked30d)} taken back`
              : 'nothing taken back'
          }
          tone={totals.adminGranted30d > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Adjustment ceiling"
          value={formatCredits(maxCreditAdjustment())}
          context="per adjustment, from ADMIN_MAX_CREDIT_ADJUSTMENT"
        />
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card>
          <CardHeader
            title="What credits are spent on"
            description="Last 30 days. Usage only — a manual adjustment carries no feature, so it never shows up here as one."
          />
          <CardBody>
            <BarList
              rows={features.map((row) => ({
                label: FEATURE_LABELS[row.feature ?? ''] ?? row.feature ?? '—',
                value: row.credits,
                valueLabel: formatCredits(row.credits),
                meta: `${formatNumber(row.calls)} call${row.calls === 1 ? '' : 's'}`,
              }))}
            />
            <DerivedNote>
              A credit is 4,000 weighted tokens (output counted at 4× input), so
              these bars are cost, not popularity — one long grounded reply
              outweighs several short ones.
            </DerivedNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Heaviest workspaces"
            description="Credits consumed in the last 30 days, with what each has left."
          />
          {consumers.length === 0 ? (
            <CardBody>
              <p className="text-muted text-sm">
                Nothing has been spent in the last 30 days.
              </p>
            </CardBody>
          ) : (
            <TableWrap>
              <Table minWidth="34rem">
                <THead>
                  <TR>
                    <TH>Workspace</TH>
                    <TH>Runs on</TH>
                    <TH align="right">Spent</TH>
                    <TH align="right">Left</TH>
                  </TR>
                </THead>
                <TBody>
                  {consumers.map((row) => (
                    <TR key={row.accountId}>
                      <TD>
                        <Link
                          href={`/workspaces/${row.accountId}`}
                          className="text-ink font-medium underline-offset-2 hover:underline"
                        >
                          {row.accountName}
                        </Link>
                        <span className="text-muted block truncate text-xs">
                          {row.ownerEmail}
                        </span>
                      </TD>
                      <TD>
                        <Badge tone="outline">
                          {row.creditMode === 'platform'
                            ? 'our key'
                            : 'own key'}
                        </Badge>
                      </TD>
                      <TD align="right">
                        <span className="text-ink font-medium">
                          {formatCredits(row.credits)}
                        </span>
                        <span className="text-muted block text-xs">
                          {formatNumber(row.calls)} calls
                        </span>
                      </TD>
                      <TD align="right">
                        <span
                          className={
                            (row.balance ?? 0) === 0
                              ? 'text-muted'
                              : 'text-ink-2'
                          }
                        >
                          {formatCredits(row.balance ?? 0)}
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Month by month"
          description="From the ledger and the orders themselves, so unlike the subscription figures in this panel these numbers do not move when a price is edited."
        />
        <TableWrap>
          <Table minWidth="44rem">
            <THead>
              <TR>
                <TH>Month</TH>
                <TH align="right">Consumed</TH>
                <TH align="right">Purchased</TH>
                <TH align="right">Granted by hand</TH>
                <TH align="right">Top-ups</TH>
                <TH align="right">Collected</TH>
              </TR>
            </THead>
            <TBody>
              {months.map((month) => (
                <TR key={month.month.toISOString()}>
                  <TD>
                    <span className="text-ink-2">
                      {formatMonth(month.month)}
                    </span>
                  </TD>
                  <TD align="right">{formatCredits(month.consumed)}</TD>
                  <TD align="right">{formatCredits(month.purchased)}</TD>
                  <TD align="right">
                    {month.adminGranted === 0 && month.adminRevoked === 0
                      ? '—'
                      : `${formatDelta(month.adminGranted)}${
                          month.adminRevoked > 0
                            ? ` / −${formatNumber(month.adminRevoked)}`
                            : ''
                        }`}
                  </TD>
                  <TD align="right">
                    {month.orders > 0 ? formatNumber(month.orders) : '—'}
                  </TD>
                  <TD align="right">
                    <span className="text-ink font-medium">
                      {month.revenueMinor > 0
                        ? formatMinor(month.revenueMinor)
                        : '—'}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
        <DerivedNote>
          &ldquo;Purchased&rdquo; counts credits granted by a paid order;
          &ldquo;granted by hand&rdquo; counts manual adjustments, which cost us
          inference and earn nothing. Only the last column is money.
        </DerivedNote>
      </Card>

      <Card>
        <CardHeader
          title="Credit packs"
          description="The price list customers buy from, read live out of the table — a change here needs no deploy."
        />
        <CardBody className="space-y-5">
          {packs.map((pack) => (
            <details
              key={pack.id}
              className="border-line border-t pt-4 first:border-t-0 first:pt-0"
            >
              <summary className="cursor-pointer">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-ink text-sm font-medium">
                    {pack.displayName}
                  </span>
                  <Badge tone="outline">{pack.code}</Badge>
                  {pack.badge ? <Pill>{pack.badge}</Pill> : null}
                  {pack.isActive ? null : <Pill>Not offered</Pill>}
                  <span className="text-ink-2 tabular text-sm">
                    {formatMinor(pack.priceMinor, pack.currency)} for{' '}
                    {formatCredits(pack.credits)}
                  </span>
                  <span className="text-muted text-xs">
                    {(minorToMajor(pack.priceMinor) / pack.credits).toFixed(3)}{' '}
                    {pack.currency}/credit · {formatNumber(pack.sold)} sold ·{' '}
                    {formatMinor(pack.revenueMinor, pack.currency)} earned
                  </span>
                </span>
              </summary>
              <div className="mt-5">
                <PackForm
                  packId={pack.id}
                  code={pack.code}
                  displayName={pack.displayName}
                  credits={pack.credits}
                  priceMajor={minorToMajor(pack.priceMinor)}
                  currencyCode={pack.currency}
                  badge={pack.badge}
                  sortOrder={pack.sortOrder}
                  isActive={pack.isActive}
                  sold={pack.sold}
                />
                <p className="text-muted mt-4 text-xs">
                  Last changed {formatDate(pack.updatedAt)}. Earned is summed
                  from what each order was actually charged, so repricing a pack
                  never rewrites what it has already sold for.
                </p>
              </div>
            </details>
          ))}
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Recent top-ups"
            description="Newest first, paid or not. An order with no credited date was started and abandoned."
          />
          {orders.length === 0 ? (
            <CardBody>
              <p className="text-muted text-sm">
                Nobody has bought credits yet.
              </p>
            </CardBody>
          ) : (
            <ul className="divide-line divide-y">
              {orders.map((order) => (
                <li
                  key={order.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/workspaces/${order.accountId}`}
                      className="text-ink font-medium underline-offset-2 hover:underline"
                    >
                      {order.accountName}
                    </Link>
                    <span className="text-muted block truncate text-xs">
                      {formatCredits(order.credits)} credits · {order.packCode}
                      {order.buyerEmail ? ` · ${order.buyerEmail}` : ''}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="text-ink tabular font-medium">
                      {formatMinor(order.amountMinor, order.currency)}
                    </span>
                    <span className="text-muted block text-xs">
                      {order.creditedAt
                        ? `credited ${formatDate(order.creditedAt)}`
                        : `${order.status} · ${formatDate(order.createdAt)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Manual adjustments"
            description="Every credit this panel has created or taken back. The reason is whatever the operator typed at the time."
          />
          {adjustments.length === 0 ? (
            <CardBody>
              <p className="text-muted text-sm">
                No credits have been adjusted by hand.
              </p>
            </CardBody>
          ) : (
            <ul className="divide-line divide-y">
              {adjustments.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/workspaces/${row.accountId}`}
                      className="text-ink font-medium underline-offset-2 hover:underline"
                    >
                      {row.accountName}
                    </Link>
                    <span className="text-muted block text-xs">
                      {row.note ?? 'no reason recorded'}
                    </span>
                  </span>
                  <span className="text-right">
                    <span
                      className={`tabular font-medium ${row.delta >= 0 ? 'text-good-ink' : 'text-ink'}`}
                    >
                      {formatDelta(row.delta)}
                    </span>
                    <span className="text-muted block text-xs">
                      {formatDateTime(row.createdAt)} · left{' '}
                      {formatCredits(row.balanceAfter)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
