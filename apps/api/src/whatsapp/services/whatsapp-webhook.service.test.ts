import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import type { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import type { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import type { WhatsAppMessageMetadata } from '../../common/messages/message-content.types';

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

  /**
   * `parseMessageContent` is private, but it is where every inbound
   * type is decided and it is pure for everything that isn't media
   * (media calls Meta to verify the id). Reaching it directly beats
   * driving the whole webhook for each case.
   */
  describe('parseMessageContent', () => {
    interface ParsedContent {
      contentText: string | null;
      mediaUrl: string | null;
      mediaType: string | null;
      interactiveReplyId: string | null;
      metadata: WhatsAppMessageMetadata | null;
    }

    // Typed rather than `as any`: the cast is to the private method's
    // real signature, so the assertions below still type-check against
    // what the parser actually returns.
    const parse = (message: Record<string, unknown>): Promise<ParsedContent> =>
      (
        service as unknown as {
          parseMessageContent(
            m: unknown,
            token: string,
          ): Promise<ParsedContent>;
        }
      ).parseMessageContent(message, 'token');

    it('reads a template quick-reply tap instead of calling it unsupported', async () => {
      // The reported bug. Meta sends type 'button' when a customer taps
      // a button on a *template*; with no case for it the agent saw
      // "[Unsupported message type: button]" where an opt-out request
      // should have been.
      const result = await parse({
        type: 'button',
        button: { text: 'Stop promotions', payload: 'STOP_PROMOS' },
      });

      expect(result.contentText).toBe('Stop promotions');
      expect(result.interactiveReplyId).toBe('STOP_PROMOS');
      expect(result.metadata?.source).toBe('template_button');
    });

    it('falls back between a button label and its payload', async () => {
      // Either field can be absent. Neither absence should produce a
      // blank bubble.
      await expect(
        parse({ type: 'button', button: { payload: 'STOP' } }),
      ).resolves.toMatchObject({
        contentText: 'STOP',
        interactiveReplyId: 'STOP',
      });
      await expect(
        parse({ type: 'button', button: { text: 'Stop' } }),
      ).resolves.toMatchObject({
        contentText: 'Stop',
        interactiveReplyId: 'Stop',
      });
    });

    it('reads an interactive button reply and marks its origin', async () => {
      const result = await parse({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'yes', title: 'Yes' },
        },
      });
      expect(result.contentText).toBe('Yes');
      expect(result.interactiveReplyId).toBe('yes');
      expect(result.metadata?.source).toBe('interactive_reply');
    });

    it('reads a completed Flow, parsing its response payload', async () => {
      const result = await parse({
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: {
            body: 'Sent',
            response_json: '{"email":"ada@example.com"}',
          },
        },
      });
      expect(result.contentText).toBe('Sent');
      expect(result.metadata?.source).toBe('flow_reply');
      expect(result.metadata?.flow_response).toEqual({
        email: 'ada@example.com',
      });
    });

    it('keeps a Flow reply whose response payload is malformed', async () => {
      // A bad payload costs the structured answers, not the message.
      const result = await parse({
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: { body: 'Sent', response_json: '{not json' },
        },
      });
      expect(result.contentText).toBe('Sent');
      expect(result.metadata?.flow_response).toBeUndefined();
    });

    it('reads a shared contact card, preferring wa_id over the typed phone', async () => {
      const result = await parse({
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: 'Ada Lovelace' },
            phones: [{ phone: '098 765 4321', wa_id: '919876543210' }],
            org: { company: 'Analytical Engines' },
          },
        ],
      });

      expect(result.contentText).toBe('Ada Lovelace');
      expect(result.metadata?.contacts).toEqual([
        {
          name: 'Ada Lovelace',
          phones: [{ phone: '+919876543210', type: null }],
          emails: [],
          organization: 'Analytical Engines',
        },
      ]);
    });

    it('summarizes multiple shared contacts', async () => {
      const result = await parse({
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: 'A' },
            phones: [{ wa_id: '911111111111' }],
          },
          {
            name: { formatted_name: 'B' },
            phones: [{ wa_id: '912222222222' }],
          },
        ],
      });
      expect(result.contentText).toBe('2 contacts shared');
    });

    it('structures a submitted cart alongside the readable summary', async () => {
      const result = await parse({
        type: 'order',
        order: {
          catalog_id: 'cat_1',
          text: 'gift wrap please',
          product_items: [
            {
              product_retailer_id: 'SKU1',
              quantity: '2',
              item_price: '150.5',
              currency: 'INR',
            },
          ],
        },
      });

      expect(result.contentText).toContain('Cart Submitted');
      expect(result.metadata?.order).toEqual({
        catalog_id: 'cat_1',
        items: [
          {
            retailer_id: 'SKU1',
            quantity: 2,
            unit_price: 150.5,
            currency: 'INR',
          },
        ],
        total: 301,
        currency: 'INR',
        note: 'gift wrap please',
      });
    });

    it('keeps location coordinates structured, not only flattened into text', async () => {
      // The flattened form is "name - address - lat,lng", which cannot
      // be parsed back when the name contains a hyphen.
      const result = await parse({
        type: 'location',
        location: {
          latitude: 13.08,
          longitude: 80.27,
          name: 'A - B',
          address: 'Chennai',
        },
      });
      expect(result.metadata?.location).toEqual({
        latitude: 13.08,
        longitude: 80.27,
        name: 'A - B',
        address: 'Chennai',
      });
    });

    it("surfaces WhatsApp's own reason for an undeliverable message", async () => {
      const result = await parse({
        type: 'unsupported',
        errors: [
          { code: 131051, title: 'Message type is not currently supported' },
        ],
      });
      expect(result.contentText).toBe(
        'Message type is not currently supported',
      );
      expect(result.metadata?.error?.code).toBe(131051);
    });

    it('reads a system notice', async () => {
      const result = await parse({
        type: 'system',
        system: { body: 'Customer changed their phone number' },
      });
      expect(result.contentText).toBe('Customer changed their phone number');
    });

    it('still names a genuinely unknown type, so the missing case is findable', async () => {
      const result = await parse({ type: 'some_future_type' });
      expect(result.contentText).toBe(
        '[Unsupported message type: some_future_type]',
      );
    });
  });
});
