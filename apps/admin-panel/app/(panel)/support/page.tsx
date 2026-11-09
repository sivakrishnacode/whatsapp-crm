import type { Metadata } from 'next';
import Link from 'next/link';

import {
  CATEGORY_LABEL,
  SEVERITY_STYLE,
  SeverityBadge,
  SlaBadge,
  TIER_LABEL,
  TicketStatusBadge,
} from '@/components/ops/badges';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input, Select } from '@/components/ui/form';
import {
  ButtonLink,
  PageHeader,
  ScopeLine,
  Segmented,
} from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
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
import { adminTimezone } from '@/lib/env';
import { formatAgo, formatNumber } from '@/lib/format';
import { listStaff } from '@/lib/queries/staff';
import {
  TICKET_QUEUES,
  deskStats,
  listTickets,
  type TicketQueue,
} from '@/lib/queries/tickets';
import {
  SEVERITIES,
  TICKET_CATEGORIES,
  TICKET_TIERS,
  activeClock,
} from '@/lib/sla';

export const metadata: Metadata = {
  title: 'Support Desk · Converse360 Control Center',
};

type Search = {
  queue?: string;
  tier?: string;
  severity?: string;
  category?: string;
  accountId?: string;
  assignee?: string;
  q?: string;
  page?: string;
};

const QUEUE_LABEL: Record<TicketQueue, string> = {
  open: 'All open',
  mine: 'Mine',
  unassigned: 'Unassigned',
  breached: 'SLA breached',
  resolved: 'Resolved',
  all: 'Everything',
};

function humanMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / (60 * 24)).toFixed(1)} d`;
}

/**
 * The unified support queue (C360-032): one list for tickets from staff,
 * monitoring (the incident monitor) and onboarding, ordered by urgency —
 * breached first, then severity, then the soonest-due clock.
 */
export default async function SupportDeskPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const staff = await requireCapability('tickets.work');
  const params = await searchParams;

  const queue: TicketQueue = (TICKET_QUEUES as readonly string[]).includes(
    params.queue ?? ''
  )
    ? (params.queue as TicketQueue)
    : 'open';
  const filters = {
    tier: (TICKET_TIERS as readonly string[]).includes(params.tier ?? '')
      ? params.tier
      : undefined,
    severity: (SEVERITIES as string[]).includes(params.severity ?? '')
      ? params.severity
      : undefined,
    category: (TICKET_CATEGORIES as readonly string[]).includes(
      params.category ?? ''
    )
      ? params.category
      : undefined,
    accountId: params.accountId || undefined,
    assignee: params.assignee || undefined,
    q: params.q?.trim() || undefined,
  };
  const page = Math.max(Number(params.page) || 1, 1);

  const [list, stats, staffList] = await Promise.all([
    listTickets({ queue, staffId: staff.id, page, ...filters }),
    deskStats(staff.id),
    listStaff({ activeOnly: true }),
  ]);

  const now = new Date();
  const hasFilters = Object.values(filters).some(Boolean);
  const keep = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...filters, ...extra })) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    return qs ? `/support?${qs}` : '/support';
  };
  const slaRate =
    stats.resolved30d > 0
      ? Math.round((stats.resolvedWithinSla30d / stats.resolved30d) * 100)
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support Desk"
        description="Every ticket — raised by staff, opened from the incident monitor or the onboarding queue — in one queue, most urgent first."
        actions={
          <ButtonLink href="/support/new" variant="primary">
            New ticket
          </ButtonLink>
        }
      />

      <StatRow columns={5}>
        <StatTile
          label="Open"
          value={formatNumber(stats.open)}
          context={`${formatNumber(stats.escalated)} escalated`}
          href="/support"
        />
        <StatTile
          label="Unassigned"
          value={formatNumber(stats.unassigned)}
          tone={stats.unassigned > 0 ? 'warning' : 'neutral'}
          context="Open tickets nobody owns"
          href="/support?queue=unassigned"
        />
        <StatTile
          label="SLA breached"
          value={formatNumber(stats.breached)}
          tone={stats.breached > 0 ? 'critical' : 'good'}
          context="A running clock past its due time"
          href="/support?queue=breached"
        />
        <StatTile
          label="Waiting on customer"
          value={formatNumber(stats.waitingCustomer)}
          context="The clock keeps running"
        />
        <StatTile
          label="Mean resolution"
          value={humanMinutes(stats.meanResolutionMinutes)}
          context={
            stats.resolved30d > 0
              ? `${formatNumber(stats.resolved30d)} resolved in 30 days · ${slaRate}% within SLA`
              : 'Nothing resolved in the last 30 days'
          }
        />
      </StatRow>

      <ScopeLine>
        <span>
          SLA clocks run 24×7 and do not pause while waiting on the customer.
        </span>
        <span aria-hidden>·</span>
        <span>Times in {adminTimezone()}</span>
      </ScopeLine>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Queue"
          active={queue}
          options={TICKET_QUEUES.map((value) => ({
            value,
            label:
              value === 'mine'
                ? `${QUEUE_LABEL[value]}${stats.mine ? ` (${stats.mine})` : ''}`
                : QUEUE_LABEL[value],
            href: keep({ queue: value === 'open' ? undefined : value }),
          }))}
        />
      </div>

      <FilterBar action="/support" hasFilters={hasFilters}>
        {queue !== 'open' ? (
          <input type="hidden" name="queue" value={queue} />
        ) : null}
        {filters.accountId ? (
          <input type="hidden" name="accountId" value={filters.accountId} />
        ) : null}
        <FilterField label="Search" className="min-w-56 flex-1">
          <Input
            name="q"
            type="search"
            defaultValue={filters.q ?? ''}
            placeholder="SUP-1042, subject, client, requester"
          />
        </FilterField>
        <FilterField label="Tier">
          <Select name="tier" defaultValue={filters.tier ?? ''}>
            <option value="">Any</option>
            {TICKET_TIERS.map((value) => (
              <option key={value} value={value}>
                {TIER_LABEL[value]}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Severity">
          <Select name="severity" defaultValue={filters.severity ?? ''}>
            <option value="">Any</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_STYLE[value].label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Category">
          <Select name="category" defaultValue={filters.category ?? ''}>
            <option value="">Any</option>
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABEL[value]}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Assignee">
          <Select name="assignee" defaultValue={filters.assignee ?? ''}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {staffList.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title={QUEUE_LABEL[queue]}
          description={
            filters.accountId
              ? 'Filtered to one client.'
              : queue === 'resolved'
                ? 'Newest resolution first.'
                : 'Breached first, then by severity, then by the soonest-due clock.'
          }
          action={
            filters.accountId ? (
              <Link
                href={keep({
                  accountId: undefined,
                  queue: queue === 'open' ? undefined : queue,
                })}
                className="text-muted hover:text-ink text-xs font-medium underline-offset-2 hover:underline"
              >
                Show all clients
              </Link>
            ) : undefined
          }
        />
        {list.rows.length === 0 ? (
          <EmptyState
            title={
              queue === 'breached'
                ? 'Nothing is breaching its SLA'
                : queue === 'mine'
                  ? 'Nothing assigned to you'
                  : 'No tickets here'
            }
          >
            {queue === 'mine' && !staff.id
              ? 'The break-glass login cannot own tickets, so this queue is always empty for it.'
              : hasFilters
                ? 'Nothing matches these filters. Clear them to see the whole queue.'
                : 'New tickets appear here — open one from a client, the incident monitor or the onboarding queue.'}
          </EmptyState>
        ) : (
          <>
            <TableWrap>
              <Table minWidth="64rem">
                <THead>
                  <tr>
                    <TH>Ticket</TH>
                    <TH>Client</TH>
                    <TH>Severity</TH>
                    <TH>Tier</TH>
                    <TH>Status</TH>
                    <TH>Assignee</TH>
                    <TH>SLA</TH>
                    <TH align="right">Age</TH>
                  </tr>
                </THead>
                <TBody>
                  {list.rows.map((ticket) => {
                    const { kind, clock } = activeClock(
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
                    return (
                      <TR key={ticket.id}>
                        <TD className="max-w-[22rem]">
                          <Link
                            href={`/support/${ticket.number}`}
                            className="text-ink block truncate font-semibold underline-offset-2 hover:underline"
                          >
                            {ticket.subject}
                          </Link>
                          <span className="text-muted text-xs">
                            SUP-{ticket.number} ·{' '}
                            {CATEGORY_LABEL[ticket.category] ?? ticket.category}
                          </span>
                        </TD>
                        <TD>
                          {ticket.accountId ? (
                            <Link
                              href={`/clients/${ticket.accountId}`}
                              className="text-ink-2 underline-offset-2 hover:underline"
                            >
                              {ticket.accountName ?? 'Unnamed workspace'}
                            </Link>
                          ) : (
                            <span className="text-muted">
                              {ticket.accountName
                                ? `${ticket.accountName} (deleted)`
                                : 'Internal'}
                            </span>
                          )}
                        </TD>
                        <TD>
                          <SeverityBadge severity={ticket.severity} />
                        </TD>
                        <TD className="text-ink-2">
                          {TIER_LABEL[ticket.tier] ?? ticket.tier}
                        </TD>
                        <TD>
                          <TicketStatusBadge status={ticket.status} />
                        </TD>
                        <TD className="text-ink-2">
                          {ticket.assigneeName ?? (
                            <span className="text-muted">Unassigned</span>
                          )}
                        </TD>
                        <TD>
                          <span className="flex flex-col items-start gap-0.5">
                            <SlaBadge clock={clock} />
                            <span className="text-muted text-[11px]">
                              {kind === 'first_response'
                                ? 'first response'
                                : 'resolution'}
                            </span>
                          </span>
                        </TD>
                        <TD align="right" className="text-muted text-xs">
                          {formatAgo(ticket.createdAt)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              basePath="/support"
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              perPage={list.perPage}
              params={{
                ...filters,
                queue: queue === 'open' ? undefined : queue,
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}
