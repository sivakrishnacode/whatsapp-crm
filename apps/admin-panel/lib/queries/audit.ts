import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Reads over `admin_audit_log` (migration 073).
 *
 * The account name is LEFT joined and may be null: the table deliberately has no
 * foreign keys, so a row about a workspace that has since been deleted survives
 * with a dangling `account_id`. That is the point — "who removed this" is a
 * question you ask after the thing is gone — so the UI shows the recorded
 * `summary`, which was written at the time and never changes, and treats the
 * live name as a nicety.
 */

export type AuditRow = {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  accountId: string | null;
  accountName: string | null;
  userId: string | null;
  userEmail: string | null;
  summary: string;
  detail: unknown;
  createdAt: Date;
};

export type AuditListParams = {
  q?: string;
  action?: string;
  accountId?: string;
  page?: number;
  perPage?: number;
};

export type AuditList = {
  rows: AuditRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
};

const AUDIT_FROM = Prisma.sql`
  from admin_audit_log l
  left join accounts a on a.id = l.account_id
  left join auth.users u on u.id = l.user_id`;

const AUDIT_COLUMNS = Prisma.sql`
  l.id as "id",
  l.actor as "actor",
  l.action as "action",
  l.target_type as "targetType",
  l.target_id as "targetId",
  l.account_id as "accountId",
  a.name as "accountName",
  l.user_id as "userId",
  u.email as "userEmail",
  l.summary as "summary",
  l.detail as "detail",
  l.created_at as "createdAt"`;

function buildWhere(params: AuditListParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(Prisma.sql`(
      l.summary ilike ${like}
      or l.actor ilike ${like}
      or a.name ilike ${like}
      or u.email ilike ${like}
    )`);
  }

  if (params.action && params.action !== 'all') {
    conditions.push(Prisma.sql`l.action = ${params.action}`);
  }

  if (params.accountId) {
    conditions.push(Prisma.sql`l.account_id = ${params.accountId}::uuid`);
  }

  return conditions.length
    ? Prisma.sql`where ${Prisma.join(conditions, ' and ')}`
    : Prisma.empty;
}

export async function listAudit(
  params: AuditListParams = {}
): Promise<AuditList> {
  const perPage = Math.min(Math.max(params.perPage ?? 40, 5), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<AuditRow[]>(Prisma.sql`
      select ${AUDIT_COLUMNS}
      ${AUDIT_FROM}
      ${where}
      order by l.created_at desc
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      select (count(*))::int as "total"
      ${AUDIT_FROM}
      ${where}
    `),
  ]);

  return {
    rows,
    total: totals.total,
    page,
    perPage,
    pageCount: Math.max(Math.ceil(totals.total / perPage), 1),
  };
}

export type AuditActionCount = { action: string; count: number };

/** Populates the filter, and doubles as "what does this panel actually do". */
export async function auditActionCounts(): Promise<AuditActionCount[]> {
  return prisma.$queryRaw<AuditActionCount[]>(Prisma.sql`
    select action as "action", (count(*))::int as "count"
    from admin_audit_log
    group by action
    order by "count" desc, action asc
  `);
}

/** The tail of admin activity on one workspace, for its detail page. */
export async function auditForAccount(
  accountId: string,
  limit = 8
): Promise<AuditRow[]> {
  return prisma.$queryRaw<AuditRow[]>(Prisma.sql`
    select ${AUDIT_COLUMNS}
    ${AUDIT_FROM}
    where l.account_id = ${accountId}::uuid
    order by l.created_at desc
    limit ${limit}
  `);
}
