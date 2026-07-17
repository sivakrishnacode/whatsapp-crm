import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../whatsapp/encryption.util';
import { isDeliverableUrl } from '../../common/security/ssrf.util';
import { buildSignatureHeader } from '../utils/webhook-sign.util';
import { randomUUID } from 'node:crypto';

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

@Injectable()
export class WebhookDeliverService {
  private readonly logger = new Logger(WebhookDeliverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deliver `event` (+ `data`) to every active endpoint of `accountId`
   * subscribed to it. Never throws.
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
        select: {
          id: true,
          url: true,
          secret: true,
        },
      });

      if (rows.length === 0) return;

      const payload = JSON.stringify({
        id: randomUUID(),
        event,
        occurred_at: new Date().toISOString(),
        account_id: accountId,
        data,
      });
      const tsSeconds = Math.floor(Date.now() / 1000);

      await Promise.allSettled(
        rows.map((row) =>
          this.deliverOne(row, event, payload, tsSeconds),
        ),
      );
    } catch (err) {
      this.logger.error(`[webhooks] dispatch failed:`, err);
    }
  }

  private async deliverOne(
    row: EndpointRow,
    event: string,
    payload: string,
    tsSeconds: number,
  ): Promise<void> {
    if (!(await isDeliverableUrl(row.url))) {
      this.logger.warn(`[webhooks] refusing non-public delivery target for ${row.id}`);
      await this.recordFailure(row);
      return;
    }

    let secret: string;
    try {
      secret = decrypt(row.secret);
    } catch (err) {
      this.logger.error(`[webhooks] secret decrypt failed for ${row.id}:`, err);
      await this.recordFailure(row);
      return;
    }

    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Conceps-Event': event,
          'X-Conceps-Webhook-Id': row.id,
          'X-Conceps-Signature': buildSignatureHeader(payload, secret, tsSeconds),
        },
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`endpoint responded ${res.status}`);
      }

      await this.prisma.webhook_endpoints.update({
        where: { id: row.id },
        data: {
          failure_count: 0,
          last_delivery_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[webhooks] delivery to ${row.id} failed: ${err?.message || err}`,
      );
      await this.recordFailure(row);
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
      return { ok: false, error: 'Could not decrypt this endpoint’s signing secret' };
    }

    const payload = JSON.stringify({
      id: randomUUID(),
      event: 'zapier.test',
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data: { message: 'This is a test event sent from your CRM’s Zapier integration.' },
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Conceps-Event': 'zapier.test',
          'X-Conceps-Webhook-Id': row.id,
          'X-Conceps-Signature': buildSignatureHeader(payload, secret, tsSeconds),
        },
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        return { ok: false, status: res.status, error: `Endpoint responded ${res.status}` };
      }
      return { ok: true, status: res.status };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || 'Request failed',
      };
    }
  }

  private async recordFailure(row: EndpointRow): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        SELECT public.record_webhook_failure(${row.id}::uuid, ${MAX_CONSECUTIVE_FAILURES}::int);
      `;
    } catch (err) {
      this.logger.error(`[webhooks] record_webhook_failure failed for ${row.id}:`, err);
    }
  }
}
