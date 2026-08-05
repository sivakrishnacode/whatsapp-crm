import type { Metadata } from 'next';

import { Badge, Pill, StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input, Select } from '@/components/ui/form';
import { Pagination } from '@/components/ui/pagination';
import { SubscriberIdentity } from '@/components/subscriber/identity';
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
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import { listUsers, roleCounts } from '@/lib/queries/users';

export const metadata: Metadata = { title: 'Users · Converse360 Admin' };

const ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; page?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const role = ROLES.includes(params.role as (typeof ROLES)[number])
    ? params.role
    : 'all';
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const [list, roles] = await Promise.all([
    listUsers({ q: params.q, role, page }),
    roleCounts(),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-ink text-xl font-semibold">Users</h1>
          <p className="text-muted mt-1 text-sm">
            Everyone with a login, whether or not they onboarded onto an
            account.
          </p>
        </div>
        <p className="text-muted flex flex-wrap gap-2 text-xs">
          {roles.map((entry) => (
            <Pill key={entry.role}>
              {entry.role}: {formatNumber(entry.count)}
            </Pill>
          ))}
        </p>
      </header>

      <FilterBar
        action="/users"
        hasFilters={Boolean(params.q || (role && role !== 'all'))}
      >
        <FilterField label="Search" className="min-w-56 flex-1">
          <Input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Name, email or account"
            spellCheck={false}
          />
        </FilterField>

        <FilterField label="Account role">
          <Select name="role" defaultValue={role}>
            <option value="all">Any role</option>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title="All users"
          description="A user with no profile signed up but never completed onboarding — they have no account and no subscription."
        />

        {list.rows.length === 0 ? (
          <EmptyState>No users match that filter.</EmptyState>
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Account</TH>
                  <TH>Role</TH>
                  <TH>Subscription</TH>
                  <TH>Signed up</TH>
                  <TH>Last sign-in</TH>
                  <TH align="right">MRR</TH>
                </TR>
              </THead>
              <TBody>
                {list.rows.map((row) => (
                  <TR key={row.userId}>
                    <TD>
                      <SubscriberIdentity
                        userId={row.userId}
                        fullName={row.fullName}
                        email={row.email}
                      />
                      {row.bannedUntil && row.bannedUntil > new Date() ? (
                        <span className="text-critical mt-1 block text-xs">
                          banned until {formatDate(row.bannedUntil)}
                        </span>
                      ) : null}
                      {!row.emailConfirmedAt ? (
                        <span className="text-muted mt-1 block text-xs">
                          email not confirmed
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="text-ink-2">
                        {row.accountName ?? '—'}
                      </span>
                      {row.isAccountOwner ? (
                        <span className="text-muted block text-xs">owner</span>
                      ) : null}
                    </TD>
                    <TD>
                      {row.accountRole ? (
                        <Badge>{row.accountRole}</Badge>
                      ) : (
                        <span className="text-muted text-xs">no profile</span>
                      )}
                    </TD>
                    <TD>
                      <StatusBadge status={row.status} />
                      {row.planDisplayName ? (
                        <span className="text-muted block text-xs">
                          {row.planDisplayName}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="text-ink-2">
                        {formatDate(row.createdAt)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-ink-2">
                        {formatDate(row.lastSignInAt)}
                      </span>
                      {row.lastSignInAt ? (
                        <span className="text-muted block text-xs">
                          {formatRelativeDays(row.lastSignInAt)}
                        </span>
                      ) : null}
                    </TD>
                    <TD align="right">
                      <span className="text-ink font-medium">
                        {row.mrr > 0 ? formatMoney(row.mrr) : '—'}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}

        <Pagination
          basePath="/users"
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          perPage={list.perPage}
          params={{
            q: params.q,
            role: role === 'all' ? undefined : role,
          }}
        />
      </Card>
    </div>
  );
}
