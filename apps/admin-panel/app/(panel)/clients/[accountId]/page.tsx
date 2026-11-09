import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { HealthChecks } from '@/components/clients/health-checks';
import { InlineAction } from '@/components/clients/inline-action';
import { LifecycleForm } from '@/components/clients/lifecycle-form';
import { NoteForm } from '@/components/clients/note-form';
import { OwnershipForm } from '@/components/clients/ownership-form';
import { TaskForm } from '@/components/clients/task-form';
import {
  LIFECYCLE_STYLE,
  SERVICE_TIER_LABEL,
  SeverityBadge,
  TicketStatusBadge,
} from '@/components/ops/badges';
import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Callout, ScopeLine } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { setTaskStatus, toggleNotePin } from '@/lib/actions/clients';
import { can, requireCapability } from '@/lib/auth';
import {
  formatAgo,
  formatDate,
  formatDateTime,
  formatNumber,
} from '@/lib/format';
import { isIncident } from '@/lib/health/rules';
import { isUuid } from '@/lib/ids';
import { isLifecycleStage } from '@/lib/lifecycle';
import {
  getPerformance,
  listClientTickets,
  listLifecycleEvents,
  listNotes,
  listTasks,
  resolveWindow,
} from '@/lib/queries/clients';
import { getRosterEntry } from '@/lib/queries/roster';
import { assignableStaff } from '@/lib/queries/staff';
import { ROLE_LABEL } from '@/lib/staff/roles';

export const metadata: Metadata = {
  title: 'Customer 360 · Converse360 Control Center',
};

export default async function ClientOverviewPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const client = await getRosterEntry(accountId);
  if (!client) notFound();

  const window = await resolveWindow({ period: '30d' });
  const [performance, notes, tasks, tickets, transitions, staffList] =
    await Promise.all([
      getPerformance(accountId, window),
      listNotes(accountId),
      listTasks(accountId),
      listClientTickets(accountId),
      listLifecycleEvents(accountId),
      assignableStaff(),
    ]);

  const issues = client.health.checks.filter(isIncident);
  const openTickets = tickets.filter(
    (t) => !['resolved', 'closed'].includes(t.status)
  );
  const t = performance.totals;
  const deliveryRate = t.msgsOut > 0 ? (t.delivered / t.msgsOut) * 100 : null;
  const canManage = can(staff, 'clients.manage');
  const canNotes = can(staff, 'clients.notes');
  const staffOptions = staffList.map((s) => ({
    id: s.id,
    name: s.name,
    role: ROLE_LABEL[s.role],
  }));

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <ScopeLine>
          <span>
            {window.label} · {window.timezone}
          </span>
          <span aria-hidden>·</span>
          <span>
            Source: the workspace&apos;s own analytics functions (migration 089)
          </span>
          <span aria-hidden>·</span>
          <Link
            href={`/clients/${accountId}/performance`}
            className="text-primary font-semibold hover:underline"
          >
            Full performance →
          </Link>
        </ScopeLine>
        <StatRow columns={5}>
          <StatTile
            label="Outbound messages"
            value={formatNumber(t.msgsOut)}
            delta={{
              current: t.msgsOut,
              previous: t.prev.msgsOut,
              better: 'up',
              label: 'vs previous 30 days',
            }}
          />
          <StatTile
            label="Delivered"
            value={deliveryRate === null ? '—' : `${deliveryRate.toFixed(1)}%`}
            context={
              deliveryRate === null
                ? 'nothing sent'
                : `${formatNumber(t.delivered)} of ${formatNumber(t.msgsOut)}`
            }
            tone={
              deliveryRate !== null && deliveryRate < 75 ? 'warning' : 'neutral'
            }
          />
          <StatTile
            label="Failed"
            value={formatNumber(t.failed)}
            delta={{
              current: t.failed,
              previous: t.prev.failed,
              better: 'down',
              label: 'vs previous 30 days',
            }}
            tone={t.failed > 0 ? 'warning' : 'neutral'}
          />
          <StatTile
            label="Active conversations"
            value={formatNumber(t.convsActive)}
            delta={{
              current: t.convsActive,
              previous: t.prev.convsActive,
              better: 'up',
              label: 'vs previous 30 days',
            }}
          />
          <StatTile
            label="Last message"
            value={
              client.lastMessageAt ? formatAgo(client.lastMessageAt) : 'Never'
            }
            context={
              client.lastMessageAt
                ? formatDateTime(client.lastMessageAt)
                : 'no conversation yet'
            }
          />
        </StatRow>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Needs attention"
              description="Critical and attention checks from the latest evaluation. Unknown checks are on the Channels & health tab."
              action={
                <Link
                  href={`/clients/${accountId}/channels`}
                  className="text-primary text-xs font-semibold hover:underline"
                >
                  All checks
                </Link>
              }
            />
            {issues.length === 0 ? (
              <EmptyState title="Nothing needs action">
                No check is critical or in attention. Evaluated{' '}
                {formatAgo(client.health.evaluatedAt)}.
              </EmptyState>
            ) : (
              <HealthChecks
                checks={issues}
                accountId={accountId}
                canTicket={can(staff, 'tickets.work')}
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Notes"
              description="Internal. Customers never see these. Pinned notes stay on top."
            />
            {canNotes ? (
              <CardBody className="border-line border-b">
                <NoteForm accountId={accountId} />
              </CardBody>
            ) : null}
            {notes.length === 0 ? (
              <EmptyState>
                No notes yet. Record calls, agreements and things to watch for
                here.
              </EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {notes.map((note) => (
                  <li key={note.id} className="px-5 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-ink-2 min-w-0 text-sm leading-relaxed whitespace-pre-wrap">
                        {note.pinned ? (
                          <span className="bg-warn-soft text-warn-fg mr-2 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase">
                            Pinned
                          </span>
                        ) : null}
                        {note.body}
                      </p>
                      {canNotes ? (
                        <InlineAction
                          action={toggleNotePin}
                          fields={{ accountId, noteId: note.id }}
                          variant="ghost"
                        >
                          {note.pinned ? 'Unpin' : 'Pin'}
                        </InlineAction>
                      ) : null}
                    </div>
                    <p className="text-muted mt-1 text-xs">
                      {note.author} · {formatDateTime(note.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Follow-up tasks"
              description="Account-manager and technical-owner work for this client."
            />
            {canNotes ? (
              <CardBody className="border-line border-b">
                <TaskForm
                  accountId={accountId}
                  staff={staffOptions}
                  defaultAssigneeId={client.managerId}
                />
              </CardBody>
            ) : null}
            {tasks.length === 0 ? (
              <EmptyState>
                No follow-ups. Add one above to put it in someone&apos;s queue.
              </EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {tasks.map((task) => {
                  const overdue =
                    task.status === 'open' &&
                    task.dueOn &&
                    new Date(task.dueOn) < new Date(new Date().toDateString());
                  return (
                    <li
                      key={task.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <p
                          className={`text-sm ${task.status === 'done' ? 'text-muted line-through' : 'text-ink'}`}
                        >
                          {task.title}
                        </p>
                        <p className="text-muted mt-0.5 text-xs">
                          {task.assigneeName ?? 'Unassigned'}
                          {task.dueOn ? ` · due ${formatDate(task.dueOn)}` : ''}
                          {overdue ? (
                            <span className="text-bad-fg font-semibold">
                              {' '}
                              · overdue
                            </span>
                          ) : null}
                          {task.status === 'done' && task.completedAt
                            ? ` · done ${formatDate(task.completedAt)} by ${task.completedBy}`
                            : ''}
                        </p>
                      </div>
                      {canNotes ? (
                        <InlineAction
                          action={setTaskStatus}
                          fields={{
                            accountId,
                            taskId: task.id,
                            status: task.status === 'open' ? 'done' : 'open',
                          }}
                          variant={
                            task.status === 'open' ? 'secondary' : 'ghost'
                          }
                        >
                          {task.status === 'open' ? 'Mark done' : 'Reopen'}
                        </InlineAction>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Ownership"
              description="Who looks after this client on our side."
            />
            <CardBody>
              {canManage ? (
                <OwnershipForm
                  accountId={accountId}
                  staff={staffOptions}
                  current={{
                    accountManagerId: client.managerId,
                    accountManagerName: client.managerName,
                    backupManagerId: client.backupManagerId,
                    backupManagerName: client.backupManagerName,
                    supportLeadId: client.supportLeadId,
                    supportLeadName: client.supportLeadName,
                    serviceTier: client.serviceTier,
                    tags: client.tags,
                  }}
                />
              ) : (
                <Facts
                  items={[
                    {
                      label: 'Account manager',
                      value: client.managerName ?? 'Unassigned',
                    },
                    { label: 'Backup', value: client.backupManagerName ?? '—' },
                    {
                      label: 'Support lead',
                      value: client.supportLeadName ?? '—',
                    },
                    {
                      label: 'Service tier',
                      value:
                        SERVICE_TIER_LABEL[client.serviceTier] ??
                        client.serviceTier,
                    },
                    {
                      label: 'Tags',
                      value: client.tags.length ? client.tags.join(', ') : '—',
                    },
                  ]}
                />
              )}
              {staffOptions.length === 0 ? (
                <DerivedNote>
                  No staff accounts exist yet, so there is nobody to assign.
                  Create them in Staff &amp; Access.
                </DerivedNote>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Lifecycle" />
            <CardBody className="space-y-4">
              <p className="text-ink-2 text-sm">
                <strong className="text-ink">
                  {LIFECYCLE_STYLE[client.lifecycle.stage].label}
                </strong>
                {' — '}
                {client.lifecycle.pinned
                  ? `pinned: ${client.lifecycleReason ?? 'no reason recorded'}`
                  : client.lifecycle.because}
              </p>
              {canManage ? (
                <>
                  <Callout tone="neutral">
                    A stage is a classification for the portfolio. Pinning
                    &ldquo;suspended&rdquo; does not stop this workspace sending
                    anything — access follows its subscription.
                  </Callout>
                  <LifecycleForm
                    accountId={accountId}
                    pinned={client.lifecycle.pinned}
                    currentStage={client.lifecycle.stage}
                  />
                </>
              ) : null}
              {transitions.length > 0 ? (
                <div className="border-line border-t pt-3">
                  <p className="text-muted mb-2 text-xs font-semibold">
                    Recent transitions
                  </p>
                  <ul className="space-y-2">
                    {transitions.slice(0, 5).map((event) => (
                      <li key={event.id} className="text-xs">
                        <span className="text-ink-2">
                          {event.fromStage && isLifecycleStage(event.fromStage)
                            ? LIFECYCLE_STYLE[event.fromStage].label
                            : '—'}{' '}
                          →{' '}
                          {event.toStage && isLifecycleStage(event.toStage)
                            ? LIFECYCLE_STYLE[event.toStage].label
                            : 'derived'}
                        </span>
                        <span className="text-muted">
                          {' '}
                          · {event.reason} · {event.actor},{' '}
                          {formatDate(event.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Setup completion · ${client.health.completion.percent}%`}
              description="How much of the C2.0 setup is done. Independent of health: a fully set-up workspace can still be critical."
            />
            <ul className="divide-line divide-y">
              {client.health.completion.items.map((item) => (
                <li
                  key={item.key}
                  className="flex items-start gap-3 px-5 py-2.5"
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                      item.done === null
                        ? 'bg-neutral-soft text-neutral-fg'
                        : item.done
                          ? 'bg-good-soft text-good-fg'
                          : 'bg-surface-3 text-muted'
                    }`}
                  >
                    {item.done === null ? '–' : item.done ? '✓' : ''}
                  </span>
                  <div className="min-w-0">
                    <p className="text-ink text-sm">
                      {item.label}{' '}
                      <span className="text-muted text-xs">
                        {item.weight}%
                        {item.done === null
                          ? ' · not tracked'
                          : item.done
                            ? ' · done'
                            : ' · to do'}
                      </span>
                    </p>
                    <p className="text-muted text-xs leading-relaxed">
                      {item.hint}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Open tickets"
              action={
                <Link
                  href={`/clients/${accountId}/tickets`}
                  className="text-primary text-xs font-semibold hover:underline"
                >
                  All tickets
                </Link>
              }
            />
            {openTickets.length === 0 ? (
              <EmptyState>No open tickets for this client.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {openTickets.slice(0, 5).map((ticket) => (
                  <li key={ticket.id} className="px-5 py-3">
                    <Link
                      href={`/support/${ticket.number}`}
                      className="text-ink text-sm font-semibold hover:underline"
                    >
                      SUP-{ticket.number} · {ticket.subject}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <SeverityBadge severity={ticket.severity} />
                      <TicketStatusBadge status={ticket.status} />
                      <span className="text-muted">
                        {ticket.tier} · {ticket.assigneeName ?? 'unassigned'} ·{' '}
                        {formatAgo(ticket.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
