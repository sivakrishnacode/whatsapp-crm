import type { Metadata } from 'next';
import Link from 'next/link';

import {
  HealthBadge,
  LIFECYCLE_STYLE,
  LifecycleBadge,
} from '@/components/ops/badges';
import { StatusBadge } from '@/components/ui/badge';
import { Card, EmptyState } from '@/components/ui/card';
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
import { can, requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import {
  formatAgo,
  formatDate,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import { LIFECYCLE_STAGES } from '@/lib/lifecycle';
import {
  filterRoster,
  normaliseFilters,
  type DirectoryParams,
} from '@/lib/queries/directory';
import { getRoster } from '@/lib/queries/roster';
import { listStaff } from '@/lib/queries/staff';

export const metadata: Metadata = {
  title: 'Manage Clients · Converse360 Control Center',
};

const PER_PAGE = 25;

/**
 * The client directory (C360-021): every tenant, searchable by name, any
 * member email, WABA id, phone number id or tenant id, filterable by stage,
 * health, plan, owner and tier, sorted server-side and paginated. Each row
 * opens the tenant-scoped Customer 360.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<DirectoryParams>;
}) {
  const staff = await requireCapability('clients.read');
  const params = await searchParams;
  const showMoney = can(staff, 'billing.read');
  const f = normaliseFilters(params, { allowMoneySort: showMoney });

  const [roster, staffList] = await Promise.all([getRoster(), listStaff()]);
  const rows = filterRoster(roster, f);
  const pageCount = Math.max(Math.ceil(rows.length / PER_PAGE), 1);
  const page = Math.min(f.page, pageCount);
  const visible = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const live = roster.filter((r) => r.lifecycle.stage !== 'archived');
  const count = (stage: string) =>
    live.filter((r) => r.lifecycle.stage === stage).length;
  const needsAttention = live.filter(
    (r) => r.lifecycle.stage === 'attention' || r.health.overall === 'critical'
  ).length;
  const openTickets = live.reduce((sum, r) => sum + r.openTickets, 0);
  const plans = [
    ...new Set(roster.map((r) => r.planName).filter(Boolean)),
  ] as string[];

  // Links that change one filter keep the others.
  const carry = {
    q: f.q || undefined,
    health: f.health === 'all' ? undefined : f.health,
    plan: f.plan || undefined,
    manager: f.manager || undefined,
    tier: f.tier || undefined,
    sort: f.sort === 'recent' ? undefined : f.sort,
  };
  const href = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...carry, ...extra })) {
      if (value) search.set(key, value);
    }
    const query = search.toString();
    return query ? `/clients?${query}` : '/clients';
  };
  const hasFilters = Boolean(
    f.q ||
    f.health !== 'all' ||
    f.plan ||
    f.manager ||
    f.tier ||
    f.stage !== 'all' ||
    f.sort !== 'recent'
  );
  const exportQuery = new URLSearchParams(
    Object.entries({
      ...carry,
      stage: f.stage === 'all' ? undefined : f.stage,
    }).filter((pair): pair is [string, string] => Boolean(pair[1]))
  ).toString();
  const exportHref = exportQuery
    ? `/export/clients?${exportQuery}`
    : '/export/clients';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manage Clients"
        description="Every tenant workspace — who owns it on our side, where it is in its lifecycle, how healthy it is, and what needs doing."
        actions={
          <>
            {can(staff, 'export') ? (
              <ButtonLink href={exportHref}>Export CSV</ButtonLink>
            ) : null}
            <ButtonLink href="/portfolio" variant="primary">
              Portfolio analytics
            </ButtonLink>
          </>
        }
      />

      <StatRow columns={6}>
        <StatTile
          label="Clients"
          value={formatNumber(live.length)}
          context={`${roster.length - live.length} archived`}
          href="/clients"
        />
        <StatTile
          label="Active"
          value={formatNumber(count('active'))}
          tone="good"
          href="/clients?stage=active"
        />
        <StatTile
          label="Onboarding"
          value={formatNumber(count('onboarding'))}
          href="/clients?stage=onboarding"
        />
        <StatTile
          label="Needs attention"
          value={formatNumber(needsAttention)}
          tone={needsAttention > 0 ? 'warning' : 'neutral'}
          context="attention stage or a critical check"
          href="/clients?sort=health"
        />
        <StatTile
          label="Churned"
          value={formatNumber(count('churned'))}
          href="/clients?stage=churned"
        />
        <StatTile
          label="Open tickets"
          value={formatNumber(openTickets)}
          href={can(staff, 'tickets.work') ? '/support' : undefined}
        />
      </StatRow>

      <Segmented
        label="Lifecycle stage"
        active={f.stage}
        options={[
          { value: 'all', label: 'All', href: href({}) },
          ...LIFECYCLE_STAGES.map((stage) => ({
            value: stage,
            label: LIFECYCLE_STYLE[stage].label,
            href: href({ stage }),
          })),
        ]}
      />

      <FilterBar action="/clients" hasFilters={hasFilters}>
        {f.stage !== 'all' ? (
          <input type="hidden" name="stage" value={f.stage} />
        ) : null}
        <FilterField label="Search" className="min-w-64 flex-1">
          <Input
            type="search"
            name="q"
            defaultValue={f.q}
            placeholder="Name, any member email, WABA ID, phone number ID, tenant ID, tag"
          />
        </FilterField>
        <FilterField label="Health">
          <Select
            name="health"
            defaultValue={f.health === 'all' ? '' : f.health}
          >
            <option value="">Any</option>
            <option value="critical">Critical</option>
            <option value="attention">Attention</option>
            <option value="unknown">Unknown</option>
            <option value="healthy">Healthy</option>
            <option value="not_configured">Not configured</option>
          </Select>
        </FilterField>
        <FilterField label="Plan">
          <Select name="plan" defaultValue={f.plan}>
            <option value="">Any</option>
            {plans.map((plan) => (
              <option key={plan} value={plan}>
                {plan}
              </option>
            ))}
            <option value="none">No plan</option>
          </Select>
        </FilterField>
        <FilterField label="Account manager">
          <Select name="manager" defaultValue={f.manager}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Tier">
          <Select name="tier" defaultValue={f.tier}>
            <option value="">Any</option>
            <option value="standard">Standard</option>
            <option value="priority">Priority</option>
            <option value="enterprise">Enterprise</option>
          </Select>
        </FilterField>
        <FilterField label="Sort">
          <Select name="sort" defaultValue={f.sort}>
            <option value="recent">Newest first</option>
            <option value="health">Worst health first</option>
            <option value="activity">Most recent activity</option>
            <option value="renewal">Renewal soonest</option>
            <option value="tickets">Most tickets</option>
            <option value="name">Name A–Z</option>
            {showMoney ? <option value="mrr">Highest MRR</option> : null}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        {visible.length === 0 ? (
          <EmptyState title="No clients match">
            {hasFilters
              ? 'Nothing matches these filters. Clear them to see every client.'
              : 'No workspaces exist yet — they appear here the moment someone signs up.'}
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="62rem">
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH>Account manager</TH>
                  <TH>Plan</TH>
                  <TH>Lifecycle</TH>
                  <TH>Health</TH>
                  <TH align="right">Setup</TH>
                  <TH>Last activity</TH>
                  <TH>Renewal</TH>
                  <TH align="right">Tickets</TH>
                </tr>
              </THead>
              <TBody>
                {visible.map((client) => {
                  const worst = client.health.checks.find(
                    (c) => c.state === client.health.overall
                  );
                  const renewal =
                    client.subStatus === 'trial'
                      ? client.trialEndAt
                      : client.periodEnd;
                  return (
                    <TR key={client.accountId}>
                      <TD>
                        <Link
                          href={`/clients/${client.accountId}`}
                          className="text-ink font-semibold hover:underline"
                        >
                          {client.name}
                        </Link>
                        <p className="text-muted max-w-60 truncate text-xs">
                          {client.ownerEmail ?? '—'} · {client.members} member
                          {client.members === 1 ? '' : 's'}
                        </p>
                        <p className="text-muted font-mono text-[10px]">
                          {client.accountId.slice(0, 8)}
                        </p>
                      </TD>
                      <TD>
                        {client.managerName ?? (
                          <span className="text-muted">Unassigned</span>
                        )}
                      </TD>
                      <TD>
                        <p className="text-ink-2">
                          {client.planDisplayName ?? (
                            <span className="text-muted">None</span>
                          )}
                        </p>
                        {showMoney ? (
                          <div className="mt-1 flex items-center gap-1.5">
                            <StatusBadge status={client.subStatus} />
                            {client.mrr > 0 ? (
                              <span className="text-muted text-xs">
                                {formatMoney(client.mrr)}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </TD>
                      <TD>
                        <LifecycleBadge
                          stage={client.lifecycle.stage}
                          pinned={client.lifecycle.pinned}
                          title={client.lifecycle.because}
                        />
                      </TD>
                      <TD>
                        <HealthBadge
                          state={client.health.overall}
                          title={
                            worst
                              ? `${worst.label}: ${worst.evidence}`
                              : undefined
                          }
                        />
                        {worst &&
                        client.health.overall !== 'healthy' &&
                        client.health.overall !== 'not_configured' ? (
                          <p className="text-muted mt-1 max-w-44 truncate text-xs">
                            {worst.label}
                          </p>
                        ) : null}
                        <p className="text-muted mt-0.5 text-[11px]">
                          WhatsApp{' '}
                          {client.health.evidence.wa
                            ? client.health.evidence.wa.status
                            : 'not connected'}
                        </p>
                      </TD>
                      <TD align="right" className="tabular">
                        {client.health.completion.percent}%
                      </TD>
                      <TD>
                        {client.lastMessageAt ? (
                          <span title={formatDate(client.lastMessageAt)}>
                            {formatAgo(client.lastMessageAt)}
                          </span>
                        ) : (
                          <span className="text-muted">Never</span>
                        )}
                      </TD>
                      <TD>
                        {renewal ? (
                          <>
                            <p className="text-ink-2">{formatDate(renewal)}</p>
                            <p className="text-muted text-xs">
                              {client.subStatus === 'trial'
                                ? 'trial ends '
                                : ''}
                              {formatRelativeDays(renewal)}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </TD>
                      <TD align="right">
                        {client.openTickets > 0 ? (
                          <Link
                            href={`/clients/${client.accountId}/tickets`}
                            className="text-ink font-semibold hover:underline"
                          >
                            {client.openTickets}
                            {client.criticalTickets > 0 ? (
                              <span className="text-bad-fg ml-1 text-xs">
                                ({client.criticalTickets} critical)
                              </span>
                            ) : null}
                          </Link>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
        <Pagination
          basePath="/clients"
          page={page}
          pageCount={pageCount}
          total={rows.length}
          perPage={PER_PAGE}
          params={{ ...carry, stage: f.stage === 'all' ? undefined : f.stage }}
        />
      </Card>

      <ScopeLine>
        <span>
          Health evaluated{' '}
          {roster[0] ? formatAgo(roster[0].health.evaluatedAt) : 'now'} from
          stored evidence ({adminTimezone()})
        </span>
        <span aria-hidden>·</span>
        <span>Lifecycle is derived unless an operator pinned it</span>
        <span aria-hidden>·</span>
        <span>Archived clients are hidden unless you pick Archived</span>
      </ScopeLine>
    </div>
  );
}
