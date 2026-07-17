import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Registers the shared BullMQ connection only — no queues yet.
 * Feature modules (automations, flows, broadcasts, AI embeddings —
 * Phase 1+) import this module and call `BullModule.registerQueue(...)`
 * themselves to add their own queues/processors.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for its own
 * blocking connection — without it, ioredis's default retry budget
 * conflicts with BullMQ's internal retry/backoff and logs a warning
 * on every worker start.
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
  ],
  exports: [BullModule],
})
export class QueueModule {}
