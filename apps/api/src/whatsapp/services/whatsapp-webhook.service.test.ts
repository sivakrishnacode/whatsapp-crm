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
      aiReplyService as any,
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
});
