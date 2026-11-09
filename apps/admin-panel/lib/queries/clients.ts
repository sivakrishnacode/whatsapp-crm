import 'server-only';

import { Prisma } from '@prisma/client';

import { adminTimezone } from '@/lib/env';
import { prisma } from '@/lib/prisma';

/**
 * Customer 360 reads — everything about ONE workspace that is not already in
 * lib/queries/workspaces.ts (people, wallet, AI, channels) or the roster.
 *
 * Every function takes the account id the page took from its own URL. Prisma
 * bypasses RLS, so `where account_id = ${accountId}` in each query is the
 * whole of the tenant scoping — there is no second line of defence.
 */

/* ============================================================
 * Reporting windows
 * ============================================================ */

export type PeriodKey = 'today' | '7d' | '30d' | '90d' | 'custom';

export type ReportWindow = {
  key: PeriodKey;
  start: Date;
  end: Date;
  /** Same length, immediately before — what deltas compare against. */
  label: string;
  timezone: string;
  /** For the custom-range inputs. YYYY-MM-DD in the window's timezone. */
  fromInput: string;
  toInput: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESET_DAYS: Record<Exclude<PeriodKey, 'custom'>, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/**
 * Turns `?period=` (and `from`/`to` for custom) into an exact window, with day
 * boundaries at local midnight in ADMIN_TIMEZONE — computed in Postgres so the
 * boundary is the same one the bucketing functions use. Presets end NOW and
 * include today ("7 days" = today and the six before it). A malformed custom
 * range falls back to 30 days rather than erroring.
 */
export async function resolveWindow(params: {
  period?: string;
  from?: string;
  to?: string;
}): Promise<ReportWindow> {
  const tz = adminTimezone();
  const wantsCustom =
    params.period === 'custom' &&
    DATE_RE.test(params.from ?? '') &&
    DATE_RE.test(params.to ?? '') &&
    params.from! <= params.to!;

  if (wantsCustom) {
    const [row] = await prisma.$queryRaw<{ start: Date; end: Date }[]>(
      Prisma.sql`
        select
          (${params.from}::date)::timestamp at time zone ${tz} as "start",
          least(
            ((${params.to}::date) + 1)::timestamp at time zone ${tz},
            now()
          ) as "end"
      `
    );
    const days = Math.ceil(
      (row!.end.getTime() - row!.start.getTime()) / 86_400_000
    );
    if (days > 0 && days <= 366) {
      return {
        key: 'custom',
        start: row!.start,
        end: row!.end,
        label: `${params.from} to ${params.to}`,
        timezone: tz,
        fromInput: params.from!,
        toInput: params.to!,
      };
    }
  }

  const key = (
    params.period && params.period in PRESET_DAYS ? params.period : '30d'
  ) as Exclude<PeriodKey, 'custom'>;
  const days = PRESET_DAYS[key];

  const [row] = await prisma.$queryRaw<
    { start: Date; end: Date; fromInput: string; toInput: string }[]
  >(Prisma.sql`
    select
      (date_trunc('day', now() at time zone ${tz}) - (${days - 1} * interval '1 day'))
        at time zone ${tz} as "start",
      now() as "end",
      to_char(date_trunc('day', now() at time zone ${tz}) - (${days - 1} * interval '1 day'), 'YYYY-MM-DD') as "fromInput",
      to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as "toInput"
  `);

  return {
    key,
    start: row!.start,
    end: row!.end,
    label: key === 'today' ? 'Today' : `Last ${days} days`,
    timezone: tz,
    fromInput: row!.fromInput,
    toInput: row!.toInput,
  };
}

/* ============================================================
 * Per-client performance — the customer's OWN analytics RPCs
 * ============================================================ */

export const CHANNELS = ['whatsapp', 'instagram', 'web'] as const;
export type Channel = (typeof CHANNELS)[number];

export type ChannelKpis = {
  channel: Channel;
  msgsOut: number;
  msgsIn: number;
  delivered: number;
  read: number;
  failed: number;
  convsNew: number;
  convsActive: number;
  contactsNew: number;
  aiReplies: number;
  humanReplies: number;
  handoffs: number;
  avgResponseMinutes: number | null;
  prev: {
    msgsOut: number;
    msgsIn: number;
    delivered: number;
    failed: number;
    convsActive: number;
    contactsNew: number;
    aiReplies: number;
    avgResponseMinutes: number | null;
  };
};

export type DailyPoint = {
  day: string;
  incoming: number;
  outgoing: number;
  delivered: number;
  failed: number;
};

export type Performance = {
  window: ReportWindow;
  channels: ChannelKpis[];
  totals: Omit<ChannelKpis, 'channel' | 'avgResponseMinutes' | 'prev'> & {
    prev: ChannelKpis['prev'];
  };
  /** Days with no traffic are present as zeros. */
  series: DailyPoint[];
  leads: {
    contacts: number;
    deals: number;
    won: number;
    dealValue: number;
    wonValue: number;
  };
  activeHumanAgents: number;
  creditsConsumed: number;
  broadcasts: {
    count: number;
    recipients: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
  };
};

/**
 * Per-client performance, reusing migration 089's RPCs — the exact functions
 * behind the customer's own analytics screens — so a number here is the
 * number the customer sees. They are SECURITY DEFINER with analytics_guard();
 * a server connection (auth.uid() IS NULL, this panel) passes.
 *
 * BIGINT columns are cast to float8: Prisma returns BIGINT as BigInt, which
 * cannot cross into a client component or be formatted by Intl.
 */
export async function getPerformance(
  accountId: string,
  window: ReportWindow
): Promise<Performance> {
  const tz = window.timezone;
  const { start, end } = window;

  const kpiRows = await Promise.all(
    CHANNELS.map((channel) =>
      prisma.$queryRaw<Record<string, number | null>[]>(Prisma.sql`
        select
          msgs_out::float8 as "msgsOut", msgs_in::float8 as "msgsIn",
          delivered::float8 as "delivered", read_count::float8 as "read",
          failed::float8 as "failed", convs_new::float8 as "convsNew",
          convs_active::float8 as "convsActive", contacts_new::float8 as "contactsNew",
          ai_replies::float8 as "aiReplies", human_replies::float8 as "humanReplies",
          handoffs::float8 as "handoffs", avg_response_minutes::float8 as "avg",
          prev_msgs_out::float8 as "pMsgsOut", prev_msgs_in::float8 as "pMsgsIn",
          prev_delivered::float8 as "pDelivered", prev_failed::float8 as "pFailed",
          prev_convs_active::float8 as "pConvsActive",
          prev_contacts_new::float8 as "pContactsNew",
          prev_ai_replies::float8 as "pAiReplies",
          prev_avg_response_minutes::float8 as "pAvg"
        from get_channel_kpis(${accountId}::uuid, ${channel}, ${start}, ${end}, '{}'::jsonb)
      `)
    )
  );

  const channels: ChannelKpis[] = kpiRows.map((rows, index) => {
    const r = rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    return {
      channel: CHANNELS[index]!,
      msgsOut: n('msgsOut'),
      msgsIn: n('msgsIn'),
      delivered: n('delivered'),
      read: n('read'),
      failed: n('failed'),
      convsNew: n('convsNew'),
      convsActive: n('convsActive'),
      contactsNew: n('contactsNew'),
      aiReplies: n('aiReplies'),
      humanReplies: n('humanReplies'),
      handoffs: n('handoffs'),
      avgResponseMinutes:
        r.avg === null || r.avg === undefined ? null : Number(r.avg),
      prev: {
        msgsOut: n('pMsgsOut'),
        msgsIn: n('pMsgsIn'),
        delivered: n('pDelivered'),
        failed: n('pFailed'),
        convsActive: n('pConvsActive'),
        contactsNew: n('pContactsNew'),
        aiReplies: n('pAiReplies'),
        avgResponseMinutes:
          r.pAvg === null || r.pAvg === undefined ? null : Number(r.pAvg),
      },
    };
  });

  const sum = (pick: (c: ChannelKpis) => number) =>
    channels.reduce((total, c) => total + pick(c), 0);

  const [seriesRows, leadRows, extras] = await Promise.all([
    Promise.all(
      CHANNELS.map((channel) =>
        prisma.$queryRaw<
          {
            day: string;
            incoming: number;
            outgoing: number;
            delivered: number;
            failed: number;
          }[]
        >(Prisma.sql`
          select to_char(day, 'YYYY-MM-DD') as "day",
            incoming::float8 as "incoming", outgoing::float8 as "outgoing",
            delivered::float8 as "delivered", failed::float8 as "failed"
          from get_channel_series(${accountId}::uuid, ${channel}, ${start}, ${end}, ${tz}, '{}'::jsonb)
        `)
      )
    ),
    Promise.all(
      CHANNELS.map((channel) =>
        prisma.$queryRaw<
          {
            contacts: number;
            deals: number;
            won: number;
            dealValue: number;
            wonValue: number;
          }[]
        >(Prisma.sql`
          select
            coalesce(sum(contacts), 0)::float8 as "contacts",
            coalesce(sum(deals), 0)::float8 as "deals",
            coalesce(sum(deals_won), 0)::float8 as "won",
            coalesce(sum(deal_value), 0)::float8 as "dealValue",
            coalesce(sum(won_value), 0)::float8 as "wonValue"
          from get_channel_leads(${accountId}::uuid, ${channel}, ${start}, ${end}, ${tz})
        `)
      )
    ),
    prisma.$queryRaw<
      {
        agents: number;
        credits: number;
        bCount: number;
        bRecipients: number;
        bSent: number;
        bDelivered: number;
        bRead: number;
        bFailed: number;
      }[]
    >(Prisma.sql`
      select
        (
          select count(distinct m.sender_id)
          from messages m
          join conversations c on c.id = m.conversation_id
          where c.account_id = ${accountId}::uuid
            and m.sender_type = 'agent'
            and m.sender_id is not null
            and m.deleted_at is null
            and m.created_at >= ${start} and m.created_at < ${end}
        )::float8 as "agents",
        (
          select coalesce(-sum(delta), 0)
          from ai_credit_ledger
          where account_id = ${accountId}::uuid
            and delta < 0
            and created_at >= ${start} and created_at < ${end}
        )::float8 as "credits",
        (select count(*) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bCount",
        (select coalesce(sum(total_recipients), 0) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bRecipients",
        (select coalesce(sum(sent_count), 0) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bSent",
        (select coalesce(sum(delivered_count), 0) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bDelivered",
        (select coalesce(sum(read_count), 0) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bRead",
        (select coalesce(sum(failed_count), 0) from broadcasts b where b.account_id = ${accountId}::uuid
            and b.created_at >= ${start} and b.created_at < ${end})::float8 as "bFailed"
    `),
  ]);

  // Merge channel series by day, then fill every day of the window so a quiet
  // day reads as zero, not as missing.
  const byDay = new Map<string, DailyPoint>();
  for (const rows of seriesRows) {
    for (const row of rows) {
      const point = byDay.get(row.day) ?? {
        day: row.day,
        incoming: 0,
        outgoing: 0,
        delivered: 0,
        failed: 0,
      };
      point.incoming += Number(row.incoming);
      point.outgoing += Number(row.outgoing);
      point.delivered += Number(row.delivered);
      point.failed += Number(row.failed);
      byDay.set(row.day, point);
    }
  }
  const series: DailyPoint[] = [];
  const cursor = new Date(`${window.fromInput}T00:00:00Z`);
  const last = new Date(`${window.toInput}T00:00:00Z`);
  while (cursor <= last && series.length < 400) {
    const day = cursor.toISOString().slice(0, 10);
    series.push(
      byDay.get(day) ?? {
        day,
        incoming: 0,
        outgoing: 0,
        delivered: 0,
        failed: 0,
      }
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const leads = leadRows.reduce(
    (acc, rows) => {
      const r = rows[0];
      if (!r) return acc;
      return {
        contacts: acc.contacts + Number(r.contacts),
        deals: acc.deals + Number(r.deals),
        won: acc.won + Number(r.won),
        dealValue: acc.dealValue + Number(r.dealValue),
        wonValue: acc.wonValue + Number(r.wonValue),
      };
    },
    { contacts: 0, deals: 0, won: 0, dealValue: 0, wonValue: 0 }
  );

  const x = extras[0]!;

  return {
    window,
    channels,
    totals: {
      msgsOut: sum((c) => c.msgsOut),
      msgsIn: sum((c) => c.msgsIn),
      delivered: sum((c) => c.delivered),
      read: sum((c) => c.read),
      failed: sum((c) => c.failed),
      convsNew: sum((c) => c.convsNew),
      convsActive: sum((c) => c.convsActive),
      contactsNew: sum((c) => c.contactsNew),
      aiReplies: sum((c) => c.aiReplies),
      humanReplies: sum((c) => c.humanReplies),
      handoffs: sum((c) => c.handoffs),
      prev: {
        msgsOut: sum((c) => c.prev.msgsOut),
        msgsIn: sum((c) => c.prev.msgsIn),
        delivered: sum((c) => c.prev.delivered),
        failed: sum((c) => c.prev.failed),
        convsActive: sum((c) => c.prev.convsActive),
        contactsNew: sum((c) => c.prev.contactsNew),
        aiReplies: sum((c) => c.prev.aiReplies),
        avgResponseMinutes: null,
      },
    },
    series,
    leads,
    activeHumanAgents: Number(x.agents),
    creditsConsumed: Number(x.credits),
    broadcasts: {
      count: Number(x.bCount),
      recipients: Number(x.bRecipients),
      sent: Number(x.bSent),
      delivered: Number(x.bDelivered),
      read: Number(x.bRead),
      failed: Number(x.bFailed),
    },
  };
}

/* ============================================================
 * Notes, tasks, lifecycle events
 * ============================================================ */

export type ClientNote = {
  id: string;
  body: string;
  pinned: boolean;
  author: string;
  createdAt: Date;
};

export async function listNotes(
  accountId: string,
  limit = 50
): Promise<ClientNote[]> {
  const rows = await prisma.client_notes.findMany({
    where: { account_id: accountId },
    orderBy: [{ pinned: 'desc' }, { created_at: 'desc' }],
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    pinned: r.pinned,
    author: r.author,
    createdAt: r.created_at,
  }));
}

export type ClientTask = {
  id: string;
  title: string;
  dueOn: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  status: 'open' | 'done';
  createdBy: string;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
};

export async function listTasks(accountId: string): Promise<ClientTask[]> {
  return prisma.$queryRaw<ClientTask[]>(Prisma.sql`
    select t.id, t.title, t.due_on as "dueOn",
      t.assignee_staff_id as "assigneeId", st.full_name as "assigneeName",
      t.status, t.created_by as "createdBy", t.created_at as "createdAt",
      t.completed_at as "completedAt", t.completed_by as "completedBy"
    from client_tasks t
    left join admin_staff st on st.id = t.assignee_staff_id
    where t.account_id = ${accountId}::uuid
    order by (t.status = 'open') desc, t.due_on asc nulls last, t.created_at desc
    limit 100
  `);
}

export type LifecycleEvent = {
  id: string;
  fromStage: string | null;
  toStage: string | null;
  reason: string;
  actor: string;
  createdAt: Date;
};

export async function listLifecycleEvents(
  accountId: string
): Promise<LifecycleEvent[]> {
  const rows = await prisma.client_lifecycle_events.findMany({
    where: { account_id: accountId },
    orderBy: { created_at: 'desc' },
    take: 20,
  });
  return rows.map((r) => ({
    id: r.id,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.created_at,
  }));
}

/* ============================================================
 * Tickets for one client (the 360 tab; the desk is /support)
 * ============================================================ */

export type ClientTicket = {
  id: string;
  number: number;
  subject: string;
  severity: string;
  tier: string;
  status: string;
  category: string;
  assigneeName: string | null;
  createdAt: Date;
  firstResponseDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
};

export async function listClientTickets(
  accountId: string
): Promise<ClientTicket[]> {
  return prisma.$queryRaw<ClientTicket[]>(Prisma.sql`
    select t.id, t.number::int as "number", t.subject, t.severity, t.tier,
      t.status, t.category, st.full_name as "assigneeName",
      t.created_at as "createdAt",
      t.first_response_due_at as "firstResponseDueAt",
      t.first_responded_at as "firstRespondedAt",
      t.resolution_due_at as "resolutionDueAt",
      t.resolved_at as "resolvedAt"
    from support_tickets t
    left join admin_staff st on st.id = t.assignee_staff_id
    where t.account_id = ${accountId}::uuid
    order by (t.status in ('resolved','closed')) asc, t.created_at desc
    limit 100
  `);
}

/* ============================================================
 * Integrations for one client — never a secret column
 * ============================================================ */

export type ClientIntegrations = {
  apiKeys: {
    id: string;
    name: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }[];
  webhooks: {
    id: string;
    origin: string;
    isActive: boolean;
    lastDeliveryAt: Date | null;
    createdAt: Date;
  }[];
  google: {
    lastOkAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    scriptVersion: number | null;
    createdAt: Date;
  } | null;
  stores: {
    platform: string;
    status: string;
    lastSyncAt: Date | null;
    syncError: string | null;
    storeOrigin: string;
  }[];
};

/**
 * Only the ORIGIN of a URL — a webhook or store URL's path and query can
 * carry a token, and an operator does not need it to diagnose anything.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid URL';
  }
}

export async function getClientIntegrations(
  accountId: string
): Promise<ClientIntegrations> {
  const [apiKeys, hooks, google, stores] = await Promise.all([
    prisma.apiKey.findMany({
      where: { accountId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.webhook_endpoints.findMany({
      where: { account_id: accountId },
      select: {
        id: true,
        url: true,
        is_active: true,
        last_delivery_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    }),
    prisma.google_script_connections.findUnique({
      where: { account_id: accountId },
      select: {
        lastOkAt: true,
        lastErrorAt: true,
        lastError: true,
        scriptVersion: true,
        createdAt: true,
      },
    }),
    prisma.ecommerce_integrations.findMany({
      where: { account_id: accountId },
      select: {
        platform: true,
        status: true,
        last_sync_at: true,
        sync_error: true,
        store_url: true,
      },
    }),
  ]);

  return {
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.keyPrefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    })),
    webhooks: hooks.map((h) => ({
      id: h.id,
      origin: originOf(h.url),
      isActive: h.is_active,
      lastDeliveryAt: h.last_delivery_at,
      createdAt: h.created_at,
    })),
    google,
    stores: stores.map((s) => ({
      platform: s.platform,
      status: s.status,
      lastSyncAt: s.last_sync_at,
      syncError: s.sync_error,
      storeOrigin: originOf(s.store_url),
    })),
  };
}

/* ============================================================
 * Timeline — one chronological story of the account
 * ============================================================ */

export type TimelineItem = {
  at: Date;
  kind: 'milestone' | 'admin' | 'lifecycle' | 'note' | 'ticket';
  title: string;
  detail: string | null;
  actor: string | null;
  href?: string;
};

/**
 * Product milestones (from the tenant's own rows), every admin-panel write
 * (admin_audit_log), lifecycle pins, notes and tickets — merged and sorted.
 * Nothing here is copied into a new table; each source is read where it lives.
 */
export async function getTimeline(accountId: string): Promise<TimelineItem[]> {
  const [milestones, audit, lifecycle, notes, tickets] = await Promise.all([
    prisma.$queryRaw<
      {
        created: Date;
        onboarded: Date | null;
        trialGranted: Date | null;
        subscribed: Date | null;
        waConnected: Date | null;
        igConnected: Date | null;
        webInstalled: Date | null;
        firstConversation: Date | null;
        firstAgent: Date | null;
      }[]
    >(Prisma.sql`
      select
        a.created_at as "created",
        ob.completed_at as "onboarded",
        ob.trial_granted_at as "trialGranted",
        s.created_at as "subscribed",
        wc.connected_at as "waConnected",
        ig.connected_at as "igConnected",
        web.installed_at as "webInstalled",
        (select min(created_at) from conversations where account_id = a.id) as "firstConversation",
        (select min(created_at) from ai_agents where account_id = a.id) as "firstAgent"
      from accounts a
      left join account_onboarding ob on ob.account_id = a.id
      left join user_subscriptions s on s.user_id = a.owner_user_id
      left join whatsapp_config wc on wc.account_id = a.id
      left join instagram_config ig on ig.account_id = a.id
      left join web_config web on web.account_id = a.id
      where a.id = ${accountId}::uuid
    `),
    prisma.admin_audit_log.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: { action: true, summary: true, actor: true, created_at: true },
    }),
    listLifecycleEvents(accountId),
    prisma.client_notes.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: { body: true, author: true, created_at: true },
    }),
    prisma.support_tickets.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        number: true,
        subject: true,
        created_by: true,
        created_at: true,
        resolved_at: true,
        status: true,
      },
    }),
  ]);

  const items: TimelineItem[] = [];
  const m = milestones[0];
  if (m) {
    const add = (at: Date | null, title: string) => {
      if (at)
        items.push({ at, kind: 'milestone', title, detail: null, actor: null });
    };
    add(m.created, 'Workspace created');
    add(m.onboarded, 'Finished the welcome wizard');
    add(m.trialGranted, 'Trial granted');
    add(m.subscribed, 'Subscription row created');
    add(m.waConnected, 'WhatsApp connected');
    add(m.igConnected, 'Instagram connected');
    add(m.webInstalled, 'Web widget installed');
    add(m.firstConversation, 'First conversation');
    add(m.firstAgent, 'First AI agent created');
  }
  for (const row of audit) {
    items.push({
      at: row.created_at,
      kind: 'admin',
      title: row.summary,
      detail: row.action,
      actor: row.actor,
    });
  }
  for (const row of lifecycle) {
    items.push({
      at: row.createdAt,
      kind: 'lifecycle',
      title: row.toStage
        ? `Lifecycle pinned to ${row.toStage}`
        : 'Lifecycle pin cleared — derived again',
      detail: row.reason,
      actor: row.actor,
    });
  }
  for (const row of notes) {
    items.push({
      at: row.created_at,
      kind: 'note',
      title: 'Note added',
      detail: row.body.length > 280 ? `${row.body.slice(0, 280)}…` : row.body,
      actor: row.author,
    });
  }
  for (const row of tickets) {
    const number = Number(row.number);
    items.push({
      at: row.created_at,
      kind: 'ticket',
      title: `Ticket SUP-${number} opened: ${row.subject}`,
      detail: null,
      actor: row.created_by,
      href: `/support/${number}`,
    });
    if (row.resolved_at) {
      items.push({
        at: row.resolved_at,
        kind: 'ticket',
        title: `Ticket SUP-${number} resolved`,
        detail: null,
        actor: null,
        href: `/support/${number}`,
      });
    }
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}
