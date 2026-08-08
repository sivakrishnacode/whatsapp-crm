import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input, Select } from '@/components/ui/form';
import { Pagination } from '@/components/ui/pagination';
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
import { requireAdmin } from '@/lib/auth';
import {
  formatCredits,
  formatDate,
  formatMoney,
  formatNumber,
} from '@/lib/format';
import {
  LOW_CREDIT_THRESHOLD,
  listWorkspaces,
  workspaceTotals,
  type CreditMode,
  type WorkspaceCreditFilter,
  type WorkspaceSort,
} from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'Workspaces · Converse360 Admin' };

const SORTS: WorkspaceSort[] = [
  'recent',
  'name',
  'value',
  'credits',
  'spend',
  'members',
];

const SORT_LABELS: Record<WorkspaceSort, string> = {
  recent: 'Newest first',
  name: 'Name (A–Z)',
  value: 'Highest MRR',
  credits: 'Most credits left',
  spend: 'Most credits spent (30d)',
  members: 'Most members',
};

const MODES: (CreditMode | 'none')[] = ['platform', 'byok', 'none'];
const MODE_LABELS: Record<string, string> = {
  platform: 'Our key (credits)',
  byok: 'Own provider key',
  none: 'AI never set up',
};

const CREDIT_FILTERS: WorkspaceCreditFilter[] = ['has', 'low', 'empty'];
const CREDIT_LABELS: Record<string, string> = {
  has: 'Any credits left',
  low: `Low (1–${LOW_CREDIT_THRESHOLD})`,
  empty: 'Out of credits',
};

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    mode?: string;
    credits?: string;
    channel?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  // Every value that reaches SQL is narrowed to a known member first — these
  // are query-string values, and a `sort` that is not in the map would be an
  // undefined ORDER BY fragment.
  const mode = MODES.includes(params.mode as CreditMode | 'none')
    ? (params.mode as CreditMode | 'none')
    : 'all';
  const credits = CREDIT_FILTERS.includes(
    params.credits as WorkspaceCreditFilter
  )
    ? (params.credits as WorkspaceCreditFilter)
    : 'all';
  const channel =
    params.channel === 'whatsapp' || params.channel === 'none'
      ? params.channel
      : 'all';
  const sort = SORTS.includes(params.sort as WorkspaceSort)
    ? (params.sort as WorkspaceSort)
    : 'recent';
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const [list, totals] = await Promise.all([
    listWorkspaces({ q: params.q, mode, credits, channel, sort, page }),
    workspaceTotals(),
  ]);

  const hasFilters = Boolean(
    params.q || mode !== 'all' || credits !== 'all' || channel !== 'all'
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-ink text-xl font-semibold">Workspaces</h1>
        <p className="text-muted mt-1 text-sm">
          Every tenant account, its people, its plan and its AI credits. A
          workspace&rsquo;s plan is its owner&rsquo;s subscription — that is how
          the schema keys it.
        </p>
      </header>

      <StatRow>
        <StatTile
          label="Workspaces"
          value={formatNumber(totals.workspaces)}
          context={`${formatNumber(totals.newThisMonth)} created this month`}
        />
        <StatTile
          label="Finished onboarding"
          value={formatNumber(totals.onboarded)}
          context={`${formatNumber(totals.workspaces - totals.onboarded)} never picked a plan`}
        />
        <StatTile
          label="WhatsApp connected"
          value={formatNumber(totals.whatsappConnected)}
          context="the only channel that costs them setup effort"
          tone={totals.whatsappConnected > 0 ? 'good' : 'neutral'}
        />
        <StatTile
          label="AI switched on"
          value={formatNumber(totals.aiActive)}
          context={`${formatNumber(totals.onPlatformCredits)} on our key, ${formatNumber(totals.onOwnKey)} on their own`}
        />
      </StatRow>

      <FilterBar action="/workspaces" hasFilters={hasFilters}>
        <FilterField label="Search" className="min-w-56 flex-1">
          <Input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Workspace, owner name or email"
            spellCheck={false}
          />
        </FilterField>

        <FilterField label="AI runs on">
          <Select name="mode" defaultValue={mode}>
            <option value="all">Any setup</option>
            {MODES.map((value) => (
              <option key={value} value={value}>
                {MODE_LABELS[value]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Credits">
          <Select name="credits" defaultValue={credits}>
            <option value="all">Any balance</option>
            {CREDIT_FILTERS.map((value) => (
              <option key={value} value={value}>
                {CREDIT_LABELS[value]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="WhatsApp">
          <Select name="channel" defaultValue={channel}>
            <option value="all">Any</option>
            <option value="whatsapp">Connected</option>
            <option value="none">Not connected</option>
          </Select>
        </FilterField>

        <FilterField label="Sort">
          <Select name="sort" defaultValue={sort}>
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title={`${formatNumber(list.total)} workspace${list.total === 1 ? '' : 's'}`}
          description="Credits are only spent by workspaces running on our Gemini key; a workspace on its own provider key shows a balance it is not using."
        />

        {list.rows.length === 0 ? (
          <EmptyState>No workspaces match that filter.</EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="66rem">
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH>People</TH>
                  <TH>Plan</TH>
                  <TH>Channels</TH>
                  <TH>AI</TH>
                  <TH align="right">Credits</TH>
                  <TH align="right">Spent 30d</TH>
                  <TH align="right">MRR</TH>
                </TR>
              </THead>
              <TBody>
                {list.rows.map((row) => (
                  <TR key={row.accountId}>
                    <TD>
                      <Link
                        href={`/workspaces/${row.accountId}`}
                        className="text-ink block truncate font-medium underline-offset-2 hover:underline"
                      >
                        {row.accountName}
                      </Link>
                      <span className="text-muted block truncate text-xs">
                        {row.ownerName || row.ownerEmail || 'owner unknown'}
                        {row.ownerName && row.ownerEmail
                          ? ` · ${row.ownerEmail}`
                          : ''}
                      </span>
                      {row.onboardedAt ? null : (
                        <span className="text-muted mt-1 block text-xs">
                          onboarding unfinished
                        </span>
                      )}
                    </TD>

                    <TD>
                      <span className="text-ink-2 tabular">
                        {formatNumber(row.members)}
                      </span>
                      {row.pendingInvites > 0 ? (
                        <span className="text-muted block text-xs">
                          +{row.pendingInvites} invited
                        </span>
                      ) : null}
                    </TD>

                    <TD>
                      <StatusBadge status={row.status} />
                      <span className="text-muted block text-xs">
                        {row.planDisplayName ?? 'no subscription'}
                      </span>
                    </TD>

                    <TD>
                      {row.whatsappStatus === 'connected' ? (
                        <Badge>WhatsApp</Badge>
                      ) : (
                        <span className="text-muted text-xs">
                          {row.whatsappStatus ?? 'none'}
                        </span>
                      )}
                    </TD>

                    <TD>
                      {row.creditMode === null ? (
                        <span className="text-muted text-xs">not set up</span>
                      ) : (
                        <>
                          <Badge tone="outline">
                            {row.creditMode === 'platform'
                              ? 'our key'
                              : 'own key'}
                          </Badge>
                          <span className="text-muted block text-xs">
                            {row.aiActive ? 'active' : 'off'}
                            {row.autoReplyEnabled ? ' · auto-reply' : ''}
                          </span>
                        </>
                      )}
                    </TD>

                    <TD align="right">
                      {row.creditBalance === null ? (
                        <span className="text-muted text-xs">no wallet</span>
                      ) : (
                        <span className="text-ink inline-flex items-center gap-1.5 font-medium">
                          {row.creditMode === 'platform' &&
                          row.creditBalance <= LOW_CREDIT_THRESHOLD ? (
                            <span
                              aria-hidden
                              className={`size-1.5 rounded-full ${
                                row.creditBalance === 0
                                  ? 'bg-critical'
                                  : 'bg-warning'
                              }`}
                            />
                          ) : null}
                          {formatCredits(row.creditBalance)}
                        </span>
                      )}
                    </TD>

                    <TD align="right">
                      <span className="text-ink-2">
                        {row.creditsSpent30d > 0
                          ? formatCredits(row.creditsSpent30d)
                          : '—'}
                      </span>
                    </TD>

                    <TD align="right">
                      <span className="text-ink font-medium">
                        {row.mrr > 0 ? formatMoney(row.mrr) : '—'}
                      </span>
                      <span className="text-muted block text-xs">
                        {formatDate(row.createdAt)}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}

        <Pagination
          basePath="/workspaces"
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          perPage={list.perPage}
          params={{
            q: params.q,
            mode: mode === 'all' ? undefined : mode,
            credits: credits === 'all' ? undefined : credits,
            channel: channel === 'all' ? undefined : channel,
            sort: sort === 'recent' ? undefined : sort,
          }}
        />
      </Card>

      <p className="text-muted text-xs leading-relaxed">
        {formatNumber(totals.soloWorkspaces)} of {formatNumber(totals.workspaces)}{' '}
        workspaces have a single member. Signup creates one workspace per user, so
        most of those are people who signed up and never invited anyone — they are
        accounts, not teams.
      </p>
    </div>
  );
}
