import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { RequestHandler } from 'express';
import { ALL_QUEUE_NAMES } from '../queue.constants';
import {
  checkBasicAuth,
  readDashboardCredentials,
  type DashboardCredentials,
} from './queue-dashboard.auth';

export const QUEUE_DASHBOARD_PATH = '/admin/queues';

/**
 * Bull Board — a live view of every queue: waiting, active, delayed,
 * completed and failed jobs, with their payloads, their errors and a
 * retry button.
 *
 * This exists because the queues are now where the product's work
 * actually happens. "The broadcast says sending but nothing arrived"
 * and "this customer never got their auto-reply" used to be answerable
 * only by reading logs; they are now one page.
 *
 * Three deliberate choices:
 *
 * - **Its own Redis connection and its own `Queue` objects**, built
 *   from `ALL_QUEUE_NAMES` rather than injected from the modules that
 *   own them. A dashboard that had to be wired into every feature
 *   module would silently miss the next queue somebody adds, and these
 *   instances create no workers — they only read.
 * - **Not mounted at all without credentials.** See queue-dashboard.auth.ts.
 * - **Writable, not read-only.** Retrying a failed webhook delivery is
 *   the single most useful thing an operator can do here, and it is
 *   safe: every job in this codebase is idempotent by design (recipient
 *   rows are re-checked, jobIds are stable), which is what makes a
 *   retry button something other than a way to double-send.
 */
@Injectable()
export class QueueDashboardService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueDashboardService.name);
  private readonly credentials: DashboardCredentials | null;
  private connection: Redis | null = null;
  private queues: Queue[] = [];
  private router: RequestHandler | null = null;

  constructor() {
    this.credentials = readDashboardCredentials();
  }

  /** False when QUEUE_DASHBOARD_USER / _PASSWORD are unset. */
  get enabled(): boolean {
    return this.credentials !== null;
  }

  /**
   * Rejects anything without valid credentials before Bull Board's
   * router ever sees the request.
   *
   * ⚠️ Basic auth sends the password base64-encoded, i.e. in the clear.
   * That is acceptable only because every deployment reaches this
   * through the TLS-terminating reverse proxy (the API itself binds to
   * 127.0.0.1 — see docker-compose.yml). Do not expose this port.
   */
  authMiddleware(): RequestHandler {
    return (req, res, next) => {
      if (
        this.credentials &&
        checkBasicAuth(req.headers.authorization, this.credentials)
      ) {
        next();
        return;
      }
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          'Basic realm="Queue dashboard", charset="UTF-8"',
        )
        .send('Authentication required');
    };
  }

  /**
   * Build (once) and return Bull Board's express router.
   *
   * Lazy rather than constructor-built so that an instance with no
   * credentials opens no Redis connection at all.
   */
  getRouter(): RequestHandler | null {
    if (!this.enabled) return null;
    if (this.router) return this.router;

    this.connection = new Redis(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
      { maxRetriesPerRequest: null },
    );
    this.queues = ALL_QUEUE_NAMES.map(
      (name) => new Queue(name, { connection: this.connection! }),
    );

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath(QUEUE_DASHBOARD_PATH);
    createBullBoard({
      queues: this.queues.map((queue) => new BullMQAdapter(queue)),
      serverAdapter,
      options: {
        uiConfig: {
          boardTitle: 'converse360 queues',
        },
      },
    });

    this.router = serverAdapter.getRouter() as RequestHandler;
    this.logger.log(
      `queue dashboard mounted at ${QUEUE_DASHBOARD_PATH} (${this.queues.length} queues)`,
    );
    return this.router;
  }

  async onModuleDestroy(): Promise<void> {
    // The Queue objects share one connection, so closing them all and
    // then the connection is the whole teardown. Without this a
    // shutdown hangs on an open Redis socket.
    await Promise.allSettled(this.queues.map((queue) => queue.close()));
    if (this.connection) await this.connection.quit().catch(() => undefined);
  }
}
