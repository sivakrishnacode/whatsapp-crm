import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WhatsappWebhookService } from '../services/whatsapp-webhook.service';
import { verifyMetaWebhookSignature } from '../utils/webhook-signature.util';

@Controller('whatsapp/webhook')
export class WhatsappWebhookController {
  constructor(private readonly webhookService: WhatsappWebhookService) {}

  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.webhookService.handleVerification(
        mode,
        challenge,
        verifyToken,
      );
      res.setHeader('Content-Type', 'text/plain');
      res.status(HttpStatus.OK).send(result);
    } catch (err: any) {
      res
        .status(err.getStatus?.() || HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: err.message || 'Verification failed' });
    }
  }

  @Post()
  async receive(@Req() req: Request, @Res() res: Response) {
    const rawBodyBuffer = (req as any).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString('utf8') : '';
    const signature = (req.headers['x-hub-signature-256'] as string) || null;

    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      console.warn('[webhook] rejected request with invalid signature');
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpException('Invalid JSON', HttpStatus.BAD_REQUEST);
    }

    this.webhookService.handleWebhookReceived(body);

    res.status(HttpStatus.OK).json({ accepted: true });
  }
}
