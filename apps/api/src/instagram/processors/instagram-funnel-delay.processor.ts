import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import {
  CommentFunnelService,
  IG_FUNNEL_QUEUE,
  type FunnelOptinJob,
} from '../services/comment-funnel.service';

/**
 * Sends the opening DM for funnels configured with a `reply_delay_seconds`.
 *
 * concurrency 5: each job is one private reply plus one public comment
 * reply against Meta's API, and a viral post can park hundreds of them
 * for the same second. Five at a time keeps a burst from becoming a
 * rate-limit spike on the business's own token — and the delay means
 * nobody is watching the clock on any individual send.
 *
 * Throws on failure so BullMQ retries. `runDelayedOptin` has already
 * absorbed the failures that are NOT worth retrying (funnel paused, one
 * private reply already spent, connection gone) by parking them on the
 * run row, so anything reaching here is genuinely transient.
 */
@Processor(IG_FUNNEL_QUEUE, { concurrency: 5 })
export class InstagramFunnelDelayProcessor extends WorkerHost {
  private readonly logger = new Logger(InstagramFunnelDelayProcessor.name);

  constructor(private readonly funnels: CommentFunnelService) {
    super();
  }

  async process(job: Job<FunnelOptinJob>): Promise<void> {
    try {
      await this.funnels.runDelayedOptin(job.data);
    } catch (err) {
      this.logger.error(
        `Delayed funnel DM failed for run ${job.data?.runId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
