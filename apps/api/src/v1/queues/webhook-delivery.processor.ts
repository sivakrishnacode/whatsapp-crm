import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { WEBHOOK_DELIVERY_QUEUE } from '../../queue/queue.constants';
import {
  WebhookDeliverService,
  type WebhookDeliveryJobData,
} from '../services/webhook-deliver.service';

/**
 * Thrown for a delivery that should be tried again. Its message is what
 * ends up in the job's failure record, so it carries the endpoint's own
 * complaint verbatim — "endpoint responded 503" is the answer to the
 * support question, and a wrapped/generic message is not.
 */
class RetryableDeliveryError extends Error {}

/**
 * Delivers one webhook event to one endpoint.
 *
 * Concurrency 20 because these jobs are almost entirely spent waiting
 * on somebody else's server (with a 5s timeout), and one slow
 * subscriber must not hold up everyone else's events.
 */
@Injectable()
@Processor(WEBHOOK_DELIVERY_QUEUE, { concurrency: 20 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly deliver: WebhookDeliverService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobData>): Promise<void> {
    const attempt = await this.deliver.deliverToEndpoint(job.data);
    if (attempt.ok) return;

    if (attempt.retryable) {
      throw new RetryableDeliveryError(attempt.error ?? 'delivery failed');
    }

    // Permanently rejected — a 4xx, an unreachable target, a secret we
    // can no longer decrypt. Count it against the endpoint now and
    // return successfully: the *job* did its work, the delivery just
    // isn't going to happen. Throwing here would burn four more
    // attempts to reach the identical answer.
    this.logger.warn(
      `[webhooks] permanent failure for endpoint=${job.data.endpointId} event=${job.data.event}: ${attempt.error}`,
    );
    await this.deliver.recordFailure({ id: job.data.endpointId });
  }

  /**
   * Retries exhausted. This is the one place a *transient* failure gets
   * counted against the endpoint's consecutive-failure budget, so an
   * endpoint that is genuinely down still gets disabled after
   * MAX_CONSECUTIVE_FAILURES events — just not after
   * MAX_CONSECUTIVE_FAILURES/5 of them.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookDeliveryJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    this.logger.error(
      `[webhooks] gave up after ${attempts} attempts: endpoint=${job.data.endpointId} event=${job.data.event}: ${err.message}`,
    );
    await this.deliver.recordFailure({ id: job.data.endpointId });
  }
}
