import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  CATEGORY_LABEL,
  HealthBadge,
  LifecycleBadge,
  SEVERITY_STYLE,
  SOURCE_LABEL,
  SeverityBadge,
  SlaBadge,
  TICKET_STATUS_STYLE,
  TIER_LABEL,
  TicketStatusBadge,
} from '@/components/ops/badges';
import { TicketActionForm } from '@/components/support/ticket-action-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { ButtonLink, Callout, PageHeader } from '@/components/ui/page';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import { isIncident } from '@/lib/health/rules';
import { formatAgo, formatDateTime } from '@/lib/format';
import { getRosterEntry } from '@/lib/queries/roster';
import { listStaff } from '@/lib/queries/staff';
import {
  getTicketByNumber,
  listTicketEvents,
  type TicketEvent,
} from '@/lib/queries/tickets';
import {
  OPEN_STATUSES,
  SEVERITIES,
  clockFor,
  type TicketStatus,
} from '@/lib/sla';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ number: string }>;
}): Promise<Metadata> {
  const { number } = await params;
  return { title: `SUP-${number} · Converse360 Control Center` };
}

/**
 * One ticket: what it is about, its two SLA clocks, its append-only change
 * log, and every control that moves it — each a small form posting to
 * `updateTicket`, each recording an event and an audit row.
 */
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ existing?: string }>;
}) {
  const staff = await requireCapability('tickets.work');
  const { number: raw } = await params;
  const { existing } = await searchParams;

  const number = Number(raw.replace(/^sup-/i, ''));
  if (!Number.isInteger(number) || number <= 0) notFound();

  const ticket = await getTicketByNumber(number);
  if (!ticket) notFound();

  const [events, staffList, client] = await Promise.all([
    listTicketEvents(ticket.id),
    listStaff({ activeOnly: true }),
    ticket.accountId ? getRosterEntry(ticket.accountId) : null,
  ]);

  const now = new Date();
  const open = (OPEN_STATUSES as string[]).includes(ticket.status);
  const firstClock = clockFor({
    dueAt: ticket.firstResponseDueAt,
    stoppedAt: ticket.firstRespondedAt ?? ticket.resolvedAt,
    startedAt: ticket.createdAt,
    now,
  });
  const resolutionClock = clockFor({
    dueAt: ticket.resolutionDueAt,
    stoppedAt: ticket.resolvedAt,
    startedAt: ticket.createdAt,
    now,
  });
  const openChecks = client?.health.checks.filter(isIncident) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/support', label: 'Support Desk' }}
        eyebrow={`SUP-${ticket.number}`}
        title={ticket.subject}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={ticket.severity} />
            <TicketStatusBadge status={ticket.status} />
            <Badge>{TIER_LABEL[ticket.tier] ?? ticket.tier}</Badge>
            <Badge tone="outline">
              {CATEGORY_LABEL[ticket.category] ?? ticket.category}
            </Badge>
            <span className="text-muted text-xs">
              via {SOURCE_LABEL[ticket.source] ?? ticket.source} · opened{' '}
              {formatAgo(ticket.createdAt)} by {ticket.createdBy}
            </span>
          </span>
        }
        actions={
          ticket.accountId ? (
            <ButtonLink href={`/clients/${ticket.accountId}`}>
              Open client
            </ButtonLink>
          ) : undefined
        }
      />

      {existing ? (
        <Callout tone="info" title="This incident already had an open ticket">
          Opening another would split the work, so you were brought here
          instead. Add what you found as a note.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {ticket.description ? (
            <Card>
              <CardHeader title="Description" />
              <CardBody>
                <p className="text-ink-2 text-sm leading-relaxed whitespace-pre-wrap">
                  {ticket.description}
                </p>
              </CardBody>
            </Card>
          ) : null}

          {ticket.resolution ? (
            <Card>
              <CardHeader
                title="Resolution"
                description={
                  ticket.resolvedAt
                    ? `Recorded ${formatDateTime(ticket.resolvedAt)}.`
                    : 'Recorded before the ticket was reopened.'
                }
              />
              <CardBody>
                <p className="text-ink-2 text-sm leading-relaxed whitespace-pre-wrap">
                  {ticket.resolution}
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Activity"
              description="Append-only. A correction is a new note, never an edit."
            />
            <ol className="divide-line divide-y">
              {events.map((entry) => (
                <EventRow key={entry.id} entry={entry} />
              ))}
            </ol>
            <div className="border-line border-t px-5 py-4">
              <TicketActionForm ticketId={ticket.id} intent="comment">
                <Field
                  label="Add an internal note"
                  hint={
                    ticket.firstRespondedAt
                      ? 'Internal only — the customer is not notified (tickets have no customer channel yet).'
                      : 'Internal only — the customer is not notified. The first note stops the first-response clock.'
                  }
                >
                  <Textarea
                    name="body"
                    rows={4}
                    maxLength={8000}
                    required
                    placeholder="What you checked, what you changed, what is next. Never paste a password, OTP or token."
                  />
                </Field>
                <SubmitButton pendingLabel="Saving…">Add note</SubmitButton>
              </TicketActionForm>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="SLA"
              description={`Clocks run 24×7 and do not pause while waiting on the customer. Times in ${adminTimezone()}.`}
            />
            <CardBody>
              <Facts
                items={[
                  {
                    label: 'First response',
                    value: <SlaBadge clock={firstClock} />,
                    hint: ticket.firstRespondedAt
                      ? `responded ${formatDateTime(ticket.firstRespondedAt)}`
                      : `due ${formatDateTime(ticket.firstResponseDueAt)}`,
                  },
                  {
                    label: 'Resolution',
                    value: <SlaBadge clock={resolutionClock} />,
                    hint: ticket.resolvedAt
                      ? `resolved ${formatDateTime(ticket.resolvedAt)}`
                      : `due ${formatDateTime(ticket.resolutionDueAt)}`,
                  },
                  {
                    label: 'Assignee',
                    value: ticket.assigneeName ?? 'Unassigned',
                  },
                  {
                    label: 'Requester',
                    value: ticket.requester ?? '—',
                  },
                  ...(ticket.closedAt
                    ? [
                        {
                          label: 'Closed',
                          value: formatDateTime(ticket.closedAt),
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Work this ticket" />
            <CardBody className="space-y-5">
              {open ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TicketActionForm ticketId={ticket.id} intent="assign">
                      <Field label="Assignee">
                        <Select
                          name="assignee"
                          defaultValue={ticket.assigneeId ?? ''}
                        >
                          <option value="">Unassigned</option>
                          {staffList.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="secondary" pendingLabel="Saving…">
                        Assign
                      </SubmitButton>
                    </TicketActionForm>

                    <TicketActionForm ticketId={ticket.id} intent="status">
                      <Field label="Status">
                        <Select
                          name="status"
                          defaultValue={
                            [
                              'open',
                              'in_progress',
                              'waiting_customer',
                            ].includes(ticket.status)
                              ? ticket.status
                              : 'in_progress'
                          }
                        >
                          {(
                            [
                              'open',
                              'in_progress',
                              'waiting_customer',
                            ] as TicketStatus[]
                          ).map((status) => (
                            <option key={status} value={status}>
                              {TICKET_STATUS_STYLE[status].label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="secondary" pendingLabel="Saving…">
                        Set status
                      </SubmitButton>
                    </TicketActionForm>
                  </div>

                  {staff.id && ticket.assigneeId !== staff.id ? (
                    <TicketActionForm ticketId={ticket.id} intent="assign_me">
                      <SubmitButton variant="ghost" pendingLabel="Saving…">
                        Assign to me
                      </SubmitButton>
                    </TicketActionForm>
                  ) : null}

                  <div className="border-line grid gap-3 border-t pt-4 sm:grid-cols-2">
                    <TicketActionForm ticketId={ticket.id} intent="severity">
                      <Field
                        label="Severity"
                        hint="SLA due times are recomputed from when the ticket was opened."
                      >
                        <Select name="severity" defaultValue={ticket.severity}>
                          {SEVERITIES.map((severity) => (
                            <option key={severity} value={severity}>
                              {SEVERITY_STYLE[severity].label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="secondary" pendingLabel="Saving…">
                        Change severity
                      </SubmitButton>
                    </TicketActionForm>

                    <TicketActionForm ticketId={ticket.id} intent="escalate">
                      <Field
                        label="Escalate to"
                        hint="L1 guided setup · L2 Meta/WABA · L3 API/webhooks · Billing."
                      >
                        <Select
                          name="tier"
                          defaultValue={
                            ticket.tier === 'L1'
                              ? 'L2'
                              : ticket.tier === 'L2'
                                ? 'L3'
                                : ticket.tier
                          }
                        >
                          {['L1', 'L2', 'L3', 'billing'].map((tier) => (
                            <option key={tier} value={tier}>
                              {TIER_LABEL[tier]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Input
                        name="note"
                        maxLength={500}
                        placeholder="Why (optional)"
                      />
                      <SubmitButton variant="secondary" pendingLabel="Saving…">
                        Move queue
                      </SubmitButton>
                    </TicketActionForm>
                  </div>

                  <div className="border-line border-t pt-4">
                    <TicketActionForm ticketId={ticket.id} intent="resolve">
                      <Field
                        label="Resolve"
                        hint="Required: what was actually wrong, what fixed it, and how you confirmed it. This is the resolution evidence."
                      >
                        <Textarea
                          name="resolution"
                          rows={4}
                          maxLength={8000}
                          required
                        />
                      </Field>
                      <SubmitButton pendingLabel="Resolving…">
                        Mark resolved
                      </SubmitButton>
                    </TicketActionForm>
                  </div>
                </>
              ) : (
                <>
                  {ticket.status === 'resolved' ? (
                    <TicketActionForm ticketId={ticket.id} intent="close">
                      <p className="text-muted text-xs leading-relaxed">
                        Close once the customer has confirmed the fix, or when
                        no reply is expected.
                      </p>
                      <SubmitButton variant="secondary" pendingLabel="Closing…">
                        Close ticket
                      </SubmitButton>
                    </TicketActionForm>
                  ) : null}
                  <TicketActionForm ticketId={ticket.id} intent="reopen">
                    <Field
                      label="Reopen"
                      hint="The resolution clock resumes against its original due time."
                    >
                      <Input
                        name="reason"
                        maxLength={500}
                        required
                        placeholder="Why it is not fixed"
                      />
                    </Field>
                    <SubmitButton variant="secondary" pendingLabel="Reopening…">
                      Reopen ticket
                    </SubmitButton>
                  </TicketActionForm>
                </>
              )}
              {!staff.id ? (
                <p className="text-muted text-xs">
                  You are on the break-glass login, which can work tickets but
                  cannot own one.
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Client context"
              action={
                ticket.accountId ? (
                  <Link
                    href={`/clients/${ticket.accountId}/channels`}
                    className="text-muted hover:text-ink text-xs font-medium underline-offset-2 hover:underline"
                  >
                    Health detail
                  </Link>
                ) : undefined
              }
            />
            <CardBody>
              {client ? (
                <div className="space-y-4">
                  <div>
                    <Link
                      href={`/clients/${client.accountId}`}
                      className="text-ink font-semibold underline-offset-2 hover:underline"
                    >
                      {client.name}
                    </Link>
                    <p className="text-muted text-xs">
                      {client.planDisplayName ?? 'No plan'} ·{' '}
                      {client.managerName
                        ? `managed by ${client.managerName}`
                        : 'no account manager'}
                    </p>
                    <p className="mt-2 flex flex-wrap gap-1.5">
                      <LifecycleBadge
                        stage={client.lifecycle.stage}
                        pinned={client.lifecycle.pinned}
                        title={client.lifecycle.because}
                      />
                      <HealthBadge state={client.health.overall} />
                    </p>
                  </div>
                  {openChecks.length > 0 ? (
                    <ul className="divide-line divide-y">
                      {openChecks.map((check) => (
                        <li
                          key={check.key}
                          className="py-2.5 first:pt-0 last:pb-0"
                        >
                          <p className="flex items-center justify-between gap-2 text-sm">
                            <span className="text-ink-2 font-medium">
                              {check.label}
                            </span>
                            <HealthBadge state={check.state} />
                          </p>
                          <p className="text-muted mt-0.5 text-xs leading-relaxed">
                            {check.evidence}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted text-sm">
                      No health check for this client is critical or needs
                      attention right now.
                    </p>
                  )}
                  <DerivedNote>
                    Evaluated {formatAgo(client.health.evaluatedAt)} from stored
                    evidence.
                  </DerivedNote>
                </div>
              ) : ticket.accountName ? (
                <p className="text-muted text-sm">
                  {ticket.accountName} no longer exists — the ticket keeps its
                  name so the record survives the workspace.
                </p>
              ) : (
                <p className="text-muted text-sm">
                  Internal ticket — not about one client.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

const STATUS_WORD: Record<string, string> = Object.fromEntries(
  Object.entries(TICKET_STATUS_STYLE).map(([key, value]) => [key, value.label])
);

function describe(entry: TicketEvent): string {
  switch (entry.kind) {
    case 'created':
      return 'opened the ticket';
    case 'comment':
      return 'added a note';
    case 'status':
      return `moved it from ${STATUS_WORD[entry.fromValue ?? ''] ?? entry.fromValue} to ${STATUS_WORD[entry.toValue ?? ''] ?? entry.toValue}`;
    case 'assign':
      return entry.toValue
        ? `assigned it to ${entry.toValue}${entry.fromValue ? ` (was ${entry.fromValue})` : ''}`
        : `unassigned it${entry.fromValue ? ` from ${entry.fromValue}` : ''}`;
    case 'severity':
      return `changed severity from ${entry.fromValue} to ${entry.toValue}`;
    case 'tier':
      return `moved it from ${TIER_LABEL[entry.fromValue ?? ''] ?? entry.fromValue} to ${TIER_LABEL[entry.toValue ?? ''] ?? entry.toValue}`;
    case 'diagnostic':
      return 'attached a health diagnostic';
    case 'resolution':
      return 'resolved it';
    default:
      return entry.kind;
  }
}

function EventRow({ entry }: { entry: TicketEvent }) {
  const snapshot = entry.kind === 'diagnostic' ? entry.data : null;
  return (
    <li className="px-5 py-3.5">
      <p className="text-sm">
        <span className="text-ink font-semibold">{entry.actor}</span>{' '}
        <span className="text-ink-2">{describe(entry)}</span>
        <span
          className="text-muted ml-2 text-xs"
          title={formatDateTime(entry.createdAt)}
        >
          {formatAgo(entry.createdAt)}
        </span>
      </p>
      {snapshot ? (
        <div className="bg-surface-2 border-ring mt-2 space-y-1 rounded-lg border px-3 py-2.5 text-xs">
          <p className="text-ink-2 flex flex-wrap items-center gap-2 font-semibold">
            {String(snapshot.label ?? snapshot.key)}
            {typeof snapshot.state === 'string' ? (
              <HealthBadge
                state={
                  snapshot.state as Parameters<typeof HealthBadge>[0]['state']
                }
              />
            ) : null}
          </p>
          {snapshot.evidence ? (
            <p className="text-ink-2">{String(snapshot.evidence)}</p>
          ) : null}
          {snapshot.action ? (
            <p className="text-muted">Next step: {String(snapshot.action)}</p>
          ) : null}
          <p className="text-muted">
            Evidence time{' '}
            {snapshot.checkedAt
              ? formatDateTime(String(snapshot.checkedAt))
              : 'not recorded'}{' '}
            · evaluated{' '}
            {snapshot.evaluatedAt
              ? formatDateTime(String(snapshot.evaluatedAt))
              : '—'}
          </p>
        </div>
      ) : entry.body && entry.kind !== 'created' ? (
        <p
          className={`mt-1.5 text-sm leading-relaxed whitespace-pre-wrap ${
            entry.kind === 'resolution'
              ? 'bg-good-soft text-good-fg rounded-lg px-3 py-2'
              : 'text-ink-2'
          }`}
        >
          {entry.body}
        </p>
      ) : null}
    </li>
  );
}
