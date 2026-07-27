import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import type { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import type { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';

vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn((val) => val),
  encrypt: vi.fn((val) => val),
  isLegacyFormat: vi.fn(() => false),
}));

function makePrismaMock() {
  return {
    whatsapp_config: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    messages: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    broadcast_recipients: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeWebhookDeliverMock() {
  return {
    dispatchWebhookEvent: vi.fn().mockResolvedValue({}),
  };
}

function makeFlowDispatchMock() {
  return {
    dispatchInbound: vi.fn().mockResolvedValue({ consumed: false }),
  };
}

function makeAutomationDispatchMock() {
  return {
    dispatch: vi.fn().mockResolvedValue({}),
  };
}

describe('WhatsappWebhookService', () => {
  let prisma: any;
  let webhookDeliver: any;
  let flowDispatch: any;
  let automationDispatch: any;
  let aiReplyService: any;
  let service: WhatsappWebhookService;

  beforeEach(() => {
    prisma = makePrismaMock();
    webhookDeliver = makeWebhookDeliverMock();
    flowDispatch = makeFlowDispatchMock();
    automationDispatch = makeAutomationDispatchMock();
    aiReplyService = {
      dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
    };
    service = new WhatsappWebhookService(
      prisma as unknown as PrismaService,
      webhookDeliver as unknown as WebhookDeliverService,
      flowDispatch as unknown as FlowDispatchService,
      automationDispatch as unknown as AutomationDispatchService,
      aiReplyService,
    );
  });

  describe('handleVerification', () => {
    it('returns the challenge when verify token matches', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([
        { id: '1', verify_token: 'my_secret_token' },
      ]);

      const result = await service.handleVerification(
        'subscribe',
        'my_challenge_code',
        'my_secret_token',
      );

      expect(result).toBe('my_challenge_code');
    });

    it('throws Forbidden exception when verify token does not match', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([
        { id: '1', verify_token: 'some_other_token' },
      ]);

      await expect(
        service.handleVerification(
          'subscribe',
          'my_challenge_code',
          'my_secret_token',
        ),
      ).rejects.toThrow('Verification token mismatch');
    });
  });

  describe('handleStatusUpdate', () => {
    it('updates messages status and triggers public webhook event', async () => {
      prisma.messages.findFirst.mockResolvedValue({
        conversation_id: 'conv-123',
        conversations: {
          account_id: 'acc-456',
        },
      });

      // We call the private method by casting to any
      await (service as any).handleStatusUpdate({
        id: 'msg-wamid',
        status: 'delivered',
        timestamp: '1719914400',
        recipient_id: 'rec-phone',
      });

      expect(prisma.messages.updateMany).toHaveBeenCalledWith({
        where: { message_id: 'msg-wamid' },
        data: { status: 'delivered' },
      });

      expect(webhookDeliver.dispatchWebhookEvent).toHaveBeenCalledWith(
        'acc-456',
        'message.status_updated',
        {
          whatsapp_message_id: 'msg-wamid',
          conversation_id: 'conv-123',
          status: 'delivered',
        },
      );
    });
  });

  describe('handleLimitUpdate', () => {
    const CONFIG = { id: 'cfg-1', account_id: 'acc-1' };

    it('updates tier and daily limit from business_capability_update', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_10K' },
        'waba-1',
      );

      expect(prisma.whatsapp_config.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: expect.objectContaining({
          messaging_limit_tier: 'TIER_10K',
          tier_daily_limit: 10000,
          limits_synced_at: expect.any(Date),
        }),
      });
    });

    it('updates only the quality rating when no tier is present', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'phone_number_quality_update',
        { current_quality_rating: 'RED' },
        'waba-1',
      );

      const data = prisma.whatsapp_config.update.mock.calls[0][0].data;
      expect(data.quality_rating).toBe('RED');
      // Absent from the payload, so it must not be clobbered to null.
      expect(data).not.toHaveProperty('messaging_limit_tier');
      expect(data).not.toHaveProperty('tier_daily_limit');
    });

    it('stores an unrecognised tier raw with a null limit', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_5M' },
        'waba-1',
      );

      expect(prisma.whatsapp_config.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: expect.objectContaining({
          messaging_limit_tier: 'TIER_5M',
          tier_daily_limit: null,
        }),
      });
    });

    it('resolves by phone_number_id when the payload carries metadata', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_1K', metadata: { phone_number_id: 'pn-9' } },
        'waba-1',
      );

      expect(prisma.whatsapp_config.findMany).toHaveBeenCalledWith({
        where: { phone_number_id: 'pn-9' },
        select: { id: true, account_id: true },
      });
    });

    it('falls back to waba_id when there is no metadata', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_1K' },
        'waba-1',
      );

      expect(prisma.whatsapp_config.findMany).toHaveBeenCalledWith({
        where: { waba_id: 'waba-1' },
        select: { id: true, account_id: true },
      });
    });

    it('skips an ambiguous waba_id match rather than guessing', async () => {
      // waba_id is not unique in the schema.
      prisma.whatsapp_config.findMany.mockResolvedValue([
        CONFIG,
        { id: 'cfg-2', account_id: 'acc-2' },
      ]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_1K' },
        'waba-1',
      );

      expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
    });

    it('no-ops when no config matches', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { current_limit: 'TIER_1K' },
        'waba-1',
      );

      expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
    });

    it('no-ops on a payload carrying neither tier nor quality', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).handleLimitUpdate(
        'business_capability_update',
        { something_else: true },
        'waba-1',
      );

      expect(prisma.whatsapp_config.findMany).not.toHaveBeenCalled();
      expect(prisma.whatsapp_config.update).not.toHaveBeenCalled();
    });

    it('never throws when the DB write fails', async () => {
      // handleWebhookReceived is fire-and-forget; Meta already got its 200.
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);
      prisma.whatsapp_config.update.mockRejectedValue(new Error('db down'));

      await expect(
        (service as any).handleLimitUpdate(
          'business_capability_update',
          { current_limit: 'TIER_1K' },
          'waba-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('dispatches limit fields from processWebhook without touching message paths', async () => {
      prisma.whatsapp_config.findMany.mockResolvedValue([CONFIG]);

      await (service as any).processWebhook({
        entry: [
          {
            id: 'waba-1',
            changes: [
              {
                field: 'business_capability_update',
                value: { current_limit: 'TIER_100K' },
              },
            ],
          },
        ],
      });

      expect(prisma.whatsapp_config.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: expect.objectContaining({ tier_daily_limit: 100000 }),
      });
      expect(flowDispatch.dispatchInbound).not.toHaveBeenCalled();
    });
  });
});
