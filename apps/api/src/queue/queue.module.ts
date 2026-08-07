import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import {
  AI_REPLY_QUEUE,
  AUTOMATION_TRIGGER_QUEUE,
  BROADCAST_ORCHESTRATE_QUEUE,
  BROADCAST_SEND_QUEUE,
  ECOMMERCE_SYNC_QUEUE,
  LEAD_FETCH_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
} from './queue.constants';
import { BroadcastQueueService } from './broadcast-queue.service';
import { QueueDashboardService } from './bull-board/queue-dashboard.service';

/**
 * The shared BullMQ connection, plus every queue that more than one
 * module needs to enqueue into.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for its own
 * blocking connection — without it, ioredis's default retry budget
 * conflicts with BullMQ's internal retry/backoff and logs a warning
 * on every worker start.
 *
 * **Where a queue is registered:** a queue used by exactly one module
 * (flows-sweep, ads-sync, the Instagram pair, …) stays registered in
 * that module. The ones below are registered here because their
 * producers and their processor live in different modules — broadcasts
 * are enqueued from both `whatsapp` and `v1`, webhooks from six
 * modules — and two `BullModule.registerQueue` calls for the same name
 * would mean two `Queue` objects, two connections, and one confusing
 * place to look when tuning a limiter.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: new Redis(
          process.env.REDIS_URL ?? 'redis://localhost:6379',
          {
            maxRetriesPerRequest: null,
          },
        ),
      }),
    }),
    BullModule.registerQueue({ name: BROADCAST_ORCHESTRATE_QUEUE }),
    // Rate limiting for this one lives on the *worker*
    // (@Processor(..., { limiter })), not here — in BullMQ v5 the
    // limiter is a worker option, and the queue-side `limiter` key of
    // older Bull is silently ignored. See broadcast-send.processor.ts.
    BullModule.registerQueue({ name: BROADCAST_SEND_QUEUE }),
    BullModule.registerQueue({ name: WEBHOOK_DELIVERY_QUEUE }),
    BullModule.registerQueue({ name: AI_REPLY_QUEUE }),
    BullModule.registerQueue({ name: AUTOMATION_TRIGGER_QUEUE }),
    BullModule.registerQueue({ name: ECOMMERCE_SYNC_QUEUE }),
    BullModule.registerQueue({ name: LEAD_FETCH_QUEUE }),
  ],
  providers: [BroadcastQueueService, QueueDashboardService],
  exports: [BullModule, BroadcastQueueService, QueueDashboardService],
})
export class QueueModule {}
