import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, Pill } from '@/components/ui/badge';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { can, requireCapability } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  auditActionCounts,
  auditActorCounts,
  listAudit,
} from '@/lib/queries/audit';

export const metadata: Metadata = {
  title: 'Audit Logs · Converse360 Control Center',
};

/**
 * Every target type recordAudit() can write (lib/actions/audit.ts), with the
 * words an operator would use. The filter offers all of them, including ones
 * with no rows yet, so "has anyone ever changed staff?" is answerable with an
 * empty result rather than a missing option.
 */
const TARGET_TYPES: { value: string; label: string }[] = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'member', label: 'Member' },
  { value: 'invitation', label: 'Invitation' },
  { value: 'client', label: 'Client (ops profile)' },
  { value: 'client_note', label: 'Client note' },
  { value: 'client_task', label: 'Client task' },
  { value: 'ticket', label: 'Support ticket' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'plan', label: 'Plan' },
  { value: 'credit_pack', label: 'Credit pack' },
  { value: 'credit_wallet', label: 'Credit wallet' },
  { value: 'catalog', label: 'AI catalog' },
  { value: 'staff', label: 'Staff' },
  { value: 'settings', label: 'Settings' },
  { value: 'export', label: 'Export' },
];

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
    actor?: string;
    target?: string;
    page?: string;
  }>;
}) {
  const staff = await requireCapability('audit.read');
  const params = await searchParams;

  const [actions, actors] = await Promise.all([
    auditActionCounts(),
    auditActorCounts(),
  ]);
  // Both filters are matched against known values before they reach SQL.
  const actor = actors.some((entry) => entry.actor === params.actor)
    ? params.actor
    : undefined;
  const targetType = TARGET_TYPES.some((t) => t.value === params.target)
    ? params.target
    : undefined;
  const showSubscriptions = can(staff, 'billing.read');
  const known = new Set(actions.map((entry) => entry.action));
  const action =
    params.action && known.has(params.action) ? params.action : 'all';
  const accountId =
    params.accountId && UUID_RE.test(params.accountId)
      ? params.accountId
      : undefined;
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const list = await listAudit({
    q: params.q,
    action,
    accountId,
    actor,
    targetType,
    page,
  });
  const scopedName = accountId ? list.rows[0]?.accountName : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="Audit Logs"
        description="Every write the Control Center has made, by whom, in the words recorded at the time. Immutable: nothing here can be edited or deleted."
        actions={
          <p className="flex flex-wrap gap-2">
            {actions.slice(0, 6).map((entry) => (
              <Pill key={entry.action}>
                {entry.action}: {formatNumber(entry.count)}
              </Pill>
            ))}
          </p>
        }
      />

      {accountId ? (
        <p className="border-ring bg-surface text-ink-2 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm">
          Scoped to one workspace
          {scopedName ? (
            <Link
              href={`/clients/${accountId}`}
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
        hasFilters={Boolean(
          params.q || action !== 'all' || actor || targetType
        )}
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

        <FilterField label="Operator">
          <Select name="actor" defaultValue={actor ?? ''}>
            <option value="">Anyone</option>
            {actors.map((entry) => (
              <option key={entry.actor} value={entry.actor}>
                {entry.actor} ({entry.count})
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Target">
          <Select name="target" defaultValue={targetType ?? ''}>
            <option value="">Any target</option>
            {TARGET_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
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
            {list.total === 0 &&
            !params.q &&
            action === 'all' &&
            !actor &&
            !targetType
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
                  <Badge tone="outline">
                    {TARGET_TYPES.find((t) => t.value === row.targetType)
                      ?.label ?? row.targetType}
                  </Badge>
                  <span>by {row.actor}</span>
                  {row.accountId ? (
                    <Link
                      href={`/clients/${row.accountId}`}
                      className="hover:text-ink underline-offset-2 hover:underline"
                    >
                      {row.accountName ?? 'deleted workspace'}
                    </Link>
                  ) : null}
                  {row.userId ? (
                    showSubscriptions ? (
                      <Link
                        href={`/subscriptions/${row.userId}`}
                        className="hover:text-ink underline-offset-2 hover:underline"
                      >
                        {row.userEmail ?? 'deleted user'}
                      </Link>
                    ) : (
                      <span>{row.userEmail ?? 'deleted user'}</span>
                    )
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
            actor,
            target: targetType,
          }}
        />
      </Card>

      <p className="text-muted text-xs leading-relaxed">
        This log starts at migration 073; changes made before it were not
        recorded. Since migration 098 the operator is a named staff member
        (their email). Entries marked <em>break-glass</em> were made with the
        env credential, which is not a person — ask who held it at the time.
      </p>
    </div>
  );
}
