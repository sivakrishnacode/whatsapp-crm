import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { verifyMetaWebhookSignature } from '../utils/webhook-signature.util';

vi.mock('../utils/webhook-signature.util', () => ({
  verifyMetaWebhookSignature: vi.fn(),
}));

describe('WhatsappWebhookController', () => {
  let webhookService: any;
  let controller: WhatsappWebhookController;
  let mockResponse: any;

  beforeEach(() => {
    vi.clearAllMocks();

    webhookService = {
      handleVerification: vi.fn(),
      handleWebhookReceived: vi.fn(),
    };

    controller = new WhatsappWebhookController(webhookService);

    mockResponse = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    };
  });

  describe('verify', () => {
    it('returns challenge on successful verification', async () => {
      webhookService.handleVerification.mockResolvedValue('my_challenge');

      await controller.verify(
        'subscribe',
        'my_challenge',
        'my_token',
        mockResponse,
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/plain',
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.send).toHaveBeenCalledWith('my_challenge');
    });

    it('returns error status on failed verification', async () => {
      const error: any = new Error('Mismatch');
      error.getStatus = () => 403;
      webhookService.handleVerification.mockRejectedValue(error);

      await controller.verify(
        'subscribe',
        'my_challenge',
        'my_token',
        mockResponse,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Mismatch' });
    });
  });

  describe('receive', () => {
    it('returns 200 accepted when signature is valid', async () => {
      vi.mocked(verifyMetaWebhookSignature).mockReturnValue(true);

      const mockRequest: any = {
        rawBody: Buffer.from(JSON.stringify({ entry: [] })),
        headers: {
          'x-hub-signature-256': 'sha256=validsig',
        },
      };

      await controller.receive(mockRequest, mockResponse);

      expect(webhookService.handleWebhookReceived).toHaveBeenCalledWith({
        entry: [],
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({ accepted: true });
    });

    it('throws UNAUTHORIZED when signature is invalid', async () => {
      vi.mocked(verifyMetaWebhookSignature).mockReturnValue(false);

      const mockRequest: any = {
        rawBody: Buffer.from('{}'),
        headers: {
          'x-hub-signature-256': 'sha256=invalidsig',
        },
      };

      await expect(
        controller.receive(mockRequest, mockResponse),
      ).rejects.toThrow('Invalid signature');
    });
  });
});
