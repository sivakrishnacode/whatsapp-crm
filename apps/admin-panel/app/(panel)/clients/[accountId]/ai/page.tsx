import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AdjustCredits } from '@/components/credits/adjust-credits';
import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { MiniStat } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import { maxCreditAdjustment } from '@/lib/env';
import {
  formatCredits,
  formatDate,
  formatDateTime,
  formatDelta,
  formatMinor,
  formatNumber,
} from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { getSettings } from '@/lib/settings-store';
import {
  getAi,
  getWallet,
  getWorkspaceRow,
  listLedger,
  listOrders,
  type LedgerEntry,
} from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'AI & credits · Customer 360' };

/**
 * AI usage and the credit wallet (C360-029: "AI allocations/top-ups, usage
 * ledger"). The balance only ever moves through admin_adjust_ai_credits —
 * never a Prisma update — and a manual grant does not count as a purchase.
 *
 * Provider model ids are shown here (staff only): the C2.0 rule is that a
 * CUSTOMER never sees them, which this internal panel does not change.
 */
export default async function ClientAiPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const [workspace, ai, wallet, ledger, orders, settings] = await Promise.all([
    getWorkspaceRow(accountId),
    getAi(accountId),
    getWallet(accountId),
    listLedger(accountId, 40),
    listOrders(accountId, 10),
    getSettings(),
  ]);
  if (!workspace) notFound();

  const balance = wallet?.balance ?? 0;
  const onPlatform = (ai?.creditMode ?? 'platform') === 'platform';
  const tone =
    onPlatform && balance === 0
      ? 'critical'
      : onPlatform && balance <= settings.lowCreditThreshold
        ? 'warning'
        : 'neutral';
  const showMoney = can(staff, 'billing.read');

  return (
    <div className="space-y-6">
      <StatRow>
        <StatTile
          label="Credit balance"
          value={formatCredits(balance)}
          tone={tone}
          context={
            onPlatform
              ? `platform key · low at ${settings.lowCreditThreshold}`
              : 'own provider key — credits sit unused'
          }
        />
        <StatTile
          label="Used, last 30 days"
          value={formatCredits(workspace.creditsSpent30d)}
          context="every debit on the ledger"
        />
        <StatTile
          label="Bought, all time"
          value={formatCredits(wallet?.lifetimePurchased ?? 0)}
        />
        <StatTile
          label="Agents"
          value={`${ai?.activeAgents ?? 0} / ${ai?.agents ?? 0}`}
          context={`switched on / built · ${ai?.autoReplyAgents ?? 0} auto-replying`}
        />
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {can(staff, 'credits.adjust') ? (
            <Card>
              <CardHeader
                title="Adjust credits"
                description="A goodwill grant or a clawback. Written by admin_adjust_ai_credits in the same statement as its ledger row."
              />
              <CardBody>
                <AdjustCredits
                  accountId={accountId}
                  balance={balance}
                  creditMode={ai?.creditMode ?? null}
                  maxAdjustment={maxCreditAdjustment()}
                />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Credit ledger"
              description="Every movement, newest first. Append-only — a correction is a new row, never an edit."
            />
            {ledger.length === 0 ? (
              <EmptyState>Nothing has moved in this wallet yet.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {ledger.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-2.5 text-sm"
                  >
                    <span className="text-ink-2 min-w-0">
                      {describeLedgerEntry(entry)}
                      {entry.note ? (
                        <span className="text-muted block text-xs">
                          {entry.note}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-right">
                      <span
                        className={`tabular font-semibold ${entry.delta >= 0 ? 'text-good-fg' : 'text-ink'}`}
                      >
                        {formatDelta(entry.delta)}
                      </span>
                      <span className="text-muted block text-xs">
                        {formatDateTime(entry.createdAt)} · left{' '}
                        {formatCredits(entry.balanceAfter)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="AI setup" />
            <CardBody>
              {ai === null ? (
                <p className="text-muted text-sm">
                  This workspace has never opened the agent studio.
                </p>
              ) : (
                <Facts
                  items={[
                    {
                      label: 'Runs on',
                      value:
                        ai.creditMode === 'platform'
                          ? 'Our platform key (credits)'
                          : 'Their own provider key',
                      hint:
                        ai.creditMode === 'byok'
                          ? 'their provider bills them directly; nothing is metered'
                          : 'metered against the wallet',
                    },
                    {
                      label: 'Provider / model',
                      value:
                        ai.creditMode === 'platform'
                          ? 'platform default'
                          : `${ai.provider ?? '—'} · ${ai.model ?? '—'}`,
                      hint: 'internal — never shown to the customer',
                    },
                    {
                      label: 'Own key stored',
                      value: ai.hasOwnKey
                        ? 'Yes (encrypted, never read here)'
                        : 'No',
                    },
                    {
                      label: 'Test mode',
                      value:
                        ai.testModeAgents > 0
                          ? `${ai.testModeAgents} agent(s)`
                          : 'Off',
                    },
                    {
                      label: 'Knowledge / actions',
                      value: `${formatNumber(ai.knowledgeDocs)} document(s), ${formatNumber(ai.customActions)} action(s)`,
                    },
                    {
                      label: 'Embedding model',
                      value: ai.embeddingsModel ?? 'None indexed',
                    },
                    { label: 'Last changed', value: formatDate(ai.updatedAt) },
                  ]}
                />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Wallet" />
            <CardBody className="grid grid-cols-2 gap-x-6 gap-y-4">
              <MiniStat
                label="Consumed, all time"
                value={formatCredits(wallet?.lifetimeConsumed ?? 0)}
              />
              <MiniStat
                label="Welcome grant"
                value={
                  wallet?.signupGrantedAt
                    ? formatDate(wallet.signupGrantedAt)
                    : 'not granted'
                }
              />
              <MiniStat
                label="Low-balance warning sent"
                value={
                  wallet?.lowBalanceNotifiedAt
                    ? formatDate(wallet.lowBalanceNotifiedAt)
                    : '—'
                }
              />
              <MiniStat
                label="Wallet updated"
                value={formatDate(wallet?.updatedAt)}
              />
            </CardBody>
            <CardBody className="pt-0">
              <DerivedNote>
                Platform AI credits are separate from Meta messaging charges,
                which Meta bills the customer directly and which this panel does
                not see.
              </DerivedNote>
            </CardBody>
          </Card>

          {showMoney ? (
            <Card>
              <CardHeader
                title="Credit top-ups"
                description="Real payments: an order records the amount Razorpay collected."
              />
              {orders.length === 0 ? (
                <EmptyState>No top-ups purchased.</EmptyState>
              ) : (
                <ul className="divide-line divide-y">
                  {orders.map((order) => (
                    <li
                      key={order.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm"
                    >
                      <span className="text-ink-2">
                        {formatCredits(order.credits)} credits
                        <span className="text-muted block text-xs">
                          {order.packCode} · {order.gateway}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="text-ink tabular font-semibold">
                          {formatMinor(order.amountMinor, order.currency)}
                        </span>
                        <span className="text-muted block text-xs">
                          {order.creditedAt
                            ? `credited ${formatDate(order.creditedAt)}`
                            : `${order.status} · started ${formatDate(order.createdAt)}`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A ledger row in one line. `feature` is only set on a `usage` row, so a
 * grant reads as what granted it rather than as a feature.
 */
function describeLedgerEntry(entry: LedgerEntry): string {
  const REASONS: Record<string, string> = {
    signup_grant: 'Welcome grant',
    purchase: 'Top-up purchased',
    usage: 'Usage',
    refund: 'Refund',
    plan_grant: 'Included with plan',
    admin_adjust: 'Manual adjustment',
  };
  const base = REASONS[entry.reason] ?? entry.reason;
  if (entry.reason !== 'usage') return base;

  const FEATURES: Record<string, string> = {
    draft: 'Inbox draft',
    auto_reply: 'Auto-reply',
    playground: 'Playground',
    embedding: 'Knowledge indexing',
    automation_draft: 'Automation builder',
    flow_draft: 'Flow builder',
  };
  const what = entry.feature
    ? (FEATURES[entry.feature] ?? entry.feature)
    : base;
  const tokens =
    entry.inputTokens + entry.outputTokens > 0
      ? ` · ${formatNumber(entry.inputTokens)} in / ${formatNumber(entry.outputTokens)} out`
      : '';
  return `${what}${entry.model ? ` · ${entry.model}` : ''}${tokens}`;
}
