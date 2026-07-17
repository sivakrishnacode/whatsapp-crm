/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import {
  DashboardBroadcastService,
  resolveBroadcastVariables,
  type VariableMapping,
} from './dashboard-broadcast.service';
import type { PrismaService } from '../../prisma/prisma.service';

vi.mock('../meta-api.util', () => ({
  sendTemplateMessage: vi.fn(),
}));
vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn(() => 'decrypted-token'),
}));

import { sendTemplateMessage } from '../meta-api.util';

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

describe('DashboardBroadcastService.createAndQueue', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let queue: { add: ReturnType<typeof vi.fn> };
  let service: DashboardBroadcastService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrismaMock();
    queue = { add: vi.fn().mockResolvedValue({}) };
    service = new DashboardBroadcastService(
      prisma as unknown as PrismaService,
      queue as unknown as Queue,
    );
  });

  it('rejects missing template name / broadcast name / audience', async () => {
    await expect(
      service.createAndQueue('acc-1', 'u-1', { ...basePayload, templateName: '' }),
    ).rejects.toMatchObject({ response: { error: 'template_name is required' } });
    await expect(
      service.createAndQueue('acc-1', 'u-1', { ...basePayload, name: '  ' }),
    ).rejects.toMatchObject({ response: { error: 'Broadcast name is required' } });
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
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('creates broadcast + pending recipients and queues an idempotent job', async () => {
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
          status: 'sending',
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
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      { broadcastId: 'b-1' },
      expect.objectContaining({ jobId: 'b-1', attempts: 3 }),
    );
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

describe('DashboardBroadcastService.deliver', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: DashboardBroadcastService;
  const sendMock = vi.mocked(sendTemplateMessage);

  const BROADCAST_ROW = {
    id: 'b-1',
    account_id: 'acc-1',
    status: 'sending',
    template_name: 'hello_world',
    template_language: 'en_US',
    template_variables: { '1': { type: 'field', value: 'name' } },
    total_recipients: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrismaMock();
    service = new DashboardBroadcastService(
      prisma as unknown as PrismaService,
      { add: vi.fn() } as unknown as Queue,
    );
  });

  it('no-ops for missing or already-finished broadcasts (idempotent resume)', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce(null);
    await service.deliver('missing');

    prisma.broadcasts.findUnique.mockResolvedValueOnce({
      ...BROADCAST_ROW,
      status: 'sent',
    });
    await service.deliver('b-1');

    expect(prisma.broadcast_recipients.findMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails all pending recipients when WhatsApp config is gone', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce(BROADCAST_ROW);
    prisma.whatsapp_config.findFirst.mockResolvedValueOnce(null);

    await service.deliver('b-1');

    expect(prisma.broadcast_recipients.updateMany).toHaveBeenCalledWith({
      where: { broadcast_id: 'b-1', status: 'pending' },
      data: { status: 'failed', error_message: 'WhatsApp not configured' },
    });
    expect(prisma.broadcasts.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('sends only pending recipients, marks rows, and finishes as sent', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce(BROADCAST_ROW);
    prisma.broadcast_recipients.findMany.mockResolvedValueOnce([
      { id: 'r-1', contacts: CONTACT },
      { id: 'r-2', contacts: { ...CONTACT, id: 'c-2', phone: '+919999999999', name: 'Vik' } },
    ]);
    sendMock
      .mockResolvedValueOnce({ messageId: 'wamid-1' } as never)
      .mockRejectedValueOnce(new Error('Meta said no'));
    prisma.broadcast_recipients.count.mockResolvedValueOnce(1);

    await service.deliver('b-1');

    expect(prisma.broadcast_recipients.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { broadcast_id: 'b-1', status: 'pending' },
      }),
    );
    // Personalized params resolved per contact from the stored mapping;
    // `to` is sanitized to Meta's digits-only format.
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: ['Asha'], to: '911234567890' }),
    );
    expect(prisma.broadcast_recipients.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r-1' },
        data: expect.objectContaining({ status: 'sent', whatsapp_message_id: 'wamid-1' }),
      }),
    );
    expect(prisma.broadcast_recipients.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r-2' },
        data: expect.objectContaining({ status: 'failed', error_message: 'Meta said no' }),
      }),
    );
    expect(prisma.broadcasts.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    );
  });

  it('marks recipients without a valid phone failed without calling Meta', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce(BROADCAST_ROW);
    prisma.broadcast_recipients.findMany.mockResolvedValueOnce([
      { id: 'r-1', contacts: { ...CONTACT, phone: null } },
      { id: 'r-2', contacts: { ...CONTACT, id: 'c-2', phone: 'not-a-phone' } },
    ]);
    prisma.broadcast_recipients.count.mockResolvedValueOnce(0);

    await service.deliver('b-1');

    expect(sendMock).not.toHaveBeenCalled();
    expect(prisma.broadcast_recipients.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r-1' },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    // Nothing went out → the broadcast lands on failed
    expect(prisma.broadcasts.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
