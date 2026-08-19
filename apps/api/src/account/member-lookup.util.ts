import type { PrismaClient } from '@prisma/client';

/**
 * "Who is in this workspace" — the reads, in one place.
 *
 * Before migration 095 these were all `profile.findMany({ where: { accountId } })`,
 * which was both the membership list and the person list at once. Now membership
 * is `account_members` and the person is `profiles`, so every one of those call
 * sites needs a join — and a join is exactly the kind of thing that gets written
 * five times and scoped correctly in four of them.
 *
 * ⚠️ Prisma connects as the database owner, so RLS protects none of this. The
 * `account_id` filter in every function below IS the tenant isolation. One of
 * these call sites (the AI `assign_deal` tool) had already shipped once without
 * it and handed deals to users in other tenants — see the comment in
 * ai/lib/tools/builtin.ts.
 */

type Db = Pick<PrismaClient, 'account_members' | 'profile'>;

/**
 * The profile of one member of one workspace, or null if they are not a member.
 *
 * The null is the point: callers use it as the membership check, so a user id
 * that arrives from a config blob or a model argument cannot be turned into a
 * profile id unless they really are in the workspace.
 */
export async function memberProfile(
  prisma: Db,
  accountId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const membership = await prisma.account_members.findUnique({
    where: { account_id_user_id: { account_id: accountId, user_id: userId } },
    select: { user_id: true },
  });
  if (!membership) return null;

  return prisma.profile.findUnique({
    where: { userId },
    select: { id: true },
  });
}

/** True iff `userId` holds a membership in `accountId`. */
export async function isMember(
  prisma: Db,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.account_members.findUnique({
    where: { account_id_user_id: { account_id: accountId, user_id: userId } },
    select: { user_id: true },
  });
  return row !== null;
}

/**
 * The member behind a `profiles.id`, or null if that person is not in this
 * workspace.
 *
 * The awkward extra hop exists because `deals.assigned_to` references
 * `profiles(id)`, not a user id — so an assignment target arrives as a profile
 * id and has to be turned back into a person before membership can be asked
 * about. That FK is the one place migration 095 left a shape that no longer
 * proves anything on its own: before it, a profile row named a workspace, so
 * `assigned_to` was self-scoping.
 *
 * Returns the row rather than a boolean because every caller that checks
 * membership here also wants the name, for a confirmation line the model reads
 * back to a customer.
 */
export async function memberProfileById(
  prisma: Db,
  accountId: string,
  profileId: string,
): Promise<{ id: string; userId: string; fullName: string } | null> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, userId: true, fullName: true },
  });
  if (!profile) return null;
  return (await isMember(prisma, accountId, profile.userId)) ? profile : null;
}

/**
 * Every member's user id, oldest membership first.
 *
 * Order is stable on purpose: one caller uses it as a stand-in for round-robin
 * assignment, and an unstable order there would move a conversation to a
 * different agent on every run.
 */
export async function memberUserIds(
  prisma: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await prisma.account_members.findMany({
    where: { account_id: accountId },
    select: { user_id: true },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((r) => r.user_id);
}
