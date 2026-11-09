import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Support desk reads (C360-032, migration 098).
 *
 * `support_tickets.number` is a BIGINT; it is cast to int here because a JS
 * BigInt cannot cross the server → client boundary or go through Intl. A
 * desk would need two billion tickets before that cast lies.
 *
 * Tickets are internal operations data, not tenant data — there is no RLS
 * question here (the table is owner-only). Filtering by `accountId` is a
 * view choice, not a security boundary.
 */

export type TicketRow = {
  id: string;
  number: number;
  accountId: string | null;
  accountName: string | null;
  subject: string;
  source: string;
  category: string;
  severity: string;
  tier: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  requester: string | null;
  incidentKey: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketDetail = TicketRow & {
  description: string | null;
  resolution: string | null;
};

export type TicketEvent = {
  id: string;
  kind: string;
  body: string | null;
  fromValue: string | null;
  toValue: string | null;
  data: Record<string, unknown>;
  actor: string;
  createdAt: Date;
};

export const TICKET_QUEUES = [
  'open',
  'mine',
  'unassigned',
  'breached',
  'resolved',
  'all',
] as const;
export type TicketQueue = (typeof TICKET_QUEUES)[number];

export type TicketListParams = {
  queue?: TicketQueue;
  /** The signed-in staff id, for `mine`. Null for break-glass. */
  staffId: string | null;
  tier?: string;
  severity?: string;
  category?: string;
  accountId?: string;
  assignee?: string;
  q?: string;
  page?: number;
  perPage?: number;
};

const COLUMNS = Prisma.sql`
  t.id as "id",
  (t.number)::int as "number",
  t.account_id as "accountId",
  coalesce(a.name, t.account_name) as "accountName",
  t.subject as "subject",
  t.source as "source",
  t.category as "category",
  t.severity as "severity",
  t.tier as "tier",
  t.status as "status",
  t.assignee_staff_id as "assigneeId",
  st.full_name as "assigneeName",
  t.requester as "requester",
  t.incident_key as "incidentKey",
  t.first_response_due_at as "firstResponseDueAt",
  t.resolution_due_at as "resolutionDueAt",
  t.first_responded_at as "firstRespondedAt",
  t.resolved_at as "resolvedAt",
  t.closed_at as "closedAt",
  t.created_by as "createdBy",
  t.created_at as "createdAt",
  t.updated_at as "updatedAt"`;

const FROM = Prisma.sql`
  from support_tickets t
  left join accounts a on a.id = t.account_id
  left join admin_staff st on st.id = t.assignee_staff_id`;

const OPEN = Prisma.sql`t.status not in ('resolved', 'closed')`;

/**
 * A ticket is breached when a clock that is still running has passed its due
 * time: the first-response clock before anyone has answered, or the
 * resolution clock at any point before resolution. Same rule as
 * `clockFor()` in lib/sla.ts, restated in SQL so the queue can filter on it.
 */
const BREACHED = Prisma.sql`(
  ${OPEN} and (
    (t.first_responded_at is null and t.first_response_due_at < now())
    or (t.resolved_at is null and t.resolution_due_at < now())
  )
)`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildWhere(params: TicketListParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  switch (params.queue ?? 'open') {
    case 'open':
      conditions.push(OPEN);
      break;
    case 'mine':
      conditions.push(OPEN);
      // Break-glass has no staff row, so it owns nothing — an empty queue,
      // not every ticket.
      conditions.push(
        params.staffId
          ? Prisma.sql`t.assignee_staff_id = ${params.staffId}::uuid`
          : Prisma.sql`false`
      );
      break;
    case 'unassigned':
      conditions.push(OPEN, Prisma.sql`t.assignee_staff_id is null`);
      break;
    case 'breached':
      conditions.push(BREACHED);
      break;
    case 'resolved':
      conditions.push(Prisma.sql`t.status in ('resolved', 'closed')`);
      break;
    case 'all':
      break;
  }

  if (params.tier) conditions.push(Prisma.sql`t.tier = ${params.tier}`);
  if (params.severity) {
    conditions.push(Prisma.sql`t.severity = ${params.severity}`);
  }
  if (params.category) {
    conditions.push(Prisma.sql`t.category = ${params.category}`);
  }
  if (params.accountId && UUID_RE.test(params.accountId)) {
    conditions.push(Prisma.sql`t.account_id = ${params.accountId}::uuid`);
  }
  if (params.assignee === 'none') {
    conditions.push(Prisma.sql`t.assignee_staff_id is null`);
  } else if (params.assignee && UUID_RE.test(params.assignee)) {
    conditions.push(Prisma.sql`t.assignee_staff_id = ${params.assignee}::uuid`);
  }

  const q = params.q?.trim();
  if (q) {
    // "SUP-1042", "1042" and "#1042" all find ticket 1042.
    const digits = q.replace(/^(sup-|#)/i, '');
    const like = `%${q}%`;
    conditions.push(
      /^\d{1,12}$/.test(digits)
        ? Prisma.sql`(t.number = ${Number(digits)} or t.subject ilike ${like})`
        : Prisma.sql`(
            t.subject ilike ${like}
            or coalesce(a.name, t.account_name) ilike ${like}
            or t.requester ilike ${like}
          )`
    );
  }

  return conditions.length
    ? Prisma.sql`where ${Prisma.join(conditions, ' and ')}`
    : Prisma.empty;
}

/**
 * Most urgent first: breached, then by severity, then the soonest-due clock.
 * The resolved queue reads newest-resolved first instead.
 */
const URGENCY = Prisma.sql`
  order by
    (case when ${BREACHED} then 0 else 1 end),
    (case t.severity when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end),
    coalesce(
      case when t.first_responded_at is null then t.first_response_due_at end,
      t.resolution_due_at
    ) asc nulls last,
    t.created_at asc`;

export async function listTickets(params: TicketListParams): Promise<{
  rows: TicketRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
}> {
  const perPage = Math.min(Math.max(params.perPage ?? 25, 5), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);
  const orderBy =
    params.queue === 'resolved'
      ? Prisma.sql`order by coalesce(t.closed_at, t.resolved_at) desc nulls last`
      : URGENCY;

  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<TicketRow[]>(Prisma.sql`
      select ${COLUMNS}
      ${FROM}
      ${where}
      ${orderBy}
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      select (count(*))::int as "total"
      ${FROM}
      ${where}
    `),
  ]);

  return {
    rows,
    total: totals?.total ?? 0,
    page,
    perPage,
    pageCount: Math.max(Math.ceil((totals?.total ?? 0) / perPage), 1),
  };
}

export type DeskStats = {
  open: number;
  unassigned: number;
  breached: number;
  waitingCustomer: number;
  escalated: number;
  mine: number;
  /** Resolved in the trailing 30 days. */
  resolved30d: number;
  /** Mean minutes from creation to resolution, over `resolved30d`. */
  meanResolutionMinutes: number | null;
  /** Of `resolved30d`, the share resolved by their resolution due time. */
  resolvedWithinSla30d: number;
};

export async function deskStats(staffId: string | null): Promise<DeskStats> {
  const [row] = await prisma.$queryRaw<DeskStats[]>(Prisma.sql`
    select
      (count(*) filter (where ${OPEN}))::int as "open",
      (count(*) filter (where ${OPEN} and t.assignee_staff_id is null))::int as "unassigned",
      (count(*) filter (where ${BREACHED}))::int as "breached",
      (count(*) filter (where t.status = 'waiting_customer'))::int as "waitingCustomer",
      (count(*) filter (where t.status = 'escalated'))::int as "escalated",
      (count(*) filter (
        where ${OPEN} and ${staffId ? Prisma.sql`t.assignee_staff_id = ${staffId}::uuid` : Prisma.sql`false`}
      ))::int as "mine",
      (count(*) filter (where t.resolved_at >= now() - interval '30 days'))::int as "resolved30d",
      (avg(extract(epoch from (t.resolved_at - t.created_at)) / 60.0)
        filter (where t.resolved_at >= now() - interval '30 days'))::float8
        as "meanResolutionMinutes",
      (count(*) filter (
        where t.resolved_at >= now() - interval '30 days'
          and (t.resolution_due_at is null or t.resolved_at <= t.resolution_due_at)
      ))::int as "resolvedWithinSla30d"
    from support_tickets t
  `);
  return row!;
}

export async function getTicketByNumber(
  number: number
): Promise<TicketDetail | null> {
  const [row] = await prisma.$queryRaw<TicketDetail[]>(Prisma.sql`
    select ${COLUMNS},
      t.description as "description",
      t.resolution as "resolution"
    ${FROM}
    where t.number = ${number}
    limit 1
  `);
  return row ?? null;
}

export async function listTicketEvents(
  ticketId: string
): Promise<TicketEvent[]> {
  const rows = await prisma.support_ticket_events.findMany({
    where: { ticket_id: ticketId },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    fromValue: row.from_value,
    toValue: row.to_value,
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    actor: row.actor,
    createdAt: row.created_at,
  }));
}

/**
 * The open ticket for each (workspace, incident) pair — how the incident
 * monitor shows "already ticketed" instead of offering a duplicate.
 * Keyed `${accountId}:${incidentKey}`.
 */
export async function openIncidentTickets(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<
    { accountId: string; incidentKey: string; number: number }[]
  >(Prisma.sql`
    select t.account_id as "accountId", t.incident_key as "incidentKey",
      (t.number)::int as "number"
    from support_tickets t
    where t.incident_key is not null
      and t.account_id is not null
      and ${OPEN}
  `);
  return new Map(
    rows.map((row) => [`${row.accountId}:${row.incidentKey}`, row.number])
  );
}
