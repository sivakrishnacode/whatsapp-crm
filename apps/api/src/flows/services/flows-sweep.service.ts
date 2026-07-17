import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveFallbackPolicy } from '../flow-fallback.util';

export const FLOWS_SWEEP_QUEUE = 'flows-sweep';

/**
 * Stale-run sweep — replaces apps/web's `GET /api/flows/cron`
 * (external pinger + x-cron-secret) with a BullMQ **repeatable** job.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The sweep is therefore not optional.
 *
 * Unlike automations' `wait` steps (one delayed job per row), this is
 * a periodic scan — the per-run cutoff is policy-driven and editable
 * after the run starts, so a pre-scheduled per-row job would go stale
 * the moment someone edits `on_timeout_hours`.
 *
 * The 5-minute default matches the old cron guidance ("a 5-minute
 * interval is more than enough for a 24h timeout default").
 * `upsertJobScheduler` is idempotent across restarts and updates the
 * interval in place if FLOWS_SWEEP_INTERVAL_MS changes.
 */
@Injectable()
export class FlowsSweepService implements OnModuleInit {
  private readonly logger = new Logger(FlowsSweepService.name);

  constructor(
    @InjectQueue(FLOWS_SWEEP_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const every = Number(process.env.FLOWS_SWEEP_INTERVAL_MS ?? 5 * 60_000);
    await this.queue.upsertJobScheduler(
      'flows-sweep-scheduler',
      { every },
      {
        name: 'sweep',
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
  }

  /**
   * One sweep pass. Ported from apps/web/src/app/api/flows/cron/route.ts.
   * Returns the number of runs timed out (the old route's `{ swept }`).
   */
  async sweepStaleRuns(): Promise<{ swept: number }> {
    const now = new Date();

    // Pull all currently-active runs along with their parent flow's
    // fallback_policy. Joined in one query — the small set of active
    // runs per tenant keeps this cheap.
    const runs = await this.prisma.flowRun.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        lastAdvancedAt: true,
        flow: { select: { fallbackPolicy: true } },
      },
    });
    if (runs.length === 0) return { swept: 0 };

    let swept = 0;
    for (const r of runs) {
      const policy = resolveFallbackPolicy(r.flow?.fallbackPolicy ?? null);
      const ageHours =
        (now.getTime() - r.lastAdvancedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours < policy.on_timeout_hours) continue;

      // Mark timed_out — guarded by the precondition `status='active'`
      // so a concurrent advance from a late inbound doesn't get
      // clobbered by the sweep.
      const updated = await this.prisma.flowRun.updateMany({
        where: { id: r.id, status: 'active' },
        data: {
          status: 'timed_out',
          endedAt: now,
          endReason: 'stale_sweep',
        },
      });

      if (updated.count > 0) {
        await this.prisma.flowRunEvent.create({
          data: {
            flowRunId: r.id,
            eventType: 'timeout',
            payload: {
              age_hours: Math.round(ageHours * 10) / 10,
              policy_hours: policy.on_timeout_hours,
            },
          },
        });
        swept += 1;
      }
    }

    if (swept > 0) {
      this.logger.log(`timed out ${swept} stale flow run(s)`);
    }
    return { swept };
  }
}
