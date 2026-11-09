import 'server-only';

import { Prisma } from '@prisma/client';

import { adminTimezone } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { getRoster, type RosterEntry } from '@/lib/queries/roster';

/**
 * Portfolio analytics (C360-027/028) — fleet-wide, windowed, segmentable.
 *
 * ## Definitions (mirroring get_channel_kpis, migration 089)
 *
 * - outbound  = messages with sender_type in ('agent','bot')
 * - inbound   = sender_type = 'customer'
 * - delivered = outbound with status in ('delivered','read')
 * - failed    = status = 'failed'
 * - AI-written = ai_agent_id is not null (narrower than sender_type='bot')
 * - deleted messages (deleted_at) are excluded everywhere
 *
 * ## Windows
 *
 * A "30 days" window is the last 30 LOCAL days including today, in
 * ADMIN_TIMEZONE: [local midnight 29 days ago, now). The comparison window is
 * the 30 local days before that. Day buckets are local dates. The bounds are
 * computed in SQL from the database clock, so the window and the buckets can
 * never disagree about where midnight is.
 *
 * ## Segments
 *
 * The plan / account-manager filters narrow the WHOLE page to one set of
 * workspaces, resolved here from the roster (never a client-supplied id
 * list). Every query below takes that set, so a filtered page cannot show a
 * fleet-wide number next to a filtered one.
 *
 * ⚠️ Prisma bypasses RLS: these aggregates are cross-tenant by design.
 */

export const PERIODS = {
  '7d': { days: 7, label: 'Last 7 days' },
  '30d': { days: 30, label: 'Last 30 days' },
  '90d': { days: 90, label: 'Last 90 days' },
} as const;

export type PeriodKey = keyof typeof PERIODS;

export function parsePeriod(raw: string | undefined): PeriodKey {
  return raw === '7d' || raw === '90d' ? raw : '30d';
}

export type PortfolioFilters = {
  /** subscription_plans.name, or 'none' for workspaces with no plan. */
  plan?: string;
  /** admin_staff.id, or 'unassigned'. */
  manager?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps only filter values that can mean something — an unknown plan or a
 * malformed manager id is dropped rather than silently filtering to nothing.
 */
export function sanitiseFilters(
  raw: { plan?: string; manager?: string },
  roster: RosterEntry[]
): PortfolioFilters {
  const plans = new Set(roster.map((r) => r.planName).filter(Boolean));
  const out: PortfolioFilters = {};
  if (raw.plan === 'none' || (raw.plan && plans.has(raw.plan))) {
    out.plan = raw.plan;
  }
  if (
    raw.manager === 'unassigned' ||
    (raw.manager && UUID_RE.test(raw.manager))
  ) {
    out.manager = raw.manager;
  }
  return out;
}

export function applyFilters(
  roster: RosterEntry[],
  filters: PortfolioFilters
): RosterEntry[] {
  return roster.filter((entry) => {
    if (filters.plan) {
      if (
        filters.plan === 'none'
          ? entry.planName !== null
          : entry.planName !== filters.plan
      ) {
        return false;
      }
    }
    if (filters.manager) {
      if (
        filters.manager === 'unassigned'
          ? entry.managerId !== null
          : entry.managerId !== filters.manager
      ) {
        return false;
      }
    }
    return true;
  });
}

export type Window = {
  key: PeriodKey;
  days: number;
  label: string;
  start: Date;
  end: Date;
  prevStart: Date;
  timezone: string;
};

export async function resolveWindow(key: PeriodKey): Promise<Window> {
  const { days, label } = PERIODS[key];
  const timezone = adminTimezone();
  const [row] = await prisma.$queryRaw<
    { start: Date; prevStart: Date; end: Date }[]
  >(Prisma.sql`
    select
      ((date_trunc('day', now() at time zone ${timezone})
          - make_interval(days => ${days - 1}::int)) at time zone ${timezone}) as "start",
      ((date_trunc('day', now() at time zone ${timezone})
          - make_interval(days => ${2 * days - 1}::int)) at time zone ${timezone}) as "prevStart",
      now() as "end"
  `);
  return { key, days, label, timezone, ...row! };
}

/** `null` = the whole fleet; an array (possibly empty) = exactly these. */
function scopeFor(column: Prisma.Sql, ids: string[] | null): Prisma.Sql {
  return ids === null
    ? Prisma.sql`true`
    : Prisma.sql`${column} = any(${ids}::uuid[])`;
}

/* ---------------- Messaging ---------------- */

export type MessagingTotals = {
  outbound: number;
  inbound: number;
  delivered: number;
  failed: number;
  aiWritten: number;
  prevOutbound: number;
  prevInbound: number;
  prevDelivered: number;
  prevFailed: number;
  prevAiWritten: number;
};

async function messagingTotals(
  w: Window,
  ids: string[] | null
): Promise<MessagingTotals> {
  const [row] = await prisma.$queryRaw<MessagingTotals[]>(Prisma.sql`
    select
      (count(*) filter (where m.created_at >= ${w.start} and m.sender_type in ('agent','bot')))::int as "outbound",
      (count(*) filter (where m.created_at >= ${w.start} and m.sender_type = 'customer'))::int as "inbound",
      (count(*) filter (where m.created_at >= ${w.start} and m.sender_type in ('agent','bot')
                          and m.status in ('delivered','read')))::int as "delivered",
      (count(*) filter (where m.created_at >= ${w.start} and m.status = 'failed'))::int as "failed",
      (count(*) filter (where m.created_at >= ${w.start} and m.ai_agent_id is not null))::int as "aiWritten",
      (count(*) filter (where m.created_at < ${w.start} and m.sender_type in ('agent','bot')))::int as "prevOutbound",
      (count(*) filter (where m.created_at < ${w.start} and m.sender_type = 'customer'))::int as "prevInbound",
      (count(*) filter (where m.created_at < ${w.start} and m.sender_type in ('agent','bot')
                          and m.status in ('delivered','read')))::int as "prevDelivered",
      (count(*) filter (where m.created_at < ${w.start} and m.status = 'failed'))::int as "prevFailed",
      (count(*) filter (where m.created_at < ${w.start} and m.ai_agent_id is not null))::int as "prevAiWritten"
    from messages m
    join conversations c on c.id = m.conversation_id
    where m.deleted_at is null
      and m.created_at >= ${w.prevStart}
      and m.created_at < ${w.end}
      and ${scopeFor(Prisma.sql`c.account_id`, ids)}
  `);
  return row!;
}

export type DayPoint = {
  /** YYYY-MM-DD, a local date in the window's timezone. */
  day: string;
  outbound: number;
  failed: number;
  inbound: number;
};

async function dailySeries(
  w: Window,
  ids: string[] | null
): Promise<DayPoint[]> {
  return prisma.$queryRaw<DayPoint[]>(Prisma.sql`
    with days as (
      select generate_series(
        (${w.start}::timestamptz at time zone ${w.timezone})::date,
        (${w.end}::timestamptz at time zone ${w.timezone})::date,
        interval '1 day'
      )::date as day
    ),
    agg as (
      select (m.created_at at time zone ${w.timezone})::date as day,
        (count(*) filter (where m.sender_type in ('agent','bot')))::int as outbound,
        (count(*) filter (where m.status = 'failed'))::int as failed,
        (count(*) filter (where m.sender_type = 'customer'))::int as inbound
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.deleted_at is null
        and m.created_at >= ${w.start}
        and m.created_at < ${w.end}
        and ${scopeFor(Prisma.sql`c.account_id`, ids)}
      group by 1
    )
    select to_char(d.day, 'YYYY-MM-DD') as "day",
      coalesce(agg.outbound, 0) as "outbound",
      coalesce(agg.failed, 0) as "failed",
      coalesce(agg.inbound, 0) as "inbound"
    from days d
    left join agg on agg.day = d.day
    order by d.day
  `);
}

export type ChannelMixRow = { channel: string; messages: number };

async function channelMix(
  w: Window,
  ids: string[] | null
): Promise<ChannelMixRow[]> {
  return prisma.$queryRaw<ChannelMixRow[]>(Prisma.sql`
    select c.channel as "channel", (count(*))::int as "messages"
    from messages m
    join conversations c on c.id = m.conversation_id
    where m.deleted_at is null
      and m.created_at >= ${w.start}
      and m.created_at < ${w.end}
      and ${scopeFor(Prisma.sql`c.account_id`, ids)}
    group by c.channel
    order by 2 desc
  `);
}

export type ClientMessaging = {
  accountId: string;
  outbound: number;
  inbound: number;
  delivered: number;
  failed: number;
  aiWritten: number;
};

async function perClientMessaging(
  w: Window,
  ids: string[] | null
): Promise<Map<string, ClientMessaging>> {
  const rows = await prisma.$queryRaw<ClientMessaging[]>(Prisma.sql`
    select c.account_id as "accountId",
      (count(*) filter (where m.sender_type in ('agent','bot')))::int as "outbound",
      (count(*) filter (where m.sender_type = 'customer'))::int as "inbound",
      (count(*) filter (where m.sender_type in ('agent','bot') and m.status in ('delivered','read')))::int as "delivered",
      (count(*) filter (where m.status = 'failed'))::int as "failed",
      (count(*) filter (where m.ai_agent_id is not null))::int as "aiWritten"
    from messages m
    join conversations c on c.id = m.conversation_id
    where m.deleted_at is null
      and m.created_at >= ${w.start}
      and m.created_at < ${w.end}
      and ${scopeFor(Prisma.sql`c.account_id`, ids)}
    group by c.account_id
  `);
  return new Map(rows.map((row) => [row.accountId, row]));
}

/* ---------------- AI ---------------- */

export type AiTotals = {
  /** Metered usage only — reason = 'usage'. Manual deductions excluded. */
  creditsConsumed: number;
  handoffs: number;
};

async function aiTotals(w: Window, ids: string[] | null): Promise<AiTotals> {
  const [row] = await prisma.$queryRaw<AiTotals[]>(Prisma.sql`
    select
      coalesce((
        select -sum(l.delta)
        from ai_credit_ledger l
        where l.reason = 'usage'
          and l.delta < 0
          and l.created_at >= ${w.start}
          and l.created_at < ${w.end}
          and ${scopeFor(Prisma.sql`l.account_id`, ids)}
      ), 0)::int as "creditsConsumed",
      (
        select count(*)
        from conversations c
        where c.ai_handoff_at >= ${w.start}
          and c.ai_handoff_at < ${w.end}
          and ${scopeFor(Prisma.sql`c.account_id`, ids)}
      )::int as "handoffs"
  `);
  return row!;
}

/* ---------------- Support ---------------- */

export type SupportTotals = {
  everCreated: number;
  opened: number;
  resolved: number;
  backlog: number;
  /** Mean minutes from creation to resolution, for tickets resolved in the window. */
  meanResolveMinutes: number | null;
  /** Resolved in the window that carried a resolution target. */
  resolvedWithSla: number;
  /** …of which met it. */
  slaMet: number;
};

async function supportTotals(
  w: Window,
  ids: string[] | null
): Promise<SupportTotals> {
  const [row] = await prisma.$queryRaw<SupportTotals[]>(Prisma.sql`
    select
      (count(*))::int as "everCreated",
      (count(*) filter (where t.created_at >= ${w.start} and t.created_at < ${w.end}))::int as "opened",
      (count(*) filter (where t.resolved_at >= ${w.start} and t.resolved_at < ${w.end}))::int as "resolved",
      (count(*) filter (where t.status not in ('resolved','closed')))::int as "backlog",
      (avg(extract(epoch from (t.resolved_at - t.created_at)) / 60.0)
        filter (where t.resolved_at >= ${w.start} and t.resolved_at < ${w.end}))::float8 as "meanResolveMinutes",
      (count(*) filter (where t.resolved_at >= ${w.start} and t.resolved_at < ${w.end}
                          and t.resolution_due_at is not null))::int as "resolvedWithSla",
      (count(*) filter (where t.resolved_at >= ${w.start} and t.resolved_at < ${w.end}
                          and t.resolution_due_at is not null
                          and t.resolved_at <= t.resolution_due_at))::int as "slaMet"
    from support_tickets t
    where ${scopeFor(Prisma.sql`t.account_id`, ids)}
  `);
  return row!;
}

/* ---------------- Assembled ---------------- */

export type ClientRow = {
  entry: RosterEntry;
  messaging: ClientMessaging;
};

export type SegmentRow = {
  key: string;
  label: string;
  clients: number;
  mrr: number;
  outbound: number;
  failed: number;
  openTickets: number;
};

export type Portfolio = {
  window: Window;
  filters: PortfolioFilters;
  /** The filtered set every figure on the page is computed over. */
  scope: RosterEntry[];
  fleetSize: number;
  clientRows: ClientRow[];
  messaging: MessagingTotals;
  daily: DayPoint[];
  channels: ChannelMixRow[];
  ai: AiTotals;
  support: SupportTotals;
  byPlan: SegmentRow[];
  byManager: SegmentRow[];
  /** Plan/manager options for the filter selects, from the whole fleet. */
  options: {
    plans: { value: string; label: string }[];
    managers: { value: string; label: string }[];
  };
};

const EMPTY_MESSAGING = (accountId: string): ClientMessaging => ({
  accountId,
  outbound: 0,
  inbound: 0,
  delivered: 0,
  failed: 0,
  aiWritten: 0,
});

function segment(
  rows: ClientRow[],
  keyOf: (e: RosterEntry) => { key: string; label: string }
): SegmentRow[] {
  const map = new Map<string, SegmentRow>();
  for (const { entry, messaging } of rows) {
    const { key, label } = keyOf(entry);
    const seg = map.get(key) ?? {
      key,
      label,
      clients: 0,
      mrr: 0,
      outbound: 0,
      failed: 0,
      openTickets: 0,
    };
    seg.clients += 1;
    seg.mrr += entry.mrr;
    seg.outbound += messaging.outbound;
    seg.failed += messaging.failed;
    seg.openTickets += entry.openTickets;
    map.set(key, seg);
  }
  return [...map.values()].sort(
    (a, b) => b.clients - a.clients || a.label.localeCompare(b.label)
  );
}

export async function getPortfolio(input: {
  period: PeriodKey;
  plan?: string;
  manager?: string;
}): Promise<Portfolio> {
  const [roster, window] = await Promise.all([
    getRoster(),
    resolveWindow(input.period),
  ]);
  const filters = sanitiseFilters(input, roster);
  const filtered = Object.keys(filters).length > 0;
  const scope = applyFilters(roster, filters);
  const ids = filtered ? scope.map((e) => e.accountId) : null;

  const [messaging, daily, channels, perClient, ai, support] =
    await Promise.all([
      messagingTotals(window, ids),
      dailySeries(window, ids),
      channelMix(window, ids),
      perClientMessaging(window, ids),
      aiTotals(window, ids),
      supportTotals(window, ids),
    ]);

  const clientRows: ClientRow[] = scope.map((entry) => ({
    entry,
    messaging:
      perClient.get(entry.accountId) ?? EMPTY_MESSAGING(entry.accountId),
  }));

  const planOptions = new Map<string, string>();
  const managerOptions = new Map<string, string>();
  let anyUnplanned = false;
  let anyUnassigned = false;
  for (const entry of roster) {
    if (entry.planName)
      planOptions.set(entry.planName, entry.planDisplayName ?? entry.planName);
    else anyUnplanned = true;
    if (entry.managerId)
      managerOptions.set(entry.managerId, entry.managerName ?? 'Unnamed');
    else anyUnassigned = true;
  }

  return {
    window,
    filters,
    scope,
    fleetSize: roster.length,
    clientRows,
    messaging,
    daily,
    channels,
    ai,
    support,
    byPlan: segment(clientRows, (e) => ({
      key: e.planName ?? 'none',
      label: e.planDisplayName ?? 'No plan',
    })),
    byManager: segment(clientRows, (e) => ({
      key: e.managerId ?? 'unassigned',
      label: e.managerName ?? 'Unassigned',
    })),
    options: {
      plans: [
        ...[...planOptions].map(([value, label]) => ({ value, label })),
        ...(anyUnplanned ? [{ value: 'none', label: 'No plan' }] : []),
      ],
      managers: [
        ...[...managerOptions].map(([value, label]) => ({ value, label })),
        ...(anyUnassigned
          ? [{ value: 'unassigned', label: 'Unassigned' }]
          : []),
      ],
    },
  };
}

/** Failure rate as a percentage of outbound, or null when nothing was sent. */
export function failureRate(failed: number, outbound: number): number | null {
  return outbound > 0 ? (failed / outbound) * 100 : null;
}
