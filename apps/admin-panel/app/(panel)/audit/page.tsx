import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, Pill } from '@/components/ui/badge';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input, Select } from '@/components/ui/form';
import { Pagination } from '@/components/ui/pagination';
import { requireAdmin } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';
import { auditActionCounts, listAudit } from '@/lib/queries/audit';

export const metadata: Metadata = { title: 'Audit log · Converse360 Admin' };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `detail` is a jsonb column, so it arrives as `unknown` — it could be any JSON
 * value, including a bare string or null from a row written by something other
 * than `recordAudit`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What this panel has done.
 *
 * Append-only, and read from the recorded `summary` rather than re-derived from
 * the current state of the rows — the whole value of the log is that it still
 * says what happened after the thing it happened to has changed or gone.
 *
 * `accountId` arrives from a link on a workspace page, so it is validated as a
 * uuid before it reaches SQL rather than trusted because we generated the link.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    action?: string;
    accountId?: string;
    page?: string;
  }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const actions = await auditActionCounts();
  const known = new Set(actions.map((entry) => entry.action));
  const action =
    params.action && known.has(params.action) ? params.action : 'all';
  const accountId =
    params.accountId && UUID_RE.test(params.accountId)
      ? params.accountId
      : undefined;
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const list = await listAudit({ q: params.q, action, accountId, page });
  const scopedName = accountId ? list.rows[0]?.accountName : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-ink text-xl font-semibold">Audit log</h1>
          <p className="text-muted mt-1 text-sm">
            Every write this panel has made, by whom, in the words recorded at
            the time.
          </p>
        </div>
        <p className="text-muted flex flex-wrap gap-2 text-xs">
          {actions.slice(0, 6).map((entry) => (
            <Pill key={entry.action}>
              {entry.action}: {formatNumber(entry.count)}
            </Pill>
          ))}
        </p>
      </header>

      {accountId ? (
        <p className="border-ring text-ink-2 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm">
          Scoped to one workspace
          {scopedName ? (
            <Link
              href={`/workspaces/${accountId}`}
              className="text-ink font-medium underline-offset-2 hover:underline"
            >
              {scopedName}
            </Link>
          ) : (
            <span className="text-muted">
              (deleted — the log outlives what it describes)
            </span>
          )}
          <Link
            href="/audit"
            className="text-muted hover:text-ink ml-auto text-xs underline-offset-2 hover:underline"
          >
            Show everything
          </Link>
        </p>
      ) : null}

      <FilterBar
        action="/audit"
        hasFilters={Boolean(params.q || action !== 'all')}
      >
        {/* Carried through the GET so filtering inside a scoped view keeps the
         * scope — the filter bar posts only its own fields. */}
        {accountId ? (
          <input type="hidden" name="accountId" value={accountId} />
        ) : null}

        <FilterField label="Search" className="min-w-56 flex-1">
          <Input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Summary, operator, workspace or email"
            spellCheck={false}
          />
        </FilterField>

        <FilterField label="Action">
          <Select name="action" defaultValue={action}>
            <option value="all">Every action</option>
            {actions.map((entry) => (
              <option key={entry.action} value={entry.action}>
                {entry.action} ({entry.count})
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title={`${formatNumber(list.total)} entr${list.total === 1 ? 'y' : 'ies'}`}
          description="Nothing here is editable or deletable. A correction is a new change with its own entry."
        />

        {list.rows.length === 0 ? (
          <EmptyState>
            {list.total === 0 && !params.q && action === 'all'
              ? 'Nothing has been changed from this panel yet.'
              : 'No entries match that filter.'}
          </EmptyState>
        ) : (
          <ul className="divide-line divide-y">
            {list.rows.map((row) => (
              <li key={row.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <p className="text-ink-2 min-w-0 text-sm">{row.summary}</p>
                  <p className="text-muted shrink-0 text-xs">
                    {formatDateTime(row.createdAt)}
                  </p>
                </div>

                <div className="text-muted mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <Badge>{row.action}</Badge>
                  <span>by {row.actor}</span>
                  {row.accountId ? (
                    <Link
                      href={`/workspaces/${row.accountId}`}
                      className="hover:text-ink underline-offset-2 hover:underline"
                    >
                      {row.accountName ?? 'deleted workspace'}
                    </Link>
                  ) : null}
                  {row.userId ? (
                    <Link
                      href={`/subscribers/${row.userId}`}
                      className="hover:text-ink underline-offset-2 hover:underline"
                    >
                      {row.userEmail ?? 'deleted user'}
                    </Link>
                  ) : null}
                </div>

                {isRecord(row.detail) && Object.keys(row.detail).length > 0 ? (
                  <details className="mt-2">
                    <summary className="text-muted hover:text-ink cursor-pointer text-xs">
                      Recorded detail
                    </summary>
                    <pre className="bg-surface-2 text-ink-2 mt-2 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                      {JSON.stringify(row.detail, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <Pagination
          basePath="/audit"
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          perPage={list.perPage}
          params={{
            q: params.q,
            action: action === 'all' ? undefined : action,
            accountId,
          }}
        />
      </Card>

      <p className="text-muted text-xs leading-relaxed">
        This log starts at migration 073. Changes made before it were not
        recorded — the panel&rsquo;s administrator is an env credential rather
        than a row in <code className="text-ink-2">auth.users</code>, so there
        was no column with an honest value to write.
      </p>
    </div>
  );
}
