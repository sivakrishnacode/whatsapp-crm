import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstagramConnectService } from './instagram-connect.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/security/encryption.util';
import { unsubscribeFromWebhooks } from '../ig-api.util';

vi.mock('../ig-api.util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ig-api.util')>();
  return { ...actual, unsubscribeFromWebhooks: vi.fn() };
});

/**
 * `deleteForInstagramUser` backs Meta's deauthorize and data-deletion
 * callbacks. Both used to return a bare 200 and delete nothing, which is a
 * review rejection and — more to the point — a broken promise.
 *
 * The two behaviours worth pinning:
 *
 *   1. It matches EITHER id. One Instagram account reports a `ig_user_id`
 *      and an app-scoped id, and which one arrives in a callback is not
 *      documented. Matching only one would honour a deletion request by
 *      silently doing nothing — the worst possible failure here, because it
 *      looks like success from every angle.
 *
 *   2. A failed unsubscribe must not stop the delete. On this path the
 *      user has just revoked the grant, so the token is already dead and
 *      the unsubscribe call is EXPECTED to fail.
 */

const IG_USER_ID = '17841400000000001';
const APP_SCOPED_ID = '9876543210';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    account_id: 'acc-1',
    ig_user_id: IG_USER_ID,
    ig_app_scoped_id: APP_SCOPED_ID,
    access_token: encrypt('ig-token'),
    ...overrides,
  };
}

function makeService(configs: Array<ReturnType<typeof makeConfig>>) {
  const prisma = {
    instagram_config: {
      findMany: vi.fn().mockResolvedValue(configs),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  const service = new InstagramConnectService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
}

describe('deleteForInstagramUser', () => {
  beforeEach(() => {
    vi.mocked(unsubscribeFromWebhooks).mockResolvedValue(undefined as never);
  });

  it('deletes the connection and reports how many went', async () => {
    const { service, prisma } = makeService([makeConfig()]);

    await expect(service.deleteForInstagramUser(IG_USER_ID)).resolves.toBe(1);

    expect(prisma.instagram_config.delete).toHaveBeenCalledWith({
      where: { id: 'cfg-1' },
    });
  });

  it('matches on either the user id or the app-scoped id', async () => {
    const { service, prisma } = makeService([makeConfig()]);

    await service.deleteForInstagramUser(APP_SCOPED_ID);

    expect(prisma.instagram_config.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { ig_user_id: APP_SCOPED_ID },
          { ig_app_scoped_id: APP_SCOPED_ID },
        ],
      },
    });
  });

  it('deletes every workspace the same person connected', async () => {
    const { service, prisma } = makeService([
      makeConfig({ id: 'cfg-1', account_id: 'acc-1' }),
      makeConfig({ id: 'cfg-2', account_id: 'acc-2' }),
    ]);

    await expect(service.deleteForInstagramUser(IG_USER_ID)).resolves.toBe(2);
    expect(prisma.instagram_config.delete).toHaveBeenCalledTimes(2);
  });

  it('still deletes when the unsubscribe call fails', async () => {
    // The expected case, not the edge case: the grant is already revoked,
    // so the token cannot unsubscribe.
    vi.mocked(unsubscribeFromWebhooks).mockRejectedValue(
      new Error('Invalid OAuth access token'),
    );
    const { service, prisma } = makeService([makeConfig()]);

    await expect(service.deleteForInstagramUser(IG_USER_ID)).resolves.toBe(1);
    expect(prisma.instagram_config.delete).toHaveBeenCalledOnce();
  });

  it('still deletes when the stored token cannot be decrypted', async () => {
    const { service, prisma } = makeService([
      makeConfig({ access_token: 'not-encrypted-at-all' }),
    ]);

    await expect(service.deleteForInstagramUser(IG_USER_ID)).resolves.toBe(1);
    expect(prisma.instagram_config.delete).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unknown user rather than an error', async () => {
    const { service, prisma } = makeService([]);

    await expect(service.deleteForInstagramUser('nobody')).resolves.toBe(0);
    expect(prisma.instagram_config.delete).not.toHaveBeenCalled();
  });
});
