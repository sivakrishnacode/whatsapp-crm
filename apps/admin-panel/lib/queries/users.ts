import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { MRR_EXPR, type SubscriptionStatus } from '@/lib/queries/sql';

/**
 * The people side of the panel.
 *
 * Anchored on `auth.users` rather than `profiles`, because the two diverge in
 * ways that matter operationally: a user who signed up but never completed
 * onboarding has no profile, and an invited teammate may have a profile on
 * someone else's account. Both need to be visible.
 */

export type UserRow = {
  userId: string;
  email: string | null;
  fullName: string | null;
  accountRole: string | null;
  accountId: string | null;
  accountName: string | null;
  isAccountOwner: boolean;
  createdAt: Date | null;
  lastSignInAt: Date | null;
  emailConfirmedAt: Date | null;
  bannedUntil: Date | null;
  planDisplayName: string | null;
  status: SubscriptionStatus | null;
  mrr: number;
};

export type UserListParams = {
  q?: string;
  role?: string;
  page?: number;
  perPage?: number;
};

export type UserList = {
  rows: UserRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
};

const USER_FROM = Prisma.sql`
  from auth.users u
  left join profiles p on p.user_id = u.id
  left join accounts a on a.id = p.account_id
  left join accounts owned on owned.owner_user_id = u.id
  left join user_subscriptions s on s.user_id = u.id
  left join subscription_plans pl on pl.id = s.plan_id`;

function buildWhere(params: UserListParams): Prisma.Sql {
  // Soft-deleted Supabase users are history, not customers.
  const conditions: Prisma.Sql[] = [Prisma.sql`u.deleted_at is null`];

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(Prisma.sql`(
      u.email ilike ${like}
      or p.full_name ilike ${like}
      or a.name ilike ${like}
    )`);
  }

  if (params.role && params.role !== 'all') {
    conditions.push(
      Prisma.sql`p.account_role = ${params.role}::account_role_enum`
    );
  }

  return Prisma.sql`where ${Prisma.join(conditions, ' and ')}`;
}

export async function listUsers(
  params: UserListParams = {}
): Promise<UserList> {
  const perPage = Math.min(Math.max(params.perPage ?? 25, 5), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);

  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<UserRow[]>(Prisma.sql`
      select
        u.id as "userId",
        u.email as "email",
        u.created_at as "createdAt",
        u.last_sign_in_at as "lastSignInAt",
        u.email_confirmed_at as "emailConfirmedAt",
        u.banned_until as "bannedUntil",
        p.full_name as "fullName",
        p.account_role as "accountRole",
        a.id as "accountId",
        a.name as "accountName",
        (owned.id is not null) as "isAccountOwner",
        pl.display_name as "planDisplayName",
        s.status as "status",
        (${MRR_EXPR})::float8 as "mrr"
      ${USER_FROM}
      ${where}
      order by u.created_at desc nulls last
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      select (count(*))::int as "total"
      ${USER_FROM}
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

export type RoleCount = { role: string; count: number };

export async function roleCounts(): Promise<RoleCount[]> {
  return prisma.$queryRaw<RoleCount[]>(Prisma.sql`
    select
      coalesce(p.account_role::text, 'no profile') as "role",
      (count(*))::int as "count"
    from auth.users u
    left join profiles p on p.user_id = u.id
    where u.deleted_at is null
    group by 1
    order by "count" desc
  `);
}
