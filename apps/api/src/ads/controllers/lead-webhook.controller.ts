import { Controller, Get, Post, Query, Req, Res, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as express from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { LEAD_FETCH_QUEUE } from '../../queue/queue.constants';

/**
 * Meta lead-form submissions.
 *
 * Moved here from IntegrationsModule with migration 081, when the
 * "Facebook Leads" integration was removed. The endpoint path is
 * unchanged (`/webhooks/facebook-leads`) because it is registered in the
 * Meta app dashboard: renaming it silently stops every lead already in
 * flight.
 *
 * ⚠️ TWO GUARDS ARE DELIBERATELY ABSENT.
 *
 *   No auth guard: this is an unauthenticated server-to-server callback.
 *   Authorisation is the `X-Hub-Signature-256` HMAC below, and tenant
 *   resolution is the `page_id` lookup in LeadIngestService.
 *
 *   No `AdsEnabledGuard`, unlike every other controller in this module.
 *   A Page subscription lives in Meta's dashboard, not in our config, so
 *   Meta keeps delivering whatever our feature flag says. 404ing those
 *   deliveries makes Meta retry and eventually disable the subscription
 *   outright — a flag flip would then need a manual re-subscribe to undo.
 *   Acknowledging and dropping is the honest behaviour, and it is what
 *   happens anyway: with the feature off there is no connected Page for
 *   the lookup to find. Same reasoning as AdsPrivacyController.
 */
@Controller('webhooks/facebook-leads')
export class LeadWebhookController {
  private readonly logger = new Logger(LeadWebhookController.name);

  constructor(
    @InjectQueue(LEAD_FETCH_QUEUE) private readonly leadQueue: Queue,
  ) {}

  /**
   * GET /webhooks/facebook-leads — Meta challenge verification.
   */
  @Get()
  verifyChallenge(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: express.Response,
  ) {
    const expected =
      process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN ?? 'wacrm-fb-leads-verify';

    if (mode === 'subscribe' && verifyToken === expected) {
      this.logger.log('Meta lead webhook verified');
      return res.status(200).send(challenge);
    }

    this.logger.warn('Meta lead webhook verification failed');
    return res.status(403).send('Verification failed');
  }

  /**
   * POST /webhooks/facebook-leads — real-time lead notification.
   */
  @Post()
  async handleLeadEvent(
    @Req() req: RawBodyRequest<express.Request>,
    @Res() res: express.Response,
  ) {
    // Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body with app secret)
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const appSecret = process.env.META_APP_SECRET ?? '';

    if (appSecret && signature) {
      const rawBody = req.rawBody ?? Buffer.from('');
      const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      const valid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

      if (!valid) {
        this.logger.warn('Meta lead webhook: invalid HMAC signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    } else if (appSecret) {
      // App secret configured but no signature sent — reject
      this.logger.warn('Meta lead webhook: missing X-Hub-Signature-256');
      return res.status(403).json({ error: 'Missing signature' });
    }

    const body = req.body as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: { leadgen_id?: string; page_id?: string };
        }>;
      }>;
    };

    if (body.object !== 'page') {
      return res
        .status(200)
        .json({ success: true, ignored: 'not page object' });
    }

    // Queue each lead, then acknowledge. Meta redelivers a webhook it
    // does not get a prompt 200 for, so the handler must not wait on a
    // Graph fetch. `jobId` is the leadgen id: Meta's own redelivery of
    // the same notification then collapses into the one job it already is.
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen') {
          const { leadgen_id, page_id } = change.value ?? {};
          if (leadgen_id && page_id) {
            try {
              await this.leadQueue.add(
                'fetch',
                { leadgenId: leadgen_id, pageId: page_id },
                {
                  jobId: `lead:${leadgen_id}`,
                  attempts: 5,
                  backoff: { type: 'exponential', delay: 5000 },
                  removeOnComplete: { count: 100 },
                  removeOnFail: { count: 500 },
                },
              );
            } catch (err) {
              this.logger.error(`could not queue Meta lead ${leadgen_id}`, err);
            }
          }
        }
      }
    }

    return res.status(200).json({ success: true });
  }
}
