import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { BarList } from '@/components/chart/bar-list';
import { Funnel } from '@/components/chart/funnel';
import { TrendBars } from '@/components/chart/trend-bars';
import { HealthBadge, LIFECYCLE_STYLE } from '@/components/ops/badges';
import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Select } from '@/components/ui/form';
import {
  ButtonLink,
  Callout,
  PageHeader,
  ScopeLine,
  Segmented,
} from '@/components/ui/page';
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
import { can, requireCapability } from '@/lib/auth';
import {
  formatCredits,
  formatDate,
  formatDayLabel,
  formatMoney,
  formatNumber,
  formatPercent,
} from '@/lib/format';
import { LIFECYCLE_STAGES } from '@/lib/lifecycle';
import {
  PERIODS,
  failureRate,
  getPortfolio,
  parsePeriod,
  type PeriodKey,
  type SegmentRow,
} from '@/lib/queries/portfolio';

export const metadata: Metadata = {
  title: 'Portfolio Analytics · Converse360 Control Center',
};

/**
 * Fleet-wide analytics (C360-027/028), distinct from any one client's.
 *
 * The page has exactly three inputs — the period, a plan and an account
 * manager — and all three apply to EVERY block; they are restated in a
 * callout whenever a segment filter is on, so a filtered figure can never
 * sit beside an unfiltered one unannounced. Each block names its window,
 * timezone and definition. MRR is "as of now": subscription history is not
 * recorded, so it is the one figure here that the period does not move.
 */

type Search = { period?: string; plan?: string; manager?: string };

function buildHref(base: Search, patch: Partial<Search>): string {
  const merged = { ...base, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/portfolio?${query}` : '/portfolio';
}

function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / (60 * 24)).toFixed(1)} days`;
}

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const staff = await requireCapability('clients.read');
  const money = can(staff, 'billing.read');
  const mayExport = can(staff, 'export');

  const raw = await searchParams;
  const period: PeriodKey = parsePeriod(raw.period);
  const p = await getPortfolio({
    period,
    plan: raw.plan,
    manager: raw.manager,
  });
  const { window: w, scope, messaging: m, support: s } = p;

  const current: Search = {
    period: period === '30d' ? undefined : period,
    plan: p.filters.plan,
    manager: p.filters.manager,
  };
  const exportParams = new URLSearchParams({ period });
  if (p.filters.plan) exportParams.set('plan', p.filters.plan);
  if (p.filters.manager) exportParams.set('manager', p.filters.manager);
  const exportHref = `/export/portfolio?${exportParams.toString()}`;
  const deltaLabel = `vs previous ${w.days} days`;
  const filtered = Boolean(p.filters.plan || p.filters.manager);
  const planLabel = p.options.plans.find(
    (o) => o.value === p.filters.plan
  )?.label;
  const managerLabel = p.options.managers.find(
    (o) => o.value === p.filters.manager
  )?.label;

  /* ---------- clients ---------- */
  const newInWindow = scope.filter((e) => e.createdAt >= w.start);
  const byStage = LIFECYCLE_STAGES.map((stage) => ({
    stage,
    count: scope.filter((e) => e.lifecycle.stage === stage).length,
  }));
  const churned = byStage.find((b) => b.stage === 'churned')?.count ?? 0;
  const active = byStage.find((b) => b.stage === 'active')?.count ?? 0;

  // Cumulative: each step counts workspaces that also passed every step
  // before it, so the bars only ever shrink and read as a funnel.
  const cohort = newInWindow;
  const s1 = cohort.filter(
    (e) => e.health.evidence.setup.onboardingCompletedAt !== null
  );
  const s2 = s1.filter((e) => e.health.channelLive);
  const s3 = s2.filter((e) => e.health.evidence.everDelivered);
  const s4 = s3.filter((e) => e.health.evidence.ai.activeAgents > 0);

  /* ---------- messaging ---------- */
  const deliveryRate = m.outbound > 0 ? (m.delivered / m.outbound) * 100 : null;
  const failRate = failureRate(m.failed, m.outbound);
  const topClients = [...p.clientRows]
    .filter((row) => row.messaging.outbound > 0)
    .sort((a, b) => b.messaging.outbound - a.messaging.outbound)
    .slice(0, 10);

  /* ---------- revenue (as of now) ---------- */
  // The window's end is the database clock this page was computed at, so
  // "now" here agrees with every windowed figure above it.
  const now = w.end.getTime();
  const mrr = scope.reduce((sum, e) => sum + e.mrr, 0);
  const renewals30 = scope.filter(
    (e) =>
      (e.subStatus === 'active' || e.subStatus === 'past_due') &&
      e.periodEnd !== null &&
      e.periodEnd.getTime() >= now &&
      e.periodEnd.getTime() <= now + 30 * 86_400_000
  ).length;
  const pastDue = scope.filter((e) => e.subStatus === 'past_due').length;

  const scopeLine = (source: ReactNode) => (
    <ScopeLine>
      <span>
        {w.label}: {formatDate(w.start)} – {formatDate(w.end)}
      </span>
      <span aria-hidden>·</span>
      <span>{w.timezone}</span>
      <span aria-hidden>·</span>
      <span>{source}</span>
    </ScopeLine>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Clients"
        title="Portfolio Analytics"
        description="Adoption, messaging, AI, revenue and support across the whole client portfolio — or one plan or account manager's book of clients."
        actions={
          <>
            <Segmented
              label="Reporting period"
              active={period}
              options={(Object.keys(PERIODS) as PeriodKey[]).map((key) => ({
                value: key,
                label: PERIODS[key].label.replace('Last ', ''),
                href: buildHref(current, {
                  period: key === '30d' ? undefined : key,
                }),
              }))}
            />
            {mayExport ? (
              <ButtonLink href={exportHref} prefetch={false}>
                Export CSV
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <FilterBar
        action={buildHref({ period: current.period }, {})}
        hasFilters={filtered}
      >
        {current.period ? (
          <input type="hidden" name="period" value={current.period} />
        ) : null}
        <FilterField label="Plan">
          <Select
            name="plan"
            defaultValue={p.filters.plan ?? ''}
            className="min-w-44"
          >
            <option value="">All plans</option>
            {p.options.plans.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Account manager">
          <Select
            name="manager"
            defaultValue={p.filters.manager ?? ''}
            className="min-w-44"
          >
            <option value="">All managers</option>
            {p.options.managers.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      {filtered ? (
        <Callout tone="info" title="Segment filter on">
          Every figure on this page covers {formatNumber(scope.length)} of{' '}
          {formatNumber(p.fleetSize)} clients
          {planLabel ? ` on ${planLabel}` : ''}
          {managerLabel ? ` managed by ${managerLabel}` : ''}. Tickets with no
          client are excluded while a filter is on.{' '}
          <Link
            href={buildHref({ period: current.period }, {})}
            className="font-semibold underline"
          >
            Show the whole portfolio
          </Link>
        </Callout>
      ) : null}

      {/* ---------------- Clients ---------------- */}
      <Section
        title="Clients"
        scope={scopeLine(
          'Lifecycle derived from onboarding, subscription and health — the same rules as Manage Clients'
        )}
      >
        <StatRow>
          <StatTile
            label="Clients"
            value={formatNumber(scope.length)}
            context="All workspaces in scope"
            href="/clients"
          />
          <StatTile
            label="New in window"
            value={formatNumber(newInWindow.length)}
            context={`Workspaces created since ${formatDate(w.start)}`}
          />
          <StatTile
            label="Active"
            value={formatNumber(active)}
            context="Onboarded, a channel live, nothing critical"
            tone="good"
          />
          <StatTile
            label="Churned"
            value={formatNumber(churned)}
            context="Subscription cancelled or expired (as of now)"
            tone={churned > 0 ? 'warning' : 'neutral'}
          />
        </StatRow>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader
              title="By lifecycle stage"
              description="Current stage, as of now. Pinned stages count where the operator pinned them."
            />
            <CardBody>
              <BarList
                rows={byStage
                  .filter((b) => b.count > 0)
                  .map((b) => ({
                    label: LIFECYCLE_STYLE[b.stage].label,
                    value: b.count,
                    valueLabel: formatNumber(b.count),
                  }))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Activation funnel"
              description="Workspaces created in this window, and how far each got. Each step also requires every step above it."
            />
            <CardBody>
              {cohort.length === 0 ? (
                <p className="text-muted text-sm">
                  No workspaces were created in this window.
                </p>
              ) : (
                <Funnel
                  denominatorLabel={`the ${formatNumber(cohort.length)} workspace${cohort.length === 1 ? '' : 's'} created ${w.label.toLowerCase()}`}
                  steps={[
                    { label: 'Workspace created', count: cohort.length },
                    { label: 'Welcome wizard completed', count: s1.length },
                    {
                      label: 'Channel live',
                      count: s2.length,
                      hint: 'WhatsApp, Instagram or web',
                    },
                    {
                      label: 'First message delivered',
                      count: s3.length,
                      hint: 'confirmed by Meta',
                    },
                    { label: 'AI agent switched on', count: s4.length },
                  ]}
                />
              )}
            </CardBody>
          </Card>
        </div>
      </Section>

      {/* ---------------- Messaging ---------------- */}
      <Section
        title="Messaging"
        scope={scopeLine(
          'Outbound = agent + bot messages; delivered = delivered or read; failed = status failed; deleted messages excluded — the same definitions as each client’s own analytics'
        )}
      >
        <StatRow>
          <StatTile
            label="Outbound"
            value={formatNumber(m.outbound)}
            delta={{
              current: m.outbound,
              previous: m.prevOutbound,
              better: 'up',
              label: deltaLabel,
            }}
          />
          <StatTile
            label="Inbound"
            value={formatNumber(m.inbound)}
            delta={{
              current: m.inbound,
              previous: m.prevInbound,
              better: 'up',
              label: deltaLabel,
            }}
          />
          <StatTile
            label="Delivered"
            value={formatNumber(m.delivered)}
            context={
              deliveryRate === null
                ? 'Nothing sent'
                : `${formatPercent(deliveryRate)} of outbound`
            }
            delta={{
              current: m.delivered,
              previous: m.prevDelivered,
              better: 'up',
              label: deltaLabel,
            }}
          />
          <StatTile
            label="Failed"
            value={formatNumber(m.failed)}
            context={
              failRate === null
                ? 'Nothing sent'
                : `${formatPercent(failRate)} of outbound`
            }
            tone={failRate !== null && failRate >= 10 ? 'warning' : 'neutral'}
            delta={{
              current: m.failed,
              previous: m.prevFailed,
              better: 'down',
              label: deltaLabel,
            }}
          />
        </StatRow>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="Outbound per day"
              description={`By local date in ${w.timezone}. Red is the part of each day’s outbound that failed.`}
            />
            <CardBody>
              <TrendBars
                caption={`Outbound messages per day, ${w.label.toLowerCase()}`}
                series={[
                  {
                    key: 'ok',
                    label: 'Outbound (not failed)',
                    tone: 'primary',
                  },
                  { key: 'failed', label: 'Failed', tone: 'alert' },
                ]}
                points={p.daily.map((d) => ({
                  label: formatDayLabel(`${d.day}T12:00:00Z`),
                  values: {
                    ok: Math.max(d.outbound - d.failed, 0),
                    failed: d.failed,
                  },
                }))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Channel mix"
              description="All messages in the window, in and out, by the conversation’s channel."
            />
            <CardBody>
              {p.channels.length === 0 ? (
                <p className="text-muted text-sm">
                  No messages in this window.
                </p>
              ) : (
                <BarList
                  rows={p.channels.map((c) => ({
                    label:
                      c.channel === 'whatsapp'
                        ? 'WhatsApp'
                        : c.channel === 'instagram'
                          ? 'Instagram'
                          : c.channel === 'web'
                            ? 'Web chat'
                            : c.channel,
                    value: c.messages,
                    valueLabel: formatNumber(c.messages),
                  }))}
                />
              )}
            </CardBody>
          </Card>
        </div>
        <Card>
          <CardHeader
            title="Top clients by outbound"
            description="The ten busiest clients in the window, with their failure rate."
          />
          {topClients.length === 0 ? (
            <EmptyState>No client sent anything in this window.</EmptyState>
          ) : (
            <TableWrap>
              <Table minWidth="44rem">
                <THead>
                  <TR>
                    <TH>Client</TH>
                    <TH align="right">Outbound</TH>
                    <TH align="right">Failed</TH>
                    <TH align="right">Failure rate</TH>
                    <TH align="right">AI-written</TH>
                    <TH>Health now</TH>
                  </TR>
                </THead>
                <TBody>
                  {topClients.map(({ entry, messaging }) => {
                    const rate = failureRate(
                      messaging.failed,
                      messaging.outbound
                    );
                    return (
                      <TR key={entry.accountId}>
                        <TD>
                          <Link
                            href={`/clients/${entry.accountId}/performance`}
                            className="text-ink font-semibold hover:underline"
                          >
                            {entry.name}
                          </Link>
                        </TD>
                        <TD align="right">
                          {formatNumber(messaging.outbound)}
                        </TD>
                        <TD align="right">{formatNumber(messaging.failed)}</TD>
                        <TD align="right">
                          {rate === null ? '—' : formatPercent(rate)}
                        </TD>
                        <TD align="right">
                          {formatNumber(messaging.aiWritten)}
                        </TD>
                        <TD>
                          <HealthBadge state={entry.health.overall} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </Section>

      {/* ---------------- AI ---------------- */}
      <Section
        title="AI"
        scope={scopeLine(
          'Credits = metered usage on platform credits (manual deductions excluded); AI-written = messages an AI agent wrote; handoffs = conversations the bot handed to a human'
        )}
      >
        <StatRow columns={3}>
          <StatTile
            label="Credits consumed"
            value={formatCredits(p.ai.creditsConsumed)}
            context="On our platform key; BYOK workspaces are not metered"
          />
          <StatTile
            label="AI-written messages"
            value={formatNumber(m.aiWritten)}
            context={
              m.outbound > 0
                ? `${formatPercent((m.aiWritten / m.outbound) * 100)} of outbound`
                : 'Nothing sent'
            }
            delta={{
              current: m.aiWritten,
              previous: m.prevAiWritten,
              better: 'up',
              label: deltaLabel,
            }}
          />
          <StatTile
            label="Handoffs to a human"
            value={formatNumber(p.ai.handoffs)}
            context="Conversations where the bot gave up in this window"
          />
        </StatRow>
      </Section>

      {/* ---------------- Revenue ---------------- */}
      {money ? (
        <Section
          title="Revenue"
          scope={
            <ScopeLine>
              <span>
                As of now — not windowed. Subscription history is not recorded,
                so the period above does not move these figures.
              </span>
            </ScopeLine>
          }
        >
          <StatRow>
            <StatTile
              label="MRR"
              value={formatMoney(mrr)}
              context="Active subscriptions, monthly"
            />
            <StatTile
              label="ARR"
              value={formatMoney(mrr * 12)}
              context="MRR × 12"
            />
            <StatTile
              label="Renewals in 30 days"
              value={formatNumber(renewals30)}
              context="Period ends within 30 days"
              href="/subscriptions/renewals?days=30"
            />
            <StatTile
              label="Past due"
              value={formatNumber(pastDue)}
              context="In dunning, still entitled"
              tone={pastDue > 0 ? 'warning' : 'neutral'}
            />
          </StatRow>
          <p className="text-muted text-xs leading-relaxed">
            Per workspace: each workspace’s plan is its owner’s subscription,
            priced from the plan table rather than payments, so the segment rows
            below add up to this total. Figures on Subscriptions &amp; Renewals
            count every subscription row, including any not attached to a
            workspace.
          </p>
        </Section>
      ) : null}

      {/* ---------------- Support ---------------- */}
      <Section
        title="Support"
        scope={scopeLine(
          'Opened = created in the window; resolved = resolved in the window; backlog = open now; SLA attainment = resolved in the window within the resolution target (24×7 clock)'
        )}
      >
        {s.everCreated === 0 ? (
          <Card>
            <EmptyState title="No tickets yet">
              Support metrics appear once tickets are raised on the Support Desk
              {filtered ? ' for these clients' : ''}.
            </EmptyState>
          </Card>
        ) : (
          <StatRow columns={5}>
            <StatTile
              label="Opened"
              value={formatNumber(s.opened)}
              href="/support"
            />
            <StatTile label="Resolved" value={formatNumber(s.resolved)} />
            <StatTile
              label="Backlog now"
              value={formatNumber(s.backlog)}
              tone={s.backlog > 0 ? 'warning' : 'good'}
              href="/support"
            />
            <StatTile
              label="Mean time to resolve"
              value={
                s.resolved > 0 ? formatDuration(s.meanResolveMinutes) : '—'
              }
              context={
                s.resolved > 0
                  ? `Over ${formatNumber(s.resolved)} resolved`
                  : 'Nothing resolved in this window'
              }
            />
            <StatTile
              label="SLA attainment"
              value={
                s.resolvedWithSla > 0
                  ? formatPercent((s.slaMet / s.resolvedWithSla) * 100, 0)
                  : '—'
              }
              context={
                s.resolvedWithSla > 0
                  ? `${formatNumber(s.slaMet)} of ${formatNumber(s.resolvedWithSla)} within target`
                  : 'No resolved ticket with a target'
              }
            />
          </StatRow>
        )}
      </Section>

      {/* ---------------- Segments ---------------- */}
      <Section
        title="Segments"
        scope={scopeLine(
          'Clients and tickets as of now; outbound and failure rate in the window'
        )}
      >
        <div className="grid gap-6 xl:grid-cols-2">
          <SegmentTable
            title="By plan"
            rows={p.byPlan}
            money={money}
            linkFor={(row) => buildHref(current, { plan: row.key })}
          />
          <SegmentTable
            title="By account manager"
            rows={p.byManager}
            money={money}
            linkFor={(row) => buildHref(current, { manager: row.key })}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  scope,
  children,
}: {
  title: string;
  scope: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2">
        <h2 className="text-ink text-lg font-bold tracking-tight">{title}</h2>
      </div>
      {scope}
      {children}
    </section>
  );
}

function SegmentTable({
  title,
  rows,
  money,
  linkFor,
}: {
  title: string;
  rows: SegmentRow[];
  money: boolean;
  linkFor: (row: SegmentRow) => string;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description="Select a row to narrow the whole page to that segment."
      />
      {rows.length === 0 ? (
        <EmptyState>No clients in scope.</EmptyState>
      ) : (
        <TableWrap>
          <Table minWidth="34rem">
            <THead>
              <TR>
                <TH>Segment</TH>
                <TH align="right">Clients</TH>
                {money ? <TH align="right">MRR</TH> : null}
                <TH align="right">Outbound</TH>
                <TH align="right">Failure</TH>
                <TH align="right">Open tickets</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => {
                const rate = failureRate(row.failed, row.outbound);
                return (
                  <TR key={row.key}>
                    <TD>
                      <Link
                        href={linkFor(row)}
                        className="text-ink font-semibold hover:underline"
                      >
                        {row.label}
                      </Link>
                    </TD>
                    <TD align="right">{formatNumber(row.clients)}</TD>
                    {money ? (
                      <TD align="right">{formatMoney(row.mrr)}</TD>
                    ) : null}
                    <TD align="right">{formatNumber(row.outbound)}</TD>
                    <TD align="right">
                      {rate === null ? '—' : formatPercent(rate)}
                    </TD>
                    <TD align="right">{formatNumber(row.openTickets)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      )}
      {money ? (
        <div className="px-5 pb-4">
          <DerivedNote>
            MRR is derived from plan prices as of now, not from payments.
          </DerivedNote>
        </div>
      ) : null}
    </Card>
  );
}
