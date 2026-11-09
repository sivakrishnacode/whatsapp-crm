import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TrendBars } from '@/components/chart/trend-bars';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { Callout, MiniStat, ScopeLine, Segmented } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import {
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/components/ui/table';
import { requireCapability } from '@/lib/auth';
import {
  formatCredits,
  formatDateTime,
  formatDayLabel,
  formatNumber,
} from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { getPerformance, resolveWindow } from '@/lib/queries/clients';
import { prisma } from '@/lib/prisma';

export const metadata: Metadata = { title: 'Performance · Customer 360' };

const CHANNEL_LABEL = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  web: 'Web chat',
} as const;

function minutes(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${value.toFixed(1)} min`;
  if (value < 60 * 48) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 1440).toFixed(1)} days`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

/**
 * Per-client performance (C360-026). Every figure comes from the same RPCs
 * that power the customer's own analytics screen, so the two never disagree.
 * Metrics the product does not record are shown as unavailable rather than
 * estimated.
 */
export default async function ClientPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();
  const query = await searchParams;

  const window = await resolveWindow(query);
  const [perf, account] = await Promise.all([
    getPerformance(accountId, window),
    prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultCurrency: true },
    }),
  ]);
  if (!account) notFound();

  const base = `/clients/${accountId}/performance`;
  const t = perf.totals;
  const prevLabel =
    window.key === 'today' ? 'vs yesterday' : 'vs previous window';
  const responseChannels = perf.channels.filter(
    (c) => c.avgResponseMinutes !== null
  );
  const dealMoney = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: account.defaultCurrency || 'INR',
    maximumFractionDigits: 0,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Segmented
          label="Reporting window"
          active={window.key}
          options={[
            { value: 'today', label: 'Today', href: `${base}?period=today` },
            { value: '7d', label: '7 days', href: `${base}?period=7d` },
            { value: '30d', label: '30 days', href: `${base}?period=30d` },
            { value: '90d', label: '90 days', href: `${base}?period=90d` },
          ]}
        />
        <form
          method="get"
          action={base}
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="period" value="custom" />
          <label className="text-muted text-xs">
            From
            <Input
              type="date"
              name="from"
              defaultValue={window.fromInput}
              className="mt-1 w-auto"
            />
          </label>
          <label className="text-muted text-xs">
            To
            <Input
              type="date"
              name="to"
              defaultValue={window.toInput}
              className="mt-1 w-auto"
            />
          </label>
          <button
            type="submit"
            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
              window.key === 'custom'
                ? 'bg-primary border-transparent text-white'
                : 'border-ring bg-surface text-ink hover:bg-surface-2'
            }`}
          >
            Custom range
          </button>
        </form>
      </div>

      <ScopeLine>
        <span className="text-ink-2 font-semibold">{window.label}</span>
        <span>
          {formatDateTime(window.start)} → {formatDateTime(window.end)} (
          {window.timezone})
        </span>
        <span aria-hidden>·</span>
        <span>
          Deltas compare the immediately preceding window of equal length
        </span>
      </ScopeLine>

      <StatRow columns={6}>
        <StatTile
          label="Outbound"
          value={formatNumber(t.msgsOut)}
          delta={{
            current: t.msgsOut,
            previous: t.prev.msgsOut,
            better: 'up',
            label: prevLabel,
          }}
        />
        <StatTile
          label="Inbound"
          value={formatNumber(t.msgsIn)}
          delta={{
            current: t.msgsIn,
            previous: t.prev.msgsIn,
            better: 'up',
            label: prevLabel,
          }}
        />
        <StatTile
          label="Delivered"
          value={pct(t.delivered, t.msgsOut)}
          context={`${formatNumber(t.delivered)} delivered or read`}
        />
        <StatTile
          label="Failed"
          value={formatNumber(t.failed)}
          delta={{
            current: t.failed,
            previous: t.prev.failed,
            better: 'down',
            label: prevLabel,
          }}
          tone={t.failed > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Active conversations"
          value={formatNumber(t.convsActive)}
          delta={{
            current: t.convsActive,
            previous: t.prev.convsActive,
            better: 'up',
            label: prevLabel,
          }}
        />
        <StatTile
          label="New contacts"
          value={formatNumber(t.contactsNew)}
          delta={{
            current: t.contactsNew,
            previous: t.prev.contactsNew,
            better: 'up',
            label: prevLabel,
          }}
        />
      </StatRow>

      <Card>
        <CardHeader
          title="Daily volume"
          description={`Outbound messages per local day in ${window.timezone}, with the failed share stacked on top.`}
        />
        <CardBody>
          <TrendBars
            caption={`Daily outbound and failed messages, ${window.label}`}
            series={[
              { key: 'ok', label: 'Outbound, not failed', tone: 'primary' },
              { key: 'failed', label: 'Failed', tone: 'alert' },
            ]}
            points={perf.series.map((p) => ({
              label: formatDayLabel(`${p.day}T12:00:00Z`),
              values: {
                ok: Math.max(p.outgoing - p.failed, 0),
                failed: p.failed,
              },
            }))}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Channel mix"
            description="The same window, per channel."
          />
          <TableWrap>
            <Table minWidth="34rem">
              <THead>
                <tr>
                  <TH>Channel</TH>
                  <TH align="right">Out</TH>
                  <TH align="right">In</TH>
                  <TH align="right">Delivered</TH>
                  <TH align="right">Failed</TH>
                  <TH align="right">Avg first response</TH>
                </tr>
              </THead>
              <TBody>
                {perf.channels.map((c) => (
                  <TR key={c.channel}>
                    <TD className="font-semibold">
                      {CHANNEL_LABEL[c.channel]}
                    </TD>
                    <TD align="right">{formatNumber(c.msgsOut)}</TD>
                    <TD align="right">{formatNumber(c.msgsIn)}</TD>
                    <TD align="right">{pct(c.delivered, c.msgsOut)}</TD>
                    <TD align="right">{formatNumber(c.failed)}</TD>
                    <TD align="right">{minutes(c.avgResponseMinutes)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          <CardBody>
            <DerivedNote>
              Avg first response is the customer&apos;s own metric: minutes
              between a customer message and the agent or bot message that
              immediately follows it in the same conversation. It includes bot
              replies and is not a support SLA.
            </DerivedNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Service, AI and team" />
          <CardBody className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <MiniStat
              label="Agent & API messages"
              value={formatNumber(t.humanReplies)}
              hint="sender type agent — inbox and public API"
            />
            <MiniStat
              label="AI-written replies"
              value={formatNumber(t.aiReplies)}
              hint={pct(t.aiReplies, t.msgsOut) + ' of outbound'}
            />
            <MiniStat
              label="AI handoffs to humans"
              value={formatNumber(t.handoffs)}
            />
            <MiniStat
              label="Active inbox agents"
              value={formatNumber(perf.activeHumanAgents)}
              hint="distinct people who sent from the inbox; API sends record no sender"
            />
            <MiniStat
              label="AI credits consumed"
              value={formatCredits(perf.creditsConsumed)}
              hint="platform wallet ledger"
            />
            <MiniStat
              label="Fastest channel response"
              value={
                responseChannels.length
                  ? minutes(
                      Math.min(
                        ...responseChannels.map((c) => c.avgResponseMinutes!)
                      )
                    )
                  : '—'
              }
            />
          </CardBody>
          <CardBody className="border-line border-t">
            <Callout tone="neutral" title="Not instrumented">
              Resolution time and conversation SLA attainment are unavailable:
              conversations record no resolution event or SLA target today.
              Support-desk SLAs for this client are on the Tickets tab.
            </Callout>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Leads and conversions"
            description="New contacts reached on a channel in the window, and pipeline deals created from a conversation."
          />
          <CardBody className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <MiniStat
              label="New contacts (leads)"
              value={formatNumber(perf.leads.contacts)}
            />
            <MiniStat
              label="Deals created"
              value={formatNumber(perf.leads.deals)}
            />
            <MiniStat
              label="Deals won"
              value={formatNumber(perf.leads.won)}
              hint={pct(perf.leads.won, perf.leads.deals) + ' win rate'}
            />
            <MiniStat
              label="Pipeline value created"
              value={dealMoney.format(perf.leads.dealValue)}
            />
            <MiniStat
              label="Won value"
              value={dealMoney.format(perf.leads.wonValue)}
            />
          </CardBody>
          <CardBody className="pt-0">
            <DerivedNote>
              Conversions count only deals linked to a conversation — a deal
              created by hand in the pipeline without one is not attributed to a
              channel. Values are in the workspace&apos;s own currency (
              {account.defaultCurrency}), never mixed with our revenue figures.
            </DerivedNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Campaigns"
            description="Broadcasts created in the window, with the delivery counters each one keeps."
          />
          <CardBody className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <MiniStat
              label="Broadcasts"
              value={formatNumber(perf.broadcasts.count)}
            />
            <MiniStat
              label="Recipients"
              value={formatNumber(perf.broadcasts.recipients)}
            />
            <MiniStat label="Sent" value={formatNumber(perf.broadcasts.sent)} />
            <MiniStat
              label="Delivered"
              value={pct(perf.broadcasts.delivered, perf.broadcasts.sent)}
            />
            <MiniStat
              label="Read"
              value={pct(perf.broadcasts.read, perf.broadcasts.sent)}
            />
            <MiniStat
              label="Failed"
              value={formatNumber(perf.broadcasts.failed)}
            />
          </CardBody>
        </Card>
      </div>

      <DerivedNote>
        Definitions (mirroring migration 089): outbound = messages from an agent
        or a bot; delivered = Meta reported delivered or read; failed = status
        failed; active conversations = conversations with any message in the
        window. Deleted messages are excluded.
      </DerivedNote>
    </div>
  );
}
