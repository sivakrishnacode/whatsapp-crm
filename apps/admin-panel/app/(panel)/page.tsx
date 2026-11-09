import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  HealthBadge,
  LifecycleBadge,
  SeverityBadge,
  SlaBadge,
} from '@/components/ops/badges';
import { StatusBadge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import {
  ButtonLink,
  Callout,
  MiniStat,
  PageHeader,
  ScopeLine,
} from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import {
  formatAgo,
  formatCredits,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import type { HealthCheck } from '@/lib/health/rules';
import {
  getOverview,
  openTasksFor,
  openTickets,
  type OpenTicket,
} from '@/lib/queries/overview';
import { getRoster, type RosterEntry } from '@/lib/queries/roster';
import { getSettings } from '@/lib/settings-store';
import { activeClock } from '@/lib/sla';

export const metadata: Metadata = {
  title: 'Overview · Converse360 Control Center',
};

/**
 * The operations dashboard (C360-033) — what needs a person, right now.
 *
 * Ordered by urgency rather than by module: the tile row says how much of
 * each kind of trouble exists, "My work" is what the signed-in staff member
 * owns, then the four queues an operator works from. Every count links to
 * the list it counts, and every list item links to the client or ticket.
 *
 * Health and lifecycle come from the shared roster (lib/queries/roster.ts),
 * so a workspace reads the same here as on every other screen in this
 * render. Money appears only for roles with `billing.read`.
 */

const DAY = 86_400_000;
const LIST_LIMIT = 8;

type Incident = { entry: RosterEntry; check: HealthCheck };

function clockOf(ticket: OpenTicket, now: Date) {
  return activeClock(
    {
      status: ticket.status,
      created_at: ticket.createdAt,
      first_response_due_at: ticket.firstResponseDueAt,
      first_responded_at: ticket.firstRespondedAt,
      resolution_due_at: ticket.resolutionDueAt,
      resolved_at: ticket.resolvedAt,
    },
    now
  );
}

export default async function OverviewPage() {
  const staff = await requireCapability('clients.read');
  const money = can(staff, 'billing.read');
  const worksTickets = can(staff, 'tickets.work');

  const [roster, settings, tickets, myTasks, revenue] = await Promise.all([
    getRoster(),
    getSettings(),
    worksTickets ? openTickets() : Promise.resolve([] as OpenTicket[]),
    staff.id ? openTasksFor(staff.id) : Promise.resolve([]),
    money ? getOverview() : Promise.resolve(null),
  ]);

  const now = new Date();
  const evaluatedAt = roster[0]?.health.evaluatedAt ?? now;

  /* ---------- incidents ---------- */
  const critical: Incident[] = roster
    .flatMap((entry) =>
      entry.health.checks
        .filter((check) => check.state === 'critical')
        .map((check) => ({ entry, check }))
    )
    .sort(
      (a, b) =>
        (b.check.checkedAt?.getTime() ?? 0) -
        (a.check.checkedAt?.getTime() ?? 0)
    );
  const criticalClients = new Set(critical.map((i) => i.entry.accountId)).size;
  const attentionChecks = roster.reduce(
    (sum, entry) =>
      sum + entry.health.checks.filter((c) => c.state === 'attention').length,
    0
  );

  /* ---------- clients ---------- */
  const needsAttention = roster.filter(
    (e) => e.lifecycle.stage === 'attention'
  );
  const stalled = roster
    .filter(
      (e) =>
        e.lifecycle.stage === 'onboarding' &&
        !e.lifecycle.pinned &&
        now.getTime() - e.createdAt.getTime() >=
          settings.stalledOnboardingDays * DAY
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  /* ---------- tickets ---------- */
  const withClocks = tickets.map((ticket) => ({
    ticket,
    sla: clockOf(ticket, now),
  }));
  const breached = withClocks.filter((t) => t.sla.clock.state === 'breached');
  const unassigned = withClocks.filter((t) => t.ticket.assigneeId === null);
  const mine = staff.id
    ? withClocks.filter((t) => t.ticket.assigneeId === staff.id)
    : [];

  /* ---------- renewals ---------- */
  const windowEnd = now.getTime() + settings.renewalWindowDays * DAY;
  const renewals = roster
    .filter(
      (e) =>
        (e.subStatus === 'active' || e.subStatus === 'past_due') &&
        e.periodEnd !== null &&
        e.periodEnd.getTime() >= now.getTime() &&
        e.periodEnd.getTime() <= windowEnd
    )
    .sort((a, b) => a.periodEnd!.getTime() - b.periodEnd!.getTime());

  /* ---------- credits ---------- */
  // Only workspaces that would actually be answered from the wallet: on our
  // key (or no AI config yet, which defaults to platform) with an agent on.
  const lowCredits = roster.filter((e) => {
    const ai = e.health.evidence.ai;
    return (
      ai.creditMode !== 'byok' &&
      ai.activeAgents > 0 &&
      (ai.balance ?? 0) <= settings.lowCreditThreshold
    );
  });
  const emptyWithAutoReply = lowCredits.filter((e) => {
    const ai = e.health.evidence.ai;
    return (ai.balance ?? 0) === 0 && ai.autoReplyAgents > 0;
  });

  const myClients = staff.id
    ? roster.filter(
        (e) =>
          e.managerId === staff.id &&
          e.health.overall !== 'healthy' &&
          e.health.overall !== 'not_configured'
      )
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="What needs a person right now, across every client — incidents, tickets, onboarding, renewals and credits."
        actions={
          worksTickets ? (
            <ButtonLink href="/support/new" variant="primary">
              New ticket
            </ButtonLink>
          ) : null
        }
      />

      <ScopeLine>
        <span>
          {formatNumber(roster.length)} client
          {roster.length === 1 ? '' : 's'}
        </span>
        <span aria-hidden>·</span>
        <span>Health evaluated {formatDateTime(evaluatedAt)}</span>
        <span aria-hidden>·</span>
        <span>Times in {adminTimezone()}</span>
        <span aria-hidden>·</span>
        <span>Health is judged from stored evidence, not live probes</span>
      </ScopeLine>

      <StatRow columns={6}>
        <StatTile
          label="Critical incidents"
          value={formatNumber(critical.length)}
          context={
            critical.length > 0
              ? `${formatNumber(criticalClients)} client${criticalClients === 1 ? '' : 's'} · ${formatNumber(attentionChecks)} more need attention`
              : `${formatNumber(attentionChecks)} check${attentionChecks === 1 ? '' : 's'} need attention`
          }
          tone={critical.length > 0 ? 'critical' : 'good'}
          href="/incidents"
        />
        <StatTile
          label="Needs attention"
          value={formatNumber(needsAttention.length)}
          context="Live clients with a critical check or a failed payment"
          tone={needsAttention.length > 0 ? 'warning' : 'neutral'}
          href="/clients?stage=attention"
        />
        <StatTile
          label="Stalled onboarding"
          value={formatNumber(stalled.length)}
          context={`Onboarding for ${settings.stalledOnboardingDays}+ days`}
          tone={stalled.length > 0 ? 'warning' : 'neutral'}
          href="/onboarding"
        />
        {worksTickets ? (
          <StatTile
            label="Open tickets"
            value={formatNumber(tickets.length)}
            context={`${formatNumber(breached.length)} breaching SLA · ${formatNumber(unassigned.length)} unassigned`}
            tone={
              breached.length > 0
                ? 'critical'
                : unassigned.length > 0
                  ? 'warning'
                  : 'neutral'
            }
            href="/support"
          />
        ) : null}
        <StatTile
          label="Renewals due"
          value={formatNumber(renewals.length)}
          context={`Period ends within ${settings.renewalWindowDays} days`}
          href={
            money
              ? `/subscriptions/renewals?days=${settings.renewalWindowDays}`
              : undefined
          }
        />
        <StatTile
          label="Low AI credits"
          value={formatNumber(lowCredits.length)}
          context={
            emptyWithAutoReply.length > 0
              ? `${formatNumber(emptyWithAutoReply.length)} empty with auto-reply on — bot silent`
              : `At or below ${formatCredits(settings.lowCreditThreshold)} credits, agent on`
          }
          tone={
            emptyWithAutoReply.length > 0
              ? 'critical'
              : lowCredits.length > 0
                ? 'warning'
                : 'neutral'
          }
          href={money ? '/credits' : undefined}
        />
      </StatRow>

      {revenue ? (
        <Card>
          <CardHeader
            eyebrow="Revenue"
            title="Recurring revenue, as of now"
            action={
              <ButtonLink
                href="/subscriptions/revenue"
                size="sm"
                variant="ghost"
              >
                Revenue detail →
              </ButtonLink>
            }
          />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 py-4 md:grid-cols-4">
            <MiniStat
              label="MRR"
              value={formatMoney(revenue.subscriptions.mrr)}
              hint={`${formatNumber(revenue.subscriptions.paying)} paying`}
            />
            <MiniStat
              label="ARR"
              value={formatMoney(revenue.subscriptions.mrr * 12)}
              hint="MRR × 12"
            />
            <MiniStat
              label="At risk (past due)"
              value={formatMoney(revenue.subscriptions.atRiskMrr)}
              hint={`${formatNumber(revenue.subscriptions.pastDue)} in dunning, still entitled`}
            />
            <MiniStat
              label="Trial pipeline"
              value={formatMoney(revenue.subscriptions.trialMrr)}
              hint={`${formatNumber(revenue.subscriptions.trial)} on trial, per month if they convert`}
            />
          </div>
          <div className="px-5 pb-4">
            <DerivedNote>
              Derived from plan prices, not payments — this database keeps no
              invoice record, so these are what the current subscriptions are
              worth, not what was collected. MRR counts active subscriptions
              only.
            </DerivedNote>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          eyebrow="My work"
          title={`Assigned to ${staff.isBreakGlass ? 'you' : staff.name}`}
          description="Tickets you own, follow-ups you were given, and the clients you manage that are not healthy."
        />
        {staff.id === null ? (
          <div className="px-5 py-4">
            <Callout tone="info" title="Break-glass login">
              This login is not a staff member, so nothing can be assigned to
              it. Create a staff account in Staff &amp; Access for day-to-day
              work.
            </Callout>
          </div>
        ) : (
          <div className="divide-line grid divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            <WorkColumn
              title="My open tickets"
              count={mine.length}
              href={worksTickets ? '/support?queue=mine' : undefined}
              empty="No tickets assigned to you."
            >
              {mine.slice(0, LIST_LIMIT).map(({ ticket, sla }) => (
                <TicketItem key={ticket.id} ticket={ticket} sla={sla} />
              ))}
            </WorkColumn>
            <WorkColumn
              title="My follow-ups"
              count={myTasks.length}
              empty="No open tasks assigned to you."
            >
              {myTasks.slice(0, LIST_LIMIT).map((task) => {
                const overdue =
                  task.dueOn !== null &&
                  task.dueOn.getTime() + DAY <= now.getTime();
                return (
                  <li key={task.id} className="px-5 py-2.5">
                    <Link
                      href={`/clients/${task.accountId}`}
                      className="text-ink text-sm font-medium hover:underline"
                    >
                      {task.title}
                    </Link>
                    <p className="text-muted mt-0.5 text-xs">
                      {task.accountName} ·{' '}
                      {task.dueOn ? (
                        <span
                          className={overdue ? 'text-bad-fg font-semibold' : ''}
                        >
                          {overdue ? '▲ overdue, ' : ''}due{' '}
                          {formatDate(task.dueOn)}
                        </span>
                      ) : (
                        'no due date'
                      )}
                    </p>
                  </li>
                );
              })}
            </WorkColumn>
            <WorkColumn
              title="My clients needing care"
              count={myClients.length}
              href={`/clients?manager=${staff.id}`}
              empty="Every client you manage is healthy or not yet configured."
            >
              {myClients.slice(0, LIST_LIMIT).map((entry) => (
                <li
                  key={entry.accountId}
                  className="flex items-center justify-between gap-3 px-5 py-2.5"
                >
                  <Link
                    href={`/clients/${entry.accountId}`}
                    className="text-ink min-w-0 truncate text-sm font-medium hover:underline"
                  >
                    {entry.name}
                  </Link>
                  <HealthBadge state={entry.health.overall} />
                </li>
              ))}
            </WorkColumn>
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Critical incidents"
            description="Checks graded critical right now, newest evidence first."
            action={
              <ButtonLink href="/incidents" size="sm" variant="ghost">
                All incidents →
              </ButtonLink>
            }
          />
          {critical.length === 0 ? (
            <EmptyState title="Nothing critical">
              No check is critical across {formatNumber(roster.length)} clients.
              Anything that turns critical appears here first.
            </EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {critical.slice(0, LIST_LIMIT).map(({ entry, check }) => (
                <li
                  key={`${entry.accountId}-${check.key}`}
                  className="px-5 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/clients/${entry.accountId}`}
                      className="text-ink text-sm font-semibold hover:underline"
                    >
                      {entry.name}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="text-muted text-xs">{check.label}</span>
                      <HealthBadge state={check.state} />
                    </span>
                  </div>
                  <p className="text-ink-2 mt-1 text-xs leading-relaxed">
                    {check.evidence}
                  </p>
                  <p className="text-muted mt-0.5 text-[11px]">
                    Evidence{' '}
                    {check.checkedAt
                      ? formatAgo(check.checkedAt)
                      : 'has no timestamp'}
                    {entry.managerName
                      ? ` · ${entry.managerName}`
                      : ' · no account manager'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {worksTickets ? (
          <Card>
            <CardHeader
              title="Unassigned tickets"
              description="Open tickets nobody owns, most severe first."
              action={
                <ButtonLink
                  href="/support?queue=unassigned"
                  size="sm"
                  variant="ghost"
                >
                  Support Desk →
                </ButtonLink>
              }
            />
            {unassigned.length === 0 ? (
              <EmptyState title="Every ticket has an owner">
                New tickets without an assignee appear here.
              </EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {unassigned.slice(0, LIST_LIMIT).map(({ ticket, sla }) => (
                  <TicketItem key={ticket.id} ticket={ticket} sla={sla} />
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Renewals due"
            description={`Current periods ending in the next ${settings.renewalWindowDays} days, soonest first.`}
            action={
              money ? (
                <ButtonLink
                  href={`/subscriptions/renewals?days=${settings.renewalWindowDays}`}
                  size="sm"
                  variant="ghost"
                >
                  Watchlist →
                </ButtonLink>
              ) : null
            }
          />
          {renewals.length === 0 ? (
            <EmptyState title="No renewals in the window">
              Nothing renews in the next {settings.renewalWindowDays} days.
            </EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {renewals.slice(0, LIST_LIMIT).map((entry) => (
                <li
                  key={entry.accountId}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/clients/${entry.accountId}`}
                      className="text-ink text-sm font-semibold hover:underline"
                    >
                      {entry.name}
                    </Link>
                    <p className="text-muted mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                      <span>{entry.planDisplayName ?? 'No plan'}</span>
                      <StatusBadge status={entry.subStatus} />
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-ink font-semibold">
                      {formatDate(entry.periodEnd)}
                    </p>
                    <p className="text-muted">
                      {formatRelativeDays(entry.periodEnd)}
                      {money ? ` · ${formatMoney(entry.mrr)}/mo` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Stalled onboarding"
            description={`Still onboarding ${settings.stalledOnboardingDays}+ days after the workspace was created, oldest first.`}
            action={
              <ButtonLink href="/onboarding" size="sm" variant="ghost">
                Onboarding queue →
              </ButtonLink>
            }
          />
          {stalled.length === 0 ? (
            <EmptyState title="Nobody is stuck">
              Workspaces still onboarding after {settings.stalledOnboardingDays}{' '}
              days appear here.
            </EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {stalled.slice(0, LIST_LIMIT).map((entry) => (
                <li key={entry.accountId} className="px-5 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/clients/${entry.accountId}`}
                      className="text-ink text-sm font-semibold hover:underline"
                    >
                      {entry.name}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="text-muted tabular text-xs">
                        {entry.health.completion.percent}% set up
                      </span>
                      <LifecycleBadge stage={entry.lifecycle.stage} />
                    </span>
                  </div>
                  <p className="text-muted mt-0.5 text-xs">
                    {entry.lifecycle.because} Created{' '}
                    {formatRelativeDays(entry.createdAt)}
                    {entry.managerName
                      ? ` · ${entry.managerName}`
                      : ' · no account manager'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function WorkColumn({
  title,
  count,
  href,
  empty,
  children,
}: {
  title: string;
  count: number;
  href?: string;
  empty: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
        <h3 className="text-ink-2 text-xs font-semibold tracking-wide uppercase">
          {title}{' '}
          <span className="text-muted tabular font-normal">({count})</span>
        </h3>
        {href && count > 0 ? (
          <Link
            href={href}
            className="text-primary text-xs font-semibold hover:underline"
          >
            View all
          </Link>
        ) : null}
      </div>
      {count === 0 ? (
        <p className="text-muted px-5 pb-5 text-sm">{empty}</p>
      ) : (
        <ul className="divide-line divide-y pb-2">{children}</ul>
      )}
    </div>
  );
}

function TicketItem({
  ticket,
  sla,
}: {
  ticket: OpenTicket;
  sla: ReturnType<typeof activeClock>;
}) {
  return (
    <li className="px-5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/support/${ticket.number}`}
          className="text-ink min-w-0 truncate text-sm font-semibold hover:underline"
        >
          <span className="text-muted tabular font-normal">
            #{ticket.number}
          </span>{' '}
          {ticket.subject}
        </Link>
        <span className="flex items-center gap-1.5">
          <SeverityBadge severity={ticket.severity} />
          <SlaBadge clock={sla.clock} />
        </span>
      </div>
      <p className="text-muted mt-0.5 text-xs">
        {ticket.accountName ?? 'No client'} · {ticket.tier} ·{' '}
        {sla.kind === 'first_response' ? 'first response' : 'resolution'} ·
        opened {formatAgo(ticket.createdAt)}
      </p>
    </li>
  );
}
