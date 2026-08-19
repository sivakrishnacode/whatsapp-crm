import type { AccountRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Which workspace is this request for?
 *
 * Before migration 095 the question did not exist: a user had exactly one
 * `profiles` row and it named their workspace. Now they may hold a membership
 * in any number, so every request needs an answer — and the answer is a
 * SELECTION, not a credential.
 *
 * ⚠️ That distinction is the whole security model, so it is worth stating
 * plainly: the cookie below is attacker-controlled and is treated as such.
 * It is never trusted, only *matched* against `account_members`. A forged
 * value naming a foreign workspace resolves to nothing here and, independently,
 * fails RLS in the browser — `is_account_member()` reads memberships, not
 * cookies. So there is no JWT claim to mint, no custom access-token hook, and
 * nothing to keep in sync between the token and the database.
 */

/**
 * Cookie the web app sets when you pick a workspace.
 *
 * A cookie rather than a header because it has to work for three different
 * callers with one mechanism: the browser's own fetches, Next.js server
 * components, and the same-origin rewrite in apps/web/next.config.ts that
 * forwards the `Cookie` header to Nest verbatim. A header would need every
 * one of those to remember to add it, and the failure mode of forgetting is
 * silent — you'd get the fallback workspace and wonder why the page showed
 * the wrong client's contacts.
 */
export const WORKSPACE_COOKIE = 'c360_ws';

/**
 * Echoed on every authenticated response so the client can learn which
 * workspace the server actually chose. It matters when the cookie was absent
 * or stale (removed from that workspace, first load on a new device): the
 * fallback chain below picks one, and without telling anyone the browser would
 * keep sending a value the server keeps discarding.
 */
export const WORKSPACE_HEADER = 'x-workspace-id';

export interface ActiveWorkspace {
  accountId: string;
  role: AccountRole;
  account: { id: string; name: string };
  /** True when the request's cookie is not what we resolved to, so the caller
   *  should re-stamp it. */
  corrected: boolean;
}

/**
 * Resolves the workspace for a request, or null when the user is a member of
 * none at all.
 *
 * ⚠️ "A member of none" is a REAL STATE, not a broken one, and callers must
 * handle it rather than assume it away. It happens to somebody removed from
 * the only workspace they were in — migration 095's `remove_account_member`
 * deliberately stopped minting them a replacement personal workspace, because
 * conjuring an empty workspace for somebody who was just removed from theirs
 * is the same dance 019 did and the same one we removed.
 *
 * The fallback order is deliberate:
 *
 *   1. The cookie — an explicit choice the user made in the switcher.
 *   2. `profiles.last_account_id` — the same choice, remembered server-side,
 *      so a new device or a cleared cookie lands where they left off.
 *   3. A workspace they OWN. For an agency this is the one they administer
 *      from; landing an operator in a client's workspace by default is how
 *      somebody broadcasts to the wrong audience.
 *   4. Oldest membership. Arbitrary but STABLE — an unstable tiebreak means
 *      two concurrent requests can resolve differently and a page renders
 *      half of one workspace and half of another.
 */
export async function resolveActiveWorkspace(
  prisma: PrismaService,
  userId: string,
  requestedAccountId: string | undefined,
): Promise<ActiveWorkspace | null> {
  const memberships = await prisma.account_members.findMany({
    where: { user_id: userId },
    select: {
      account_id: true,
      role: true,
      created_at: true,
      accounts: { select: { id: true, name: true, ownerUserId: true } },
    },
    orderBy: { created_at: 'asc' },
  });

  if (memberships.length === 0) return null;

  const pick =
    (requestedAccountId
      ? memberships.find((m) => m.account_id === requestedAccountId)
      : undefined) ??
    (await lastOpened(prisma, userId, memberships)) ??
    memberships.find((m) => m.accounts.ownerUserId === userId) ??
    memberships[0];

  return {
    accountId: pick.account_id,
    role: pick.role,
    account: { id: pick.accounts.id, name: pick.accounts.name },
    corrected: requestedAccountId !== pick.account_id,
  };
}

type Membership = { account_id: string };

/**
 * Step 2 of the chain. Only consulted when the cookie gave no usable answer,
 * so the extra read costs nothing on the common path — and it is still
 * re-validated against the membership list, because the column is a hint and
 * a user removed from a workspace keeps pointing at it until they next switch.
 */
async function lastOpened<T extends Membership>(
  prisma: PrismaService,
  userId: string,
  memberships: T[],
): Promise<T | undefined> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { lastAccountId: true },
  });
  if (!profile?.lastAccountId) return undefined;
  return memberships.find((m) => m.account_id === profile.lastAccountId);
}
