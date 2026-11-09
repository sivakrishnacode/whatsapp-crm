import type { Metadata } from 'next';
import Link from 'next/link';

import { SubscriberIdentity } from '@/components/subscriber/identity';
import { Pill, StatusBadge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Callout, ScopeLine, Segmented } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import {
  formatCredits,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import { getRenewalWatch, type WatchWindow } from '@/lib/queries/renewals';
import type { SubscriberRow } from '@/lib/queries/sql';
import { getSettings } from '@/lib/settings-store';

export const metadata: Metadata = {
  title: 'Renewals watchlist · Converse360 Control Center',
};

const WINDOWS: WatchWindow[] = [7, 15, 30];

const METHOD_LABEL: Record<string, string> = {
  razorpay: 'Razorpay',
  stripe: 'Stripe',
  manual: 'Manual',
};

function gatewayOf(row: SubscriberRow): 'stripe' | 'razorpay' | null {
  if (row.stripeSubscriptionId) return 'stripe';
  if (row.razorpaySubscriptionId) return 'razorpay';
  return null;
}

function WorkspaceCell({ row }: { row: SubscriberRow }) {
  return row.accountId ? (
    <Link
      href={`/clients/${row.accountId}`}
      className="text-ink-2 hover:text-ink font-medium underline-offset-2 hover:underline"
    >
      {row.accountName ?? 'Unnamed workspace'}
    </Link>
  ) : (
    <span className="text-muted text-xs">owns no workspace</span>
  );
}

/**
 * The renewal watchlist (C360-030). The window is a URL choice (`?days=`),
 * defaulting to the System Settings value, so a shared link shows the same
 * list to whoever opens it.
 */
export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireCapability('billing.read');
  const [{ days: rawDays }, settings] = await Promise.all([
    searchParams,
    getSettings(),
  ]);

  const parsed = Number(rawDays);
  const days: WatchWindow = WINDOWS.includes(parsed as WatchWindow)
    ? (parsed as WatchWindow)
    : settings.renewalWindowDays;

  const watch = await getRenewalWatch(days, settings.lowCreditThreshold);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeLine>
          <span>
            Next <strong className="text-ink-2">{days} days</strong> from now
          </span>
          <span aria-hidden>·</span>
          <span>Times in {adminTimezone()}</span>
          <span aria-hidden>·</span>
          <span>Source: user_subscriptions, ai_credit_wallets</span>
        </ScopeLine>
        <Segmented
          label="Watch window"
          active={String(days)}
          options={WINDOWS.map((value) => ({
            value: String(value),
            label: `${value} days`,
            href: `/subscriptions/renewals?days=${value}`,
          }))}
        />
      </div>

      <StatRow>
        <StatTile
          label="Renewals due"
          value={formatNumber(watch.renewalsTotal)}
          context={`${formatMoney(watch.renewalsAmount)} at one full cycle each, excluding ${formatNumber(watch.renewalsCancelling)} set to cancel`}
        />
        <StatTile
          label="Will not bill themselves"
          value={formatNumber(watch.renewalsManual)}
          context="No Stripe or Razorpay subscription attached — someone has to collect"
          tone={watch.renewalsManual > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Trials ending"
          value={formatNumber(watch.trials.length)}
          context="A conversion conversation, while there is still time"
        />
        <StatTile
          label="Past due"
          value={formatNumber(watch.pastDue.length)}
          context="In dunning — still entitled, nothing locked yet"
          tone={watch.pastDue.length > 0 ? 'warning' : 'neutral'}
        />
      </StatRow>

      <Card>
        <CardHeader
          title="Renewals due"
          description={`Active and past-due periods ending in the next ${days} days, soonest first.`}
        />
        {watch.renewals.length === 0 ? (
          <EmptyState>
            No period ends in the next {days} days. Widen the window to see
            further ahead.
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="56rem">
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH>Owner (payer)</TH>
                  <TH>Plan</TH>
                  <TH>Period ends</TH>
                  <TH>Collection</TH>
                  <TH align="right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                {watch.renewals.map((row) => {
                  const gateway = gatewayOf(row);
                  return (
                    <TR key={row.userId}>
                      <TD>
                        <WorkspaceCell row={row} />
                        <span className="mt-1 block">
                          <StatusBadge status={row.status} />
                        </span>
                      </TD>
                      <TD>
                        <SubscriberIdentity
                          userId={row.userId}
                          fullName={row.fullName}
                          email={row.email}
                        />
                      </TD>
                      <TD>
                        <span className="text-ink-2">
                          {row.planDisplayName}
                        </span>
                        <span className="text-muted block text-xs">
                          {row.billingCycle ?? 'no cycle'}
                          {row.paymentMethod
                            ? ` · ${METHOD_LABEL[row.paymentMethod] ?? row.paymentMethod}`
                            : ''}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-ink-2">
                          {formatDate(row.periodEnd)}
                        </span>
                        <span className="text-muted block text-xs">
                          {formatRelativeDays(row.periodEnd)}
                        </span>
                      </TD>
                      <TD>
                        <span className="flex flex-wrap gap-1">
                          {gateway ? (
                            <Pill tone="good" glyph="●">
                              {gateway === 'stripe' ? 'Stripe' : 'Razorpay'}{' '}
                              auto-renew
                            </Pill>
                          ) : (
                            <Pill tone="warn" glyph="▲">
                              Will not bill itself
                            </Pill>
                          )}
                          {row.cancelAtPeriodEnd ? (
                            <Pill tone="bad" glyph="■">
                              Cancels at period end
                            </Pill>
                          ) : null}
                        </span>
                      </TD>
                      <TD align="right">
                        <span className="text-ink font-semibold">
                          {formatMoney(row.periodAmount)}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
        <div className="px-5 pb-4">
          <DerivedNote>
            Amounts are the plan&apos;s price for one cycle, not an invoice —
            this database records subscriptions, not payments. Reminders are not
            sent from here; contact the owner, who is the only person whose
            payment lands on the workspace&apos;s subscription.
          </DerivedNote>
        </div>
      </Card>

      {watch.lapsedActive.length > 0 ? (
        <Card>
          <CardHeader
            title="Period ended, still marked active"
            description="Ended in the last 30 days without the row moving on. Either a gateway webhook has not arrived yet or the subscription sweep has not run — the workspace stays entitled until one of them does."
          />
          <TableWrap>
            <Table minWidth="44rem">
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH>Plan</TH>
                  <TH>Period ended</TH>
                  <TH>Collection</TH>
                  <TH align="right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                {watch.lapsedActive.map((row) => {
                  const gateway = gatewayOf(row);
                  return (
                    <TR key={row.userId}>
                      <TD>
                        <WorkspaceCell row={row} />
                        <span className="text-muted block truncate text-xs">
                          {row.email}
                        </span>
                      </TD>
                      <TD>{row.planDisplayName}</TD>
                      <TD>
                        <span className="text-ink-2">
                          {formatDate(row.periodEnd)}
                        </span>
                        <span className="text-muted block text-xs">
                          {formatRelativeDays(row.periodEnd)}
                        </span>
                      </TD>
                      <TD>
                        {gateway ? (
                          <Pill tone="info" glyph="?">
                            Awaiting {gateway} webhook
                          </Pill>
                        ) : (
                          <Pill tone="warn" glyph="▲">
                            Manual — nothing will renew it
                          </Pill>
                        )}
                      </TD>
                      <TD align="right">{formatMoney(row.periodAmount)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Trials ending"
            description={`Trials whose window closes in the next ${days} days. One trial per workspace, ever — there is no second one to offer.`}
          />
          {watch.trials.length === 0 ? (
            <EmptyState>No trial ends in the next {days} days.</EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {watch.trials.map((row) => (
                <li
                  key={row.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <span className="min-w-0">
                    <WorkspaceCell row={row} />
                    <span className="text-muted block truncate text-xs">
                      {row.planDisplayName} · {row.email}
                    </span>
                  </span>
                  <span className="text-right text-sm">
                    <span className="text-ink-2">
                      {formatDate(row.trialEndAt)}
                    </span>
                    <span className="text-muted block text-xs">
                      {formatRelativeDays(row.trialEndAt)} ·{' '}
                      {formatMoney(row.periodAmount)}/cycle if it converts
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Past due"
            description="Payment failed and the subscription is in dunning. Still entitled — past_due is grace, not lapse."
          />
          {watch.pastDue.length === 0 ? (
            <EmptyState>Nobody is past due.</EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {watch.pastDue.map((row) => (
                <li
                  key={row.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <span className="min-w-0">
                    <WorkspaceCell row={row} />
                    <span className="text-muted block truncate text-xs">
                      {row.planDisplayName} · {row.email}
                    </span>
                  </span>
                  <span className="text-right text-sm">
                    <span className="text-ink font-semibold">
                      {formatMoney(row.periodAmount)}
                    </span>
                    <span className="text-muted block text-xs">
                      period ended {formatRelativeDays(row.periodEnd)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="AI credit wallets running dry"
          description={`Platform-credit wallets at or under ${formatCredits(settings.lowCreditThreshold)} credits (the threshold in System Settings). Own-key workspaces are not metered, so they never appear.`}
        />
        {watch.wallets.length === 0 ? (
          <EmptyState>
            Every platform wallet is above{' '}
            {formatCredits(settings.lowCreditThreshold)} credits.
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="44rem">
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH>Auto-reply</TH>
                  <TH>Customer warned</TH>
                  <TH align="right">Spent, 30 days</TH>
                  <TH align="right">Left</TH>
                </TR>
              </THead>
              <TBody>
                {watch.wallets.map((row) => (
                  <TR key={row.accountId}>
                    <TD>
                      <Link
                        href={`/clients/${row.accountId}`}
                        className="text-ink-2 hover:text-ink font-medium underline-offset-2 hover:underline"
                      >
                        {row.accountName}
                      </Link>
                      <span className="text-muted block truncate text-xs">
                        {row.ownerEmail}
                      </span>
                    </TD>
                    <TD>
                      {row.autoReplyAgents > 0 ? (
                        <Pill
                          tone={row.balance === 0 ? 'bad' : 'warn'}
                          glyph="▲"
                        >
                          {formatNumber(row.autoReplyAgents)} agent
                          {row.autoReplyAgents === 1 ? '' : 's'} answering
                        </Pill>
                      ) : (
                        <span className="text-muted text-xs">Off</span>
                      )}
                    </TD>
                    <TD>
                      <span className="text-muted text-xs">
                        {row.lowBalanceNotifiedAt
                          ? formatDateTime(row.lowBalanceNotifiedAt)
                          : 'not yet'}
                      </span>
                    </TD>
                    <TD align="right">{formatCredits(row.spent30d)}</TD>
                    <TD align="right">
                      <span className="text-ink font-semibold">
                        {formatCredits(row.balance)}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <Callout tone="neutral">
        Notifications are not sent from this screen. The CRM warns a workspace
        about a low wallet itself (the &ldquo;customer warned&rdquo; column); a
        renewal reminder is a conversation with the owner.
      </Callout>
    </div>
  );
}
