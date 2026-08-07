import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { isDeliverableUrl } from '../../common/security/ssrf.util';
import { buildSignatureHeader } from '../utils/webhook-sign.util';
import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_CALL_JOB_OPTS,
  WEBHOOK_DELIVERY_QUEUE,
} from '../../queue/queue.constants';

export const DELIVERY_TIMEOUT_MS = 5000;
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

export interface TestPingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebhookDeliveryJobData {
  endpointId: string;
  accountId: string;
  event: string;
  /** The exact bytes to sign and send. Built once, at dispatch. */
  payload: string;
}

export interface DeliveryAttempt {
  ok: boolean;
  /** True when another attempt could plausibly succeed. */
  retryable: boolean;
  error?: string;
}

/**
 * Outbound webhooks for the public API.
 *
 * Delivery is queued, not inline. Every caller in the codebase invokes
 * `dispatchWebhookEvent` as `void this.webhookDeliver.dispatch…` from
 * inside a request handler — a WhatsApp webhook, a form submission, a
 * contact create. Doing the HTTP POST there meant a customer's slow
 * endpoint added its latency to our own handler, a single failure lost
 * the event permanently (no retry existed), and a deploy mid-flight
 * dropped whatever was in progress. None of that was visible: the
 * `void` swallowed it.
 *
 * Now dispatch writes N jobs — one per subscribed endpoint — and
 * returns. One job per endpoint rather than one per event so a retry
 * re-delivers only to the endpoint that failed; a customer with three
 * endpoints where one is down does not get two duplicates.
 */
@Injectable()
export class WebhookDeliverService {
  private readonly logger = new Logger(WebhookDeliverService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_DELIVERY_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Queue `event` (+ `data`) for every active endpoint of `accountId`
   * subscribed to it. Never throws — callers are fire-and-forget.
   */
  async dispatchWebhookEvent(
    accountId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    try {
      const rows = await this.prisma.webhook_endpoints.findMany({
        where: {
          account_id: accountId,
          is_active: true,
          events: {
            has: event,
          },
        },
        select: { id: true },
      });

      if (rows.length === 0) return;

      // Built once and carried through every retry: the event id and
      // `occurred_at` describe when the thing happened, not when we
      // last tried to tell anyone about it. A receiver deduplicating on
      // `id` (which the docs tell them to do) would see one retried
      // delivery as three distinct events if this were rebuilt per
      // attempt. The signature is NOT part of this — it is computed at
      // send time so its timestamp stays fresh against replay windows.
      const payload = JSON.stringify({
        id: randomUUID(),
        event,
        occurred_at: new Date().toISOString(),
        account_id: accountId,
        data,
      });

      await this.queue.addBulk(
        rows.map((row) => ({
          name: 'deliver',
          data: {
            endpointId: row.id,
            accountId,
            event,
            payload,
          } as WebhookDeliveryJobData,
          opts: EXTERNAL_CALL_JOB_OPTS,
        })),
      );
    } catch (err) {
      this.logger.error(`[webhooks] dispatch failed:`, err);
    }
  }

  /**
   * One delivery attempt. Called by the processor, which owns the
   * retry policy — this method reports what happened and judges
   * whether trying again could help, but never sleeps or loops.
   */
  async deliverToEndpoint(
    job: WebhookDeliveryJobData,
  ): Promise<DeliveryAttempt> {
    const row = await this.prisma.webhook_endpoints.findFirst({
      // account_id in the filter, not just the id: the job payload is
      // ours, but it costs nothing to keep the tenancy check on the
      // read path and it means a stale job cannot outlive a moved row.
      where: {
        id: job.endpointId,
        account_id: job.accountId,
        is_active: true,
      },
      select: { id: true, url: true, secret: true },
    });
    // Deleted, deactivated, or unsubscribed between dispatch and
    // delivery. Not a failure — there is nobody to deliver to.
    if (!row) return { ok: true, retryable: false };

    // Re-validated per attempt, not once at dispatch: DNS can change
    // under us, and this is the SSRF boundary for a URL the customer
    // controls.
    if (!(await isDeliverableUrl(row.url))) {
      this.logger.warn(
        `[webhooks] refusing non-public delivery target for ${row.id}`,
      );
      return {
        ok: false,
        retryable: false,
        error: 'endpoint is not publicly reachable',
      };
    }

    let secret: string;
    try {
      secret = decrypt(row.secret);
    } catch (err) {
      this.logger.error(`[webhooks] secret decrypt failed for ${row.id}:`, err);
      return { ok: false, retryable: false, error: 'secret decrypt failed' };
    }

    // Signed now, with the current clock. Receivers reject a signature
    // whose timestamp is outside their tolerance, so a job retried
    // twenty minutes later must not carry the original one.
    const tsSeconds = Math.floor(Date.now() / 1000);

    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Converse360-Event': job.event,
          'X-Converse360-Webhook-Id': row.id,
          'X-Converse360-Signature': buildSignatureHeader(
            job.payload,
            secret,
            tsSeconds,
          ),
        },
        body: job.payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        return {
          ok: false,
          // 5xx and 408/429 are "not right now"; every other 4xx is the
          // receiver telling us this request is wrong, and it will be
          // just as wrong in five minutes.
          retryable:
            res.status >= 500 || res.status === 408 || res.status === 429,
          error: `endpoint responded ${res.status}`,
        };
      }

      await this.prisma.webhook_endpoints.update({
        where: { id: row.id },
        data: { failure_count: 0, last_delivery_at: new Date() },
      });
      return { ok: true, retryable: false };
    } catch (err) {
      // Timeout, DNS, connection reset — all worth another try.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, retryable: true, error: message };
    }
  }

  async sendTestWebhookPing(
    accountId: string,
    endpointId: string,
  ): Promise<TestPingResult> {
    const row = await this.prisma.webhook_endpoints.findFirst({
      where: {
        account_id: accountId,
        id: endpointId,
      },
      select: {
        id: true,
        url: true,
        secret: true,
      },
    });

    if (!row) {
      return { ok: false, error: 'Webhook endpoint not found' };
    }

    if (!(await isDeliverableUrl(row.url))) {
      return { ok: false, error: 'This URL is not publicly reachable' };
    }

    let secret: string;
    try {
      secret = decrypt(row.secret);
    } catch {
      return {
        ok: false,
        error: 'Could not decrypt this endpoint’s signing secret',
      };
    }

    const payload = JSON.stringify({
      id: randomUUID(),
      event: 'zapier.test',
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data: {
        message:
          'This is a test event sent from your CRM’s Zapier integration.',
      },
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    // Deliberately NOT queued. "Send test event" is a button whose
    // whole purpose is to show the user the result — a queued test that
    // reports success because it enqueued successfully would tell them
    // nothing about their endpoint.
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Converse360-Event': 'zapier.test',
          'X-Converse360-Webhook-Id': row.id,
          'X-Converse360-Signature': buildSignatureHeader(
            payload,
            secret,
            tsSeconds,
          ),
        },
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: `Endpoint responded ${res.status}`,
        };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Request failed',
      };
    }
  }

  /**
   * Count one consecutive failure against an endpoint, deactivating it
   * once it has failed MAX_CONSECUTIVE_FAILURES times in a row.
   *
   * Called once per *event*, after retries are exhausted — not once per
   * attempt. Otherwise a single flaky delivery with 5 attempts would
   * burn a third of an endpoint's budget and a brief outage would
   * disable a working integration.
   */
  async recordFailure(row: Pick<EndpointRow, 'id'>): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        SELECT public.record_webhook_failure(${row.id}::uuid, ${MAX_CONSECUTIVE_FAILURES}::int);
      `;
    } catch (err) {
      this.logger.error(
        `[webhooks] record_webhook_failure failed for ${row.id}:`,
        err,
      );
    }
  }
}
