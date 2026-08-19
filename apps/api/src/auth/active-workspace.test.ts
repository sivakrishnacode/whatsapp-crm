import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { resolveActiveWorkspace } from './active-workspace';

/**
 * Which workspace does a request act on?
 *
 * ⚠️ These tests exist because the cookie feeding this function is
 * attacker-controlled. The first test is the whole security claim: naming a
 * workspace you are not a member of must not get you that workspace. RLS would
 * also refuse (`is_account_member` reads `account_members`, not cookies), but
 * this is the layer that decides which `account_id` every Prisma query in
 * apps/api is scoped by — and Prisma bypasses RLS entirely, so here there is no
 * second line of defence.
 */

const ALICE = 'user-alice';

type Membership = {
  account_id: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  created_at: Date;
  accounts: { id: string; name: string; ownerUserId: string };
};

function ws(
  id: string,
  role: Membership['role'],
  joined: string,
  ownerUserId = 'someone-else',
): Membership {
  return {
    account_id: id,
    role,
    created_at: new Date(joined),
    accounts: { id, name: `WS ${id}`, ownerUserId },
  };
}

function fakePrisma(memberships: Membership[], lastAccountId: string | null) {
  return {
    account_members: {
      findMany: ({ orderBy }: { orderBy?: { created_at?: 'asc' } }) => {
        const rows = [...memberships];
        if (orderBy?.created_at === 'asc') {
          rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        }
        return Promise.resolve(rows);
      },
    },
    profile: {
      findUnique: () => Promise.resolve({ lastAccountId }),
    },
  } as unknown as PrismaService;
}

describe('resolveActiveWorkspace', () => {
  it('IGNORES a cookie naming a workspace the user is not in', async () => {
    const prisma = fakePrisma([ws('acc-mine', 'owner', '2026-01-01', ALICE)], null);

    const got = await resolveActiveWorkspace(prisma, ALICE, 'acc-someone-else');

    // Not an error — a fallback. A stale cookie (removed from that workspace,
    // or copied between logins) is ordinary, and 403ing an ordinary state would
    // lock people out of a product they still have access to. What must NEVER
    // happen is that the requested id is honoured.
    expect(got?.accountId).toBe('acc-mine');
    expect(got?.corrected).toBe(true);
  });

  it('honours a cookie naming a workspace the user IS in', async () => {
    const prisma = fakePrisma(
      [
        ws('acc-own', 'owner', '2026-01-01', ALICE),
        ws('acc-client', 'agent', '2026-06-01'),
      ],
      null,
    );

    const got = await resolveActiveWorkspace(prisma, ALICE, 'acc-client');

    expect(got?.accountId).toBe('acc-client');
    // The role is the one held THERE, not the one held anywhere.
    expect(got?.role).toBe('agent');
    expect(got?.corrected).toBe(false);
  });

  it('falls back to last_account_id when there is no cookie', async () => {
    const prisma = fakePrisma(
      [
        ws('acc-own', 'owner', '2026-01-01', ALICE),
        ws('acc-client', 'agent', '2026-06-01'),
      ],
      'acc-client',
    );

    const got = await resolveActiveWorkspace(prisma, ALICE, undefined);

    // A new device with no cookie lands where they left off, rather than being
    // bounced back to their own workspace every time they open a laptop.
    expect(got?.accountId).toBe('acc-client');
  });

  it('ignores a last_account_id they are no longer a member of', async () => {
    const prisma = fakePrisma(
      [ws('acc-own', 'owner', '2026-01-01', ALICE)],
      'acc-removed-from',
    );

    const got = await resolveActiveWorkspace(prisma, ALICE, undefined);

    // The column is a hint, and `remove_account_member` clears it — but an
    // operator deleting a membership row by hand does not, so it is re-checked
    // rather than trusted.
    expect(got?.accountId).toBe('acc-own');
  });

  it('prefers a workspace they OWN over one they merely joined', async () => {
    const prisma = fakePrisma(
      [
        // Joined a client's workspace first, chronologically.
        ws('acc-client', 'agent', '2026-01-01'),
        ws('acc-own', 'owner', '2026-06-01', ALICE),
      ],
      null,
    );

    const got = await resolveActiveWorkspace(prisma, ALICE, undefined);

    // Landing an agency operator inside a client's workspace by default is how
    // somebody broadcasts to the wrong audience.
    expect(got?.accountId).toBe('acc-own');
  });

  it('falls back to the OLDEST membership, stably', async () => {
    const prisma = fakePrisma(
      [
        ws('acc-b', 'agent', '2026-06-01'),
        ws('acc-a', 'viewer', '2026-01-01'),
      ],
      null,
    );

    const first = await resolveActiveWorkspace(prisma, ALICE, undefined);
    const second = await resolveActiveWorkspace(prisma, ALICE, undefined);

    // Arbitrary but STABLE: an unstable tiebreak lets two concurrent requests
    // resolve differently and renders half a page from each workspace.
    expect(first?.accountId).toBe('acc-a');
    expect(second?.accountId).toBe('acc-a');
  });

  it('returns null when the user is a member of nothing', async () => {
    const prisma = fakePrisma([], 'acc-stale');

    // A real state since 095, not a broken one: somebody removed from their
    // only workspace. `remove_account_member` deliberately no longer mints them
    // a replacement, so callers must render "ask for an invite" rather than
    // assume this away.
    expect(await resolveActiveWorkspace(prisma, ALICE, undefined)).toBeNull();
  });
});
