/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardBroadcastService,
  resolveBroadcastVariables,
  resolveBroadcastVariableMap,
  type VariableMapping,
} from './dashboard-broadcast.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BroadcastQueueService } from '../../queue/broadcast-queue.service';
import type { EntitlementService } from '../../subscription/services/entitlement.service';

vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn(() => 'decrypted-token'),
}));

const CONTACT = {
  id: 'c-1',
  phone: '+911234567890',
  name: 'Asha',
  email: 'asha@x.test',
  company: 'Acme',
};

function makePrismaMock() {
  return {
    whatsapp_config: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cfg-1',
        account_id: 'acc-1',
        phone_number_id: 'pn-1',
        access_token: 'enc',
      }),
    },
    contacts: {
      findMany: vi.fn().mockResolvedValue([CONTACT]),
      create: vi.fn(),
    },
    contact_tags: { findMany: vi.fn().mockResolvedValue([]) },
    contact_custom_values: { findMany: vi.fn().mockResolvedValue([]) },
    message_templates: { findFirst: vi.fn().mockResolvedValue(null) },
    broadcasts: {
      create: vi.fn().mockResolvedValue({ id: 'b-1' }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    broadcast_recipients: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

const basePayload = {
  name: 'July promo',
  templateName: 'hello_world',
  templateLanguage: 'en_US',
  audience: { type: 'all' as const },
  variables: {},
};

/**
 * Entitlement is a cross-cutting gate, not this service's subject. The
 * stub allows everything and records nothing, so these tests keep
 * asserting what they were written to assert; the gate's own behaviour is
 * covered in subscription/services/entitlement.service.test.ts.
 */
function makeEntitlementsMock() {
  return {
    checkLimit: vi.fn().mockResolvedValue({
      allowed: true,
      currentUsage: 0,
      limitValue: null,
      standing: 'good',
      reason: 'ok',
    }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('resolveBroadcastVariables', () => {
  const contact = CONTACT;

  it('resolves static, field, and custom_field mappings in numeric key order', () => {
    const variables: Record<string, VariableMapping> = {
      '10': { type: 'static', value: 'tenth' },
      '2': { type: 'custom_field', value: 'cf-1' },
      '1': { type: 'field', value: 'name' },
    };
    const custom = new Map([['cf-1', 'Gold']]);
    expect(resolveBroadcastVariables(variables, contact, custom)).toEqual([
      'Asha',
      'Gold',
      'tenth',
    ]);
  });

  it('falls back to empty string for unknown fields/missing custom values', () => {
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'nonexistent' },
      '2': { type: 'custom_field', value: 'cf-missing' },
    };
    expect(resolveBroadcastVariables(variables, contact)).toEqual(['', '']);
  });

  it('skips reserved "_"-prefixed metadata keys', () => {
    const variables = {
      '1': { type: 'static', value: 'hi' },
      _headerMediaUrl: { type: 'static', value: 'https://x.test/img.png' },
    } as unknown as Record<string, VariableMapping>;
    expect(resolveBroadcastVariables(variables, contact)).toEqual(['hi']);
  });
});

describe('resolveBroadcastVariableMap', () => {
  it('keys resolved values by variable name for NAMED templates', () => {
    const variables: Record<string, VariableMapping> = {
      customer_name: { type: 'field', value: 'name' },
      tier: { type: 'custom_field', value: 'cf-1' },
      promo: { type: 'static', value: 'SAVE20' },
    };
    // Named parameters are matched by name, so no ordering is implied —
    // which is exactly why the array form can't be used here.
    expect(
      resolveBroadcastVariableMap(
        variables,
        CONTACT,
        new Map([['cf-1', 'Gold']]),
      ),
    ).toEqual({
      customer_name: 'Asha',
      tier: 'Gold',
      promo: 'SAVE20',
    });
  });

  it('skips reserved "_"-prefixed metadata keys', () => {
    const variables = {
      first_name: { type: 'static', value: 'hi' },
      _headerMediaUrl: { type: 'static', value: 'https://x.test/img.png' },
    } as unknown as Record<string, VariableMapping>;
    expect(resolveBroadcastVariableMap(variables, CONTACT)).toEqual({
      first_name: 'hi',
    });
  });
});

describe('DashboardBroadcastService.createAndQueue', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let queue: { enqueueBroadcast: ReturnType<typeof vi.fn> };
  let service: DashboardBroadcastService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrismaMock();
    queue = { enqueueBroadcast: vi.fn().mockResolvedValue(undefined) };
    service = new DashboardBroadcastService(
      prisma as unknown as PrismaService,
      queue as unknown as BroadcastQueueService,
      makeEntitlementsMock() as unknown as EntitlementService,
    );
  });

  it('rejects missing template name / broadcast name / audience', async () => {
    await expect(
      service.createAndQueue('acc-1', 'u-1', {
        ...basePayload,
        templateName: '',
      }),
    ).rejects.toMatchObject({
      response: { error: 'template_name is required' },
    });
    await expect(
      service.createAndQueue('acc-1', 'u-1', { ...basePayload, name: '  ' }),
    ).rejects.toMatchObject({
      response: { error: 'Broadcast name is required' },
    });
    await expect(
      service.createAndQueue('acc-1', 'u-1', {
        ...basePayload,
        audience: undefined as never,
      }),
    ).rejects.toMatchObject({ response: { error: 'audience is required' } });
  });

  it('fails fast when WhatsApp is not configured', async () => {
    prisma.whatsapp_config.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createAndQueue('acc-1', 'u-1', basePayload),
    ).rejects.toMatchObject({
      response: { error: expect.stringContaining('WhatsApp not configured') },
    });
    expect(prisma.broadcasts.create).not.toHaveBeenCalled();
  });

  it('rejects an empty audience without creating anything', async () => {
    prisma.contacts.findMany.mockResolvedValueOnce([]);
    await expect(
      service.createAndQueue('acc-1', 'u-1', basePayload),
    ).rejects.toMatchObject({
      response: { error: 'No contacts found for this audience.' },
    });
    expect(prisma.broadcasts.create).not.toHaveBeenCalled();
    expect(queue.enqueueBroadcast).not.toHaveBeenCalled();
  });

  it('creates the broadcast as "queued" — nothing has been sent yet', async () => {
    const result = await service.createAndQueue('acc-1', 'u-1', {
      ...basePayload,
      headerMediaUrl: ' https://x.test/img.png ',
    });

    expect(result).toEqual({ id: 'b-1', totalRecipients: 1 });
    expect(prisma.broadcasts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account_id: 'acc-1',
          user_id: 'u-1',
          status: 'queued',
          total_recipients: 1,
          template_variables: expect.objectContaining({
            _headerMediaUrl: 'https://x.test/img.png',
          }),
        }),
      }),
    );
    expect(prisma.broadcast_recipients.createMany).toHaveBeenCalledWith({
      data: [{ broadcast_id: 'b-1', contact_id: 'c-1', status: 'pending' }],
    });
    expect(queue.enqueueBroadcast).toHaveBeenCalledWith('b-1');
  });

  it('resolves a tags audience scoped to the account, minus excluded tags', async () => {
    prisma.contact_tags.findMany
      .mockResolvedValueOnce([
        { contact_id: 'c-1' },
        { contact_id: 'c-2' },
        { contact_id: 'c-1' },
      ])
      .mockResolvedValueOnce([{ contact_id: 'c-2' }]);
    prisma.contacts.findMany.mockResolvedValueOnce([
      CONTACT,
      { ...CONTACT, id: 'c-2', phone: '+919999999999' },
    ]);

    const result = await service.createAndQueue('acc-1', 'u-1', {
      ...basePayload,
      audience: { type: 'tags', tagIds: ['t-1'], excludeTagIds: ['t-x'] },
    });

    expect(result.totalRecipients).toBe(1);
    expect(prisma.contacts.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c-1', 'c-2'] }, account_id: 'acc-1' },
      }),
    );
    expect(prisma.broadcast_recipients.createMany).toHaveBeenCalledWith({
      data: [{ broadcast_id: 'b-1', contact_id: 'c-1', status: 'pending' }],
    });
  });

  it('upserts CSV rows into real contacts before queueing', async () => {
    prisma.contacts.findMany.mockResolvedValueOnce([CONTACT]); // existing lookup
    prisma.contacts.create.mockResolvedValueOnce({
      ...CONTACT,
      id: 'c-new',
      phone: '+918888888888',
      name: 'New Person',
    });

    const result = await service.createAndQueue('acc-1', 'u-1', {
      ...basePayload,
      audience: {
        type: 'csv',
        csvContacts: [
          { phone: '+911234567890', name: 'Asha' },
          { phone: '+918888888888', name: 'New Person' },
          { phone: '+918888888888', name: 'Duplicate Row' },
        ],
      },
    });

    expect(result.totalRecipients).toBe(2);
    expect(prisma.contacts.create).toHaveBeenCalledTimes(1);
    expect(prisma.contacts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account_id: 'acc-1',
          phone: '+918888888888',
        }),
      }),
    );
  });
});
