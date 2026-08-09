/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BroadcastRecipientSendService,
  BroadcastUnsendableError,
  isTransientSendError,
} from './broadcast-recipient-send.service';
import {
  MetaApiError,
  MetaRateLimitError,
} from '../../common/messaging/meta-errors';
import type { PrismaService } from '../../prisma/prisma.service';

vi.mock('../meta-api.util', () => ({
  sendTemplateMessage: vi.fn(),
}));
vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn(() => 'decrypted-token'),
}));

import { sendTemplateMessage } from '../meta-api.util';
import type { EntitlementService } from '../../subscription/services/entitlement.service';

const CONTACT = {
  id: 'c-1',
  phone: '+911234567890',
  name: 'Asha',
  email: 'asha@x.test',
  company: 'Acme',
};

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    broadcast_recipients: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'r-1',
        status: 'pending',
        broadcast_id: 'b-1',
        template_params: null,
        contacts: CONTACT,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    broadcasts: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'b-1',
        account_id: 'acc-1',
        status: 'sending',
        template_name: 'welcome',
        template_language: 'en_US',
        template_variables: { '1': { type: 'field', value: 'name' } },
      }),
    },
    whatsapp_config: {
      findFirst: vi.fn().mockResolvedValue({
        phone_number_id: 'pn-1',
        access_token: 'enc',
      }),
    },
    message_templates: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    contact_custom_values: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

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

describe('isTransientSendError', () => {
  it('retries throttling and 5xx, not a rejected template', () => {
    expect(
      isTransientSendError(new MetaRateLimitError('slow down', 4, 429)),
    ).toBe(true);
    expect(isTransientSendError(new MetaApiError('boom', undefined, 503))).toBe(
      true,
    );
    // The case that matters: an unapproved template would fail
    // identically five more times, and burning the retries turns a
    // clear failure report into twenty minutes of backoff.
    expect(
      isTransientSendError(new MetaApiError('template not found', 132001, 400)),
    ).toBe(false);
  });

  it('retries network-level failures that carry no status', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientSendError(abort)).toBe(true);
    expect(isTransientSendError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientSendError(new Error('something else'))).toBe(false);
  });
});

describe('BroadcastRecipientSendService.sendOne', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BroadcastRecipientSendService;
  const sendMock = vi.mocked(sendTemplateMessage);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new BroadcastRecipientSendService(
      prisma as unknown as PrismaService,
      makeEntitlementsMock() as unknown as EntitlementService,
    );
    sendMock.mockResolvedValue({ messageId: 'wamid.1' });
  });

  it('skips a recipient that is no longer pending (redelivered job)', async () => {
    prisma.broadcast_recipients.findUnique.mockResolvedValueOnce({
      id: 'r-1',
      status: 'sent',
      broadcast_id: 'b-1',
      template_params: null,
      contacts: CONTACT,
    });

    const outcome = await service.sendOne('b-1', 'r-1');

    expect(outcome).toEqual({ status: 'skipped', reason: 'already sent' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips when the broadcast has already finished', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      account_id: 'acc-1',
      status: 'sent',
      template_name: 'welcome',
      template_language: 'en_US',
      template_variables: {},
    });

    const outcome = await service.sendOne('b-1', 'r-1');

    expect(outcome.status).toBe('skipped');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('resolves dashboard-style variable mappings per contact', async () => {
    const outcome = await service.sendOne('b-1', 'r-1');

    expect(outcome).toEqual({ status: 'sent', messageId: 'wamid.1' });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'decrypted-token',
        templateName: 'welcome',
        params: ['Asha'],
      }),
    );
  });

  it('prefers the API path’s per-recipient params over the mapping', async () => {
    prisma.broadcast_recipients.findUnique.mockResolvedValueOnce({
      id: 'r-1',
      status: 'pending',
      broadcast_id: 'b-1',
      template_params: ['Explicit', 'Second'],
      contacts: CONTACT,
    });

    await service.sendOne('b-1', 'r-1');

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: ['Explicit', 'Second'] }),
    );
    // No mapping resolution means no custom-value lookup either.
    expect(prisma.contact_custom_values.findMany).not.toHaveBeenCalled();
  });

  it('only reads custom values when a mapping actually uses one', async () => {
    await service.sendOne('b-1', 'r-1');
    expect(prisma.contact_custom_values.findMany).not.toHaveBeenCalled();

    prisma.broadcasts.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      account_id: 'acc-1',
      status: 'sending',
      template_name: 'welcome',
      template_language: 'en_US',
      template_variables: { '1': { type: 'custom_field', value: 'cf-1' } },
    });
    prisma.contact_custom_values.findMany.mockResolvedValueOnce([
      { custom_field_id: 'cf-1', value: 'Gold' },
    ]);

    await service.sendOne('b-1', 'r-1');

    expect(prisma.contact_custom_values.findMany).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: ['Gold'] }),
    );
  });

  it('fails a recipient with no usable phone without calling Meta', async () => {
    prisma.broadcast_recipients.findUnique.mockResolvedValueOnce({
      id: 'r-1',
      status: 'pending',
      broadcast_id: 'b-1',
      template_params: null,
      contacts: { ...CONTACT, phone: 'not-a-number' },
    });

    const outcome = await service.sendOne('b-1', 'r-1');

    expect(outcome).toEqual({
      status: 'failed',
      error: 'Invalid phone number',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('records a permanent Meta rejection instead of retrying it', async () => {
    sendMock.mockRejectedValue(
      new MetaApiError('Template does not exist', 132001, 400),
    );

    const outcome = await service.sendOne('b-1', 'r-1');

    expect(outcome).toEqual({
      status: 'failed',
      error: 'Template does not exist',
    });
  });

  it('rethrows a throttle so BullMQ retries and the row stays pending', async () => {
    sendMock.mockRejectedValue(new MetaRateLimitError('too many', 4, 429));

    await expect(service.sendOne('b-1', 'r-1')).rejects.toBeInstanceOf(
      MetaRateLimitError,
    );
    expect(prisma.broadcast_recipients.update).not.toHaveBeenCalled();
  });

  it('raises BroadcastUnsendableError when the account cannot send at all', async () => {
    prisma.whatsapp_config.findFirst.mockResolvedValueOnce(null);

    await expect(service.sendOne('b-1', 'r-1')).rejects.toBeInstanceOf(
      BroadcastUnsendableError,
    );
  });

  it('never writes the access token anywhere but the send call', async () => {
    await service.sendOne('b-1', 'r-1');

    const markCalls = prisma.broadcast_recipients.update.mock.calls;
    expect(JSON.stringify(markCalls)).not.toContain('decrypted-token');
  });
});

describe('BroadcastRecipientSendService.markRecipient', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BroadcastRecipientSendService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new BroadcastRecipientSendService(
      prisma as unknown as PrismaService,
      makeEntitlementsMock() as unknown as EntitlementService,
    );
  });

  it('writes the message id on success and clears any earlier error', async () => {
    await service.markRecipient('r-1', {
      status: 'sent',
      messageId: 'wamid.1',
    });

    expect(prisma.broadcast_recipients.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: expect.objectContaining({
        status: 'sent',
        whatsapp_message_id: 'wamid.1',
        error_message: null,
      }),
    });
  });

  it('truncates a long error rather than failing the write', async () => {
    await service.markRecipient('r-1', {
      status: 'failed',
      error: 'x'.repeat(900),
    });

    // mock.calls is a list of argument LISTS, hence the double unwrap.
    const [[arg]] = prisma.broadcast_recipients.update.mock
      .calls as unknown as Array<[{ data: { error_message: string } }]>;
    expect(arg.data.error_message).toHaveLength(500);
  });

  it('does nothing for a skipped outcome', async () => {
    await service.markRecipient('r-1', {
      status: 'skipped',
      reason: 'already sent',
    });
    expect(prisma.broadcast_recipients.update).not.toHaveBeenCalled();
  });
});
