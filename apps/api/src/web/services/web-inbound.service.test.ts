import { describe, expect, it, vi } from 'vitest';
import { WebInboundService } from './web-inbound.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import type { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import type { AiReplyService } from '../../ai/services/ai-reply.service';
import type { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import type { WebStreamService } from './web-stream.service';

function makeService(contactPhone: string | null) {
  const prisma = {
    conversations: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'conv-1',
        contact_id: 'contact-1',
        last_inbound_at: new Date('2026-10-17T00:00:00Z'),
        contacts: { phone: contactPhone },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    messages: {
      create: vi.fn().mockResolvedValue({
        id: 'msg-1',
        created_at: new Date('2026-10-17T00:00:01Z'),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const webhookDeliver = {
    dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
  };
  const service = new WebInboundService(
    prisma as unknown as PrismaService,
    {} as unknown as FlowDispatchService,
    {
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as AutomationDispatchService,
    {
      dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as AiReplyService,
    webhookDeliver as unknown as WebhookDeliverService,
    {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebStreamService,
  );
  return { service, webhookDeliver };
}

const input = {
  accountId: 'acc-1',
  ownerUserId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  contentType: 'text' as const,
  text: 'hello',
};

describe('WebInboundService — message.received webhook', () => {
  it('omits phone for an anonymous visitor', async () => {
    const { service, webhookDeliver } = makeService(null);
    await service.handle(input);

    expect(webhookDeliver.dispatchWebhookEvent).toHaveBeenCalledWith(
      'acc-1',
      'message.received',
      {
        channel: 'web',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        message_id: 'msg-1',
        content_type: 'text',
        text: 'hello',
      },
    );
  });

  it('includes the phone when the visitor has one on file', async () => {
    const { service, webhookDeliver } = makeService('+919876543210');
    await service.handle(input);

    expect(webhookDeliver.dispatchWebhookEvent).toHaveBeenCalledWith(
      'acc-1',
      'message.received',
      expect.objectContaining({ channel: 'web', phone: '+919876543210' }),
    );
  });
});
