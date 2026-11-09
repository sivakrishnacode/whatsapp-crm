import type { Metadata } from 'next';
import Link from 'next/link';

import { Funnel } from '@/components/chart/funnel';
import { Pill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Select } from '@/components/ui/form';
import {
  ButtonLink,
  Callout,
  PageHeader,
  ScopeLine,
} from '@/components/ui/page';
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
import { formatDate, formatNumber } from '@/lib/format';
import {
  ONBOARDING_STAGES,
  onboardingPositions,
  type OnboardingStage,
} from '@/lib/queries/onboarding';
import { getRoster, type RosterEntry } from '@/lib/queries/roster';
import { listStaff } from '@/lib/queries/staff';
import { getSettings } from '@/lib/settings-store';
import { requestNow } from '@/lib/clock';

export const metadata: Metadata = {
  title: 'Onboarding Queue · Converse360 Control Center',
};

type Search = { stage?: string; manager?: string; stalled?: string };

const DAY = 86_400_000;

type QueueRow = {
  entry: RosterEntry;
  stage: OnboardingStage;
  since: Date | null;
  days: number | null;
  stalled: boolean;
};

/**
 * Every client still on its way to live, where it is stuck, and for how long
 * (C360-001/005). Churned and archived clients are left out — a lapsed
 * workspace is a renewal conversation, not an onboarding one.
 */
export default async function OnboardingQueuePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const staff = await requireCapability('clients.read');
  const params = await searchParams;
  const canTicket = can(staff, 'tickets.work');

  const [roster, positions, settings, staffList] = await Promise.all([
    getRoster(),
    onboardingPositions(),
    getSettings(),
    listStaff({ activeOnly: true }),
  ]);

  const now = requestNow().getTime();
  const stalledAfter = settings.stalledOnboardingDays;

  const all: QueueRow[] = roster.flatMap((entry) => {
    if (
      entry.lifecycle.stage === 'churned' ||
      entry.lifecycle.stage === 'archived'
    ) {
      return [];
    }
    const pos = positions.get(entry.accountId);
    if (!pos) return [];
    const days =
      pos.since !== null
        ? Math.max(Math.floor((now - pos.since.getTime()) / DAY), 0)
        : null;
    return [
      {
        entry,
        stage: pos.stage,
        since: pos.since,
        days,
        stalled: pos.stage < 6 && days !== null && days >= stalledAfter,
      },
    ];
  });

  const stageFilter = Number(params.stage);
  const manager = params.manager || undefined;
  const onlyStalled = params.stalled === '1';

  const queue = all
    .filter((row) => row.stage < 6)
    .filter((row) =>
      stageFilter >= 1 && stageFilter <= 5 ? row.stage === stageFilter : true
    )
    .filter((row) =>
      manager === 'none'
        ? row.entry.managerId === null
        : manager
          ? row.entry.managerId === manager
          : true
    )
    .filter((row) => (onlyStalled ? row.stalled : true))
    // Earliest stage first (furthest from live), then longest waiting.
    .sort((a, b) => a.stage - b.stage || (b.days ?? -1) - (a.days ?? -1));

  const inQueue = all.filter((row) => row.stage < 6);
  const stalled = inQueue.filter((row) => row.stalled);
  const unmanaged = inQueue.filter((row) => row.entry.managerId === null);
  const reached = (n: number) => all.filter((row) => row.stage >= n).length;
  const hasFilters = Boolean(params.stage || manager || onlyStalled);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Onboarding Queue"
        description="Clients that are not live yet: the stage each is stuck at, how long it has been there, and who owns getting them through."
      />

      <Callout tone="info" title="Stages the product records today">
        The C2.0 ten-step customer wizard (Meta portfolio, number path, embedded
        signup, AI, team, CRM, test &amp; launch) is apps/web work and does not
        exist yet. Until it saves its steps server-side, this queue reports the
        six stages the product genuinely records: the welcome wizard, channel
        connection, number registration and the first successful send.
      </Callout>

      <StatRow columns={4}>
        <StatTile
          label="In onboarding"
          value={formatNumber(inQueue.length)}
          context={`of ${formatNumber(all.length)} active clients`}
        />
        <StatTile
          label="Stalled"
          value={formatNumber(stalled.length)}
          tone={stalled.length > 0 ? 'warning' : 'good'}
          context={`${stalledAfter}+ days in one stage`}
          href="/onboarding?stalled=1"
        />
        <StatTile
          label="No account manager"
          value={formatNumber(unmanaged.length)}
          tone={unmanaged.length > 0 ? 'warning' : 'neutral'}
          context="Onboarding clients nobody owns"
          href="/onboarding?manager=none"
        />
        <StatTile
          label="Live"
          value={formatNumber(all.length - inQueue.length)}
          context="At least one successful outbound send"
        />
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card>
          <CardHeader
            title="Where clients are"
            description="How many active clients have reached each stage."
          />
          <CardBody>
            <Funnel
              denominatorLabel={`the ${formatNumber(all.length)} clients not churned or archived`}
              steps={ONBOARDING_STAGES.map((stage) => ({
                label: stage.label,
                count: reached(stage.stage),
              }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="How each stage is measured"
            description="Days in stage count from the timestamp shown — the best one the data has."
          />
          <CardBody>
            <dl className="divide-line divide-y text-sm">
              {ONBOARDING_STAGES.map((stage) => (
                <div
                  key={stage.stage}
                  className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)]"
                >
                  <dt className="text-ink-2 font-medium">
                    <span className="text-muted tabular mr-2 text-xs">
                      {String(stage.stage).padStart(2, '0')}
                    </span>
                    {stage.label}
                  </dt>
                  <dd className="text-muted text-xs leading-relaxed">
                    {STAGE_DEFINITION[stage.stage]} Counted {stage.since}.
                  </dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>

      <FilterBar action="/onboarding" hasFilters={hasFilters}>
        <FilterField label="Stage">
          <Select name="stage" defaultValue={params.stage ?? ''}>
            <option value="">Every stage</option>
            {ONBOARDING_STAGES.filter((s) => s.stage < 6).map((stage) => (
              <option key={stage.stage} value={stage.stage}>
                {stage.stage} · {stage.label}
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
        <FilterField label="Show">
          <Select name="stalled" defaultValue={onlyStalled ? '1' : ''}>
            <option value="">Everyone in onboarding</option>
            <option value="1">Stalled only</option>
          </Select>
        </FilterField>
      </FilterBar>

      <Card>
        <CardHeader
          title="Queue"
          description="Furthest from live first, then longest waiting."
        />
        {queue.length === 0 ? (
          <EmptyState title="Nobody is waiting">
            {hasFilters
              ? 'No onboarding client matches these filters.'
              : 'Every active client is live. New signups appear here until their first successful send.'}
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="62rem">
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH>Stage</TH>
                  <TH align="right">In stage</TH>
                  <TH align="right">Setup</TH>
                  <TH>Account manager</TH>
                  <TH align="right">Open tickets</TH>
                  <TH align="right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {queue.map((row) => {
                  const meta = ONBOARDING_STAGES[row.stage - 1]!;
                  return (
                    <TR key={row.entry.accountId}>
                      <TD className="max-w-[16rem]">
                        <Link
                          href={`/clients/${row.entry.accountId}`}
                          className="text-ink block truncate font-semibold underline-offset-2 hover:underline"
                        >
                          {row.entry.name}
                        </Link>
                        <span className="text-muted block truncate text-xs">
                          {row.entry.ownerEmail ?? '—'} · signed up{' '}
                          {formatDate(row.entry.createdAt)}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-ink-2 text-sm">
                          <span className="text-muted tabular mr-1.5 text-xs">
                            {String(row.stage).padStart(2, '0')}
                          </span>
                          {meta.label}
                        </span>
                      </TD>
                      <TD align="right">
                        <span className="inline-flex flex-col items-end gap-0.5">
                          <span className="text-ink-2 tabular text-sm">
                            {row.days === null
                              ? 'unknown'
                              : `${row.days} day${row.days === 1 ? '' : 's'}`}
                          </span>
                          {row.stalled ? (
                            <Pill tone="warn" glyph="▲">
                              Stalled
                            </Pill>
                          ) : null}
                        </span>
                      </TD>
                      <TD align="right" className="text-ink-2 tabular">
                        {row.entry.health.completion.percent}%
                      </TD>
                      <TD className="text-ink-2">
                        {row.entry.managerName ?? (
                          <span className="text-muted">Unassigned</span>
                        )}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.entry.openTickets > 0 ? (
                          <Link
                            href={`/support?accountId=${row.entry.accountId}`}
                            className="text-ink-2 underline-offset-2 hover:underline"
                          >
                            {row.entry.openTickets}
                          </Link>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </TD>
                      <TD align="right">
                        <span className="inline-flex gap-1.5">
                          <ButtonLink
                            href={`/clients/${row.entry.accountId}`}
                            size="sm"
                          >
                            Open
                          </ButtonLink>
                          {canTicket ? (
                            <ButtonLink
                              href={`/support/new?accountId=${row.entry.accountId}&category=onboarding&subject=${encodeURIComponent(`Onboarding: stuck at ${meta.label.toLowerCase()}`)}`}
                              size="sm"
                            >
                              Ticket
                            </ButtonLink>
                          ) : null}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <ScopeLine>
        <span>
          Stalled = {stalledAfter}+ days in one stage (System Settings).
        </span>
        <span aria-hidden>·</span>
        <span>Days are whole 24-hour periods; dates in {adminTimezone()}.</span>
        <span aria-hidden>·</span>
        <span>Setup % is the completion score, not health.</span>
      </ScopeLine>
    </div>
  );
}

const STAGE_DEFINITION: Record<OnboardingStage, string> = {
  1: 'Signed up; the welcome wizard’s workspace step is not saved.',
  2: 'Workspace details saved; no plan chosen yet.',
  3: 'Welcome wizard finished; no WhatsApp, Instagram or web channel live.',
  4: 'WhatsApp connected but the number is not registered or the WABA is not subscribed to our app.',
  5: 'A channel is live but nothing has been sent successfully yet.',
  6: 'At least one outbound message that did not fail (the web widget has no delivery receipts, so “sent” counts).',
};
