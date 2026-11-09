import type { Metadata } from 'next';
import Link from 'next/link';

import { HealthBadge, LifecycleBadge } from '@/components/ops/badges';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Select } from '@/components/ui/form';
import { ButtonLink, PageHeader, ScopeLine } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import {
  isIncident,
  type HealthCategory,
  type HealthCheck,
} from '@/lib/health/rules';
import { formatAgo, formatDateTime, formatNumber } from '@/lib/format';
import { getRoster, type RosterEntry } from '@/lib/queries/roster';
import { listStaff } from '@/lib/queries/staff';
import { openIncidentTickets } from '@/lib/queries/tickets';

export const metadata: Metadata = {
  title: 'Incident Monitor · Converse360 Control Center',
};

const CATEGORY_LABEL: Record<HealthCategory, string> = {
  meta: 'Meta / WhatsApp',
  messaging: 'Message delivery',
  templates: 'Templates',
  channels: 'Instagram / web',
  integrations: 'Integrations / API',
  ai: 'AI & credits',
  billing: 'Billing',
};

type Row = { entry: RosterEntry; check: HealthCheck };

type Search = { state?: string; category?: string; manager?: string };

/**
 * Every health check across the fleet that needs someone to act (C360-033):
 * critical first, then attention, oldest evidence first within each — the
 * longest-standing problem is the one most likely to have been forgotten.
 *
 * Unknown checks are listed separately and collapsed: unknown is not
 * healthy, but "we cannot see" is a different job from "it is broken", and
 * mixing them would bury the real incidents.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const staff = await requireCapability('clients.read');
  const params = await searchParams;
  const canTicket = can(staff, 'tickets.work');

  const [roster, ticketed, staffList] = await Promise.all([
    getRoster(),
    openIncidentTickets(),
    listStaff({ activeOnly: true }),
  ]);

  const state =
    params.state === 'critical' || params.state === 'attention'
      ? params.state
      : undefined;
  const category =
    params.category && Object.hasOwn(CATEGORY_LABEL, params.category)
      ? (params.category as HealthCategory)
      : undefined;
  const manager = params.manager || undefined;

  const scoped = roster.filter((entry) =>
    manager === 'none'
      ? entry.managerId === null
      : manager
        ? entry.managerId === manager
        : true
  );

  const incidents: Row[] = [];
  const unknown: Row[] = [];
  for (const entry of scoped) {
    // Archived clients are out of the portfolio on purpose.
    if (entry.lifecycle.stage === 'archived') continue;
    for (const check of entry.health.checks) {
      if (category && check.category !== category) continue;
      if (isIncident(check)) {
        if (!state || check.state === state) incidents.push({ entry, check });
      } else if (check.state === 'unknown' && !state) {
        unknown.push({ entry, check });
      }
    }
  }

  const byAge = (a: Row, b: Row) =>
    (a.check.checkedAt?.getTime() ?? 0) - (b.check.checkedAt?.getTime() ?? 0);
  incidents.sort((a, b) =>
    a.check.state === b.check.state
      ? byAge(a, b)
      : a.check.state === 'critical'
        ? -1
        : 1
  );
  unknown.sort(byAge);

  const critical = incidents.filter((r) => r.check.state === 'critical');
  const attention = incidents.filter((r) => r.check.state === 'attention');
  const clientsAffected = new Set(incidents.map((r) => r.entry.accountId));
  const untracked = incidents.filter(
    (r) => !ticketed.has(`${r.entry.accountId}:${r.check.key}`)
  );
  const evaluatedAt = roster[0]?.health.evaluatedAt ?? new Date();
  const hasFilters = Boolean(state || category || manager);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incident Monitor"
        description="Health checks across every client that are critical or need attention, with the evidence behind each and whether someone is already on it."
      />

      <StatRow columns={5}>
        <StatTile
          label="Critical"
          value={formatNumber(critical.length)}
          tone={critical.length > 0 ? 'critical' : 'good'}
          href="/incidents?state=critical"
        />
        <StatTile
          label="Needs attention"
          value={formatNumber(attention.length)}
          tone={attention.length > 0 ? 'warning' : 'neutral'}
          href="/incidents?state=attention"
        />
        <StatTile
          label="Clients affected"
          value={formatNumber(clientsAffected.size)}
          context={`of ${formatNumber(scoped.length)} in scope`}
        />
        <StatTile
          label="Without a ticket"
          value={formatNumber(untracked.length)}
          tone={untracked.length > 0 ? 'warning' : 'neutral'}
          context="Nobody has opened a ticket for these"
        />
        <StatTile
          label="Unknown / stale"
          value={formatNumber(unknown.length)}
          context="Evidence missing or too old to judge"
        />
      </StatRow>

      <ScopeLine>
        <span>
          Evaluated {formatDateTime(evaluatedAt)} ({adminTimezone()}) from
          stored evidence; live probes run in the API&apos;s own jobs.
        </span>
      </ScopeLine>

      <FilterBar action="/incidents" hasFilters={hasFilters}>
        <FilterField label="State">
          <Select name="state" defaultValue={state ?? ''}>
            <option value="">Critical and attention</option>
            <option value="critical">Critical only</option>
            <option value="attention">Attention only</option>
          </Select>
        </FilterField>
        <FilterField label="Area">
          <Select name="category" defaultValue={category ?? ''}>
            <option value="">Every area</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Account manager">
          <Select name="manager" defaultValue={manager ?? ''}>
            <option value="">Anyone</option>
            <option value="none">No manager</option>
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
          title="Open incidents"
          description="Critical first, then attention; the oldest evidence first within each."
        />
        {incidents.length === 0 ? (
          <EmptyState title="Nothing needs action">
            {hasFilters
              ? 'No incidents match these filters.'
              : 'No client has a critical or attention check right now. New ones appear here as the API’s jobs record them.'}
          </EmptyState>
        ) : (
          <ul className="divide-line divide-y">
            {incidents.map((row) => (
              <IncidentRow
                key={`${row.entry.accountId}:${row.check.key}`}
                row={row}
                ticket={ticketed.get(`${row.entry.accountId}:${row.check.key}`)}
                canTicket={canTicket}
              />
            ))}
          </ul>
        )}
      </Card>

      {unknown.length > 0 ? (
        <Card>
          <details>
            <summary className="hover:bg-surface-2 flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="text-ink block text-[15px] font-semibold">
                  Unknown or stale evidence ({formatNumber(unknown.length)})
                </span>
                <span className="text-muted mt-1 block text-xs">
                  Not incidents — but not healthy either. Each is a check we
                  cannot currently see through.
                </span>
              </span>
              <span className="text-muted text-xs font-medium">Show</span>
            </summary>
            <ul className="divide-line border-line divide-y border-t">
              {unknown.map((row) => (
                <IncidentRow
                  key={`${row.entry.accountId}:${row.check.key}`}
                  row={row}
                  ticket={undefined}
                  canTicket={false}
                />
              ))}
            </ul>
          </details>
        </Card>
      ) : null}
    </div>
  );
}

function IncidentRow({
  row,
  ticket,
  canTicket,
}: {
  row: Row;
  ticket: number | undefined;
  canTicket: boolean;
}) {
  const { entry, check } = row;
  return (
    <li className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <Link
          href={`/clients/${entry.accountId}/channels`}
          className="text-ink block truncate font-semibold underline-offset-2 hover:underline"
        >
          {entry.name}
        </Link>
        <p className="text-muted mt-0.5 truncate text-xs">
          {entry.managerName ?? 'No account manager'}
        </p>
        <p className="mt-1.5">
          <LifecycleBadge
            stage={entry.lifecycle.stage}
            pinned={entry.lifecycle.pinned}
            title={entry.lifecycle.because}
          />
        </p>
      </div>

      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <HealthBadge state={check.state} />
          <span className="text-ink text-sm font-semibold">{check.label}</span>
          <span
            className="text-muted text-xs"
            title={
              check.checkedAt ? formatDateTime(check.checkedAt) : undefined
            }
          >
            evidence{' '}
            {check.checkedAt ? formatAgo(check.checkedAt) : 'not timestamped'}
          </span>
        </p>
        <p className="text-ink-2 mt-1 text-sm leading-relaxed">
          {check.evidence}
        </p>
        {check.action ? (
          <p className="text-muted mt-1 text-xs leading-relaxed">
            <span className="text-ink-2 font-semibold">Next step:</span>{' '}
            {check.action}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 md:justify-end">
        {ticket ? (
          <ButtonLink href={`/support/${ticket}`} size="sm">
            SUP-{ticket}
          </ButtonLink>
        ) : canTicket ? (
          <ButtonLink
            href={`/support/new?accountId=${entry.accountId}&incident=${check.key}`}
            size="sm"
            variant="primary"
          >
            Open ticket
          </ButtonLink>
        ) : null}
      </div>
    </li>
  );
}
