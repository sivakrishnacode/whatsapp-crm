import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { InstagramWebhookService } from '../services/instagram-webhook.service';
import { verifyInstagramWebhookSignature } from '../utils/ig-webhook-signature.util';

/**
 * `POST /instagram/webhook` — Meta's inbound push.
 *
 * TWO THINGS THIS ENDPOINT MUST DO, IN THIS ORDER
 *   1. Verify the signature against the RAW body. Any middleware that
 *      re-serialises JSON breaks the HMAC, which is why this reads
 *      `req.rawBody` (populated in main.ts) rather than `req.body`.
 *   2. Answer 200 immediately. Meta retries slow endpoints and
 *      eventually disables a subscription that keeps timing out, so
 *      all processing is fire-and-forget behind the response.
 *
 * Mirrors whatsapp-webhook.controller.ts deliberately — the two
 * surfaces should be diffable.
 */
@Controller('instagram/webhook')
export class InstagramWebhookController {
  private readonly logger = new Logger(InstagramWebhookController.name);

  constructor(private readonly webhookService: InstagramWebhookService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
    @Res() res: Response,
  ) {
    try {
      const result = this.webhookService.handleVerification(
        mode,
        challenge,
        verifyToken,
      );
      // Meta requires the bare challenge string, not JSON.
      res.setHeader('Content-Type', 'text/plain');
      res.status(HttpStatus.OK).send(result);
    } catch (err: any) {
      res
        .status(err.getStatus?.() ?? HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: err.message ?? 'Verification failed' });
    }
  }

  @Post()
  receive(@Req() req: Request, @Res() res: Response) {
    const rawBodyBuffer = (req as any).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString('utf8') : '';
    const signature = (req.headers['x-hub-signature-256'] as string) || null;

    if (!verifyInstagramWebhookSignature(rawBody, signature)) {
      // The overwhelmingly likely cause is INSTAGRAM_APP_SECRET being
      // unset or set to META_APP_SECRET — they are different apps.
      this.logger.warn(
        'Rejected an Instagram webhook with an invalid signature. ' +
          'Check INSTAGRAM_APP_SECRET (Meta → Instagram → API setup with Instagram login), ' +
          'which is NOT the same value as META_APP_SECRET.',
      );
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpException('Invalid JSON', HttpStatus.BAD_REQUEST);
    }

    // Meta reuses this endpoint shape across products; ignore anything
    // that is not an Instagram push rather than trying to parse it.
    if (body?.object && body.object !== 'instagram') {
      return res.status(HttpStatus.OK).json({ ignored: body.object });
    }

    this.webhookService.handleWebhookReceived(body);

    return res.status(HttpStatus.OK).json({ accepted: true });
  }
}
