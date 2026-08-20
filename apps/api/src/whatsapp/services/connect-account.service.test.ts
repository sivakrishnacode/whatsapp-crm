/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access --
   vitest's asymmetric matchers (expect.objectContaining) are typed
   `any`, and `mock.calls[0][0].data` is `any` by construction — both
   trip these rules spuriously in a test whose whole job is asserting on
   the shape of a Prisma write. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectAccountService,
  type SaveWhatsAppConnectionResult,
} from './connect-account.service';
import type { PrismaService } from '../../prisma/prisma.service';

vi.mock('../meta-api.util', async () => {
  const actual =
    await vi.importActual<typeof import('../meta-api.util')>(
      '../meta-api.util',
    );
  return {
    ...actual,
    verifyPhoneNumber: vi.fn(),
    registerPhoneNumber: vi.fn(),
    subscribeWabaToApp: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../common/security/encryption.util', () => ({
  encrypt: vi.fn((v: string) => `enc(${v})`),
}));

import {
  verifyPhoneNumber,
  registerPhoneNumber,
  subscribeWabaToApp,
} from '../meta-api.util';

const ACCOUNT = 'acc-1';
const PHONE = 'pn-1';

function makePrisma(existing: Record<string, unknown> | null) {
  const update = vi.fn().mockResolvedValue({});
  const create = vi.fn().mockResolvedValue({});
  return {
    prisma: {
      whatsapp_config: {
        findFirst: vi.fn().mockResolvedValue(null), // nobody else claimed it
        findUnique: vi.fn().mockResolvedValue(existing),
        update,
        create,
      },
    } as unknown as PrismaService,
    update,
    create,
  };
}

/**
 * Narrow the result union. Every test here is about what a SUCCESSFUL
 * save wrote, so a failure is a test failure, not a branch to handle.
 */
function expectOk(result: SaveWhatsAppConnectionResult) {
  if (!result.ok) {
    throw new Error(`expected a successful save, got: ${result.error}`);
  }
  return result;
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    userId: 'user-1',
    phoneNumberId: PHONE,
    wabaId: 'waba-1',
    accessToken: 'tok',
    connectionMethod: 'embedded_signup' as const,
    ...overrides,
  };
}

/**
 * The bug these pin, in one sentence: re-running Connect on a number
 * that is ALREADY registered used to call /register again, fail with
 * "(#133005) Two step verification PIN Mismatch" (because two-step
 * verification was set with a PIN we do not hold), and then write
 * `status: 'disconnected'` + `registered_at: null` — putting a "Meta
 * will not deliver events" banner over a number that was receiving
 * messages the whole time.
 */
describe('ConnectAccountService — registration state', () => {
  beforeEach(() => {
    vi.mocked(registerPhoneNumber).mockReset();
    vi.mocked(subscribeWabaToApp).mockResolvedValue(undefined as never);
  });

  it('skips /register entirely when Meta already reports the number CONNECTED', async () => {
    vi.mocked(verifyPhoneNumber).mockResolvedValue({
      id: PHONE,
      display_phone_number: '+91 00000 00000',
      status: 'CONNECTED',
      is_pin_enabled: true,
    });
    const { prisma, update } = makePrisma({
      id: 'row-1',
      registered_at: null,
      phone_number_id: PHONE,
    });

    const service = new ConnectAccountService(prisma);
    // A PIN is supplied — the old code treated that alone as a reason to
    // re-register, which is exactly how the 133005 was provoked.
    const result = expectOk(
      await service.saveWhatsAppConnection(args({ pin: '123456' })),
    );

    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.registered).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'connected',
          last_registration_error: null,
        }),
      }),
    );
    const written = update.mock.calls[0][0].data;
    expect(written.registered_at).toBeInstanceOf(Date);
  });

  it('keeps the connection when /register fails but Meta says the number is live', async () => {
    // Meta reports CONNECTED, so registration is skipped and can't fail —
    // assert the write is `connected` rather than the old `disconnected`.
    vi.mocked(verifyPhoneNumber).mockResolvedValue({
      id: PHONE,
      display_phone_number: '+91 00000 00000',
      status: 'CONNECTED',
    });
    vi.mocked(registerPhoneNumber).mockRejectedValue(
      new Error('(#133005) Two step verification PIN Mismatch'),
    );
    const registeredAt = new Date('2026-08-20T06:18:22.000Z');
    const { prisma, update } = makePrisma({
      id: 'row-1',
      registered_at: registeredAt,
      phone_number_id: PHONE,
    });

    const service = new ConnectAccountService(prisma);
    const result = expectOk(
      await service.saveWhatsAppConnection(args({ pin: '999999' })),
    );

    expect(result.ok).toBe(true);
    expect(result.registered).toBe(true);
    const written = update.mock.calls[0][0].data;
    expect(written.status).toBe('connected');
    expect(written.registered_at).toEqual(registeredAt);
    expect(written.connected_at).not.toBeNull();
  });

  it('still records a genuine failure when Meta does NOT report the number registered', async () => {
    vi.mocked(verifyPhoneNumber).mockResolvedValue({
      id: PHONE,
      display_phone_number: '+91 00000 00000',
      status: 'PENDING',
    });
    vi.mocked(registerPhoneNumber).mockRejectedValue(
      new Error('(#133005) Two step verification PIN Mismatch'),
    );
    const { prisma, create } = makePrisma(null);

    const service = new ConnectAccountService(prisma);
    const result = expectOk(
      await service.saveWhatsAppConnection(args({ pin: '999999' })),
    );

    expect(registerPhoneNumber).toHaveBeenCalled();
    expect(result.registered).toBe(false);
    expect(result.registration_error).toContain('133005');
    // No existing row, so this takes the create path.
    const written = create.mock.calls[0][0].data;
    expect(written.status).toBe('disconnected');
    expect(written.registered_at).toBeNull();
    expect(written.last_registration_error).toContain('133005');
  });

  it('subscribes the WABA regardless — that is what carries webhooks', async () => {
    vi.mocked(verifyPhoneNumber).mockResolvedValue({
      id: PHONE,
      display_phone_number: '+91 00000 00000',
      status: 'CONNECTED',
    });
    const { prisma } = makePrisma({
      id: 'row-1',
      registered_at: null,
      phone_number_id: PHONE,
    });

    const service = new ConnectAccountService(prisma);
    await service.saveWhatsAppConnection(args());

    expect(subscribeWabaToApp).toHaveBeenCalledWith(
      expect.objectContaining({ wabaId: 'waba-1' }),
    );
  });
});
