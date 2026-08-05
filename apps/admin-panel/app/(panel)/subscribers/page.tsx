import type { Metadata } from 'next';

import { StatusBadge } from '@/components/ui/badge';
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
import {
  listSubscribers,
  planOptions,
  type SubscriberSort,
} from '@/lib/queries/subscribers';
import {
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from '@/lib/queries/sql';

export const metadata: Metadata = { title: 'Subscribers · Converse360 Admin' };

const SORTS: { value: SubscriberSort; label: string }[] = [
  { value: 'recent', label: 'Newest first' },
  { value: 'renewal', label: 'Renewing soonest' },
  { value: 'value', label: 'Highest value' },
  { value: 'name', label: 'Name (A–Z)' },
];

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trial: 'Trial',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    plan?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  // Anything unrecognised in the URL falls back to a default rather than
  // reaching a query — these values end up in SQL.
  const status = SUBSCRIPTION_STATUSES.includes(
    params.status as SubscriptionStatus
  )
    ? (params.status as SubscriptionStatus)
    : 'all';
  const sort = SORTS.some((option) => option.value === params.sort)
    ? (params.sort as SubscriberSort)
    : 'recent';
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const [plans, list] = await Promise.all([
    planOptions(),
    listSubscribers({ q: params.q, status, plan: params.plan, sort, page }),
  ]);

  const validPlan = plans.some((plan) => plan.name === params.plan)
    ? params.plan
    : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-ink text-xl font-semibold">Subscribers</h1>
          <p className="text-muted mt-1 text-sm">
            Every subscription in the database, whatever its state.
          </p>
        </div>
        <p className="text-muted text-sm">
          <span className="text-ink font-semibold">
            {formatNumber(list.total)}
          </span>{' '}
          matching ·{' '}
          <span className="text-ink font-semibold">
            {formatMoney(list.mrr)}
          </span>{' '}
          MRR in this filter
        </p>
      </header>

      <FilterBar
        action="/subscribers"
        hasFilters={Boolean(
          params.q || validPlan || status !== 'all' || params.sort
        )}
      >
        <FilterField label="Search" className="min-w-56 flex-1">
          <Input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Name, email or account"
            spellCheck={false}
          />
        </FilterField>

        <FilterField label="Status">
          <Select name="status" defaultValue={status}>
            <option value="all">Any status</option>
            {SUBSCRIPTION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Plan">
          <Select name="plan" defaultValue={validPlan ?? ''}>
            <option value="">Any plan</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.name}>
                {plan.displayName}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Sort">
          <Select name="sort" defaultValue={sort}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title="Subscriptions"
          description="MRR is a monthly-normalised figure: a yearly subscription shows its monthly share."
        />

        {list.rows.length === 0 ? (
          <EmptyState>
            Nothing matches that filter. Try clearing the search.
          </EmptyState>
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Subscriber</TH>
                  <TH>Plan</TH>
                  <TH>Status</TH>
                  <TH>Renews</TH>
                  <TH>Started</TH>
                  <TH align="right">Per cycle</TH>
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
                        accountName={row.accountName}
                      />
                    </TD>
                    <TD>
                      <span className="text-ink-2">{row.planDisplayName}</span>
                      <span className="text-muted block text-xs">
                        {row.billingCycle ?? 'no cycle'}
                        {row.paymentMethod ? ` · ${row.paymentMethod}` : ''}
                      </span>
                    </TD>
                    <TD>
                      <StatusBadge status={row.status} />
                      {row.cancelAtPeriodEnd ? (
                        <span className="text-muted block text-xs">
                          cancels at period end
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="text-ink-2">
                        {formatDate(row.periodEnd)}
                      </span>
                      {row.periodEnd ? (
                        <span className="text-muted block text-xs">
                          {formatRelativeDays(row.periodEnd)}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="text-ink-2">
                        {formatDate(row.subscribedAt)}
                      </span>
                    </TD>
                    <TD align="right">
                      <span className="text-ink-2">
                        {formatMoney(row.periodAmount)}
                      </span>
                    </TD>
                    <TD align="right">
                      <span className="text-ink font-medium">
                        {formatMoney(row.mrr)}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}

        <Pagination
          basePath="/subscribers"
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          perPage={list.perPage}
          params={{
            q: params.q,
            status: status === 'all' ? undefined : status,
            plan: validPlan,
            sort: sort === 'recent' ? undefined : sort,
          }}
        />
      </Card>
    </div>
  );
}
