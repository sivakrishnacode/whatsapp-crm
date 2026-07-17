/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { FlowsSweepService } from './flows-sweep.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Fresh coverage for the cron-sweep replacement (the old
// /api/flows/cron route had no tests either).

function makePrismaMock() {
  return {
    flowRun: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    flowRunEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

const queueMock = { upsertJobScheduler: vi.fn() } as unknown as Queue;

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

describe('FlowsSweepService.sweepStaleRuns', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: FlowsSweepService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new FlowsSweepService(
      queueMock,
      prisma as unknown as PrismaService,
    );
  });

  it('returns swept: 0 when there are no active runs', async () => {
    const result = await service.sweepStaleRuns();
    expect(result).toEqual({ swept: 0 });
    expect(prisma.flowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'active' } }),
    );
    expect(prisma.flowRun.updateMany).not.toHaveBeenCalled();
  });

  it('times out runs past their per-flow policy cutoff, leaves fresh ones', async () => {
    prisma.flowRun.findMany.mockResolvedValue([
      {
        id: 'run-stale',
        lastAdvancedAt: hoursAgo(25),
        flow: { fallbackPolicy: { on_timeout_hours: 24 } },
      },
      {
        id: 'run-fresh',
        lastAdvancedAt: hoursAgo(2),
        flow: { fallbackPolicy: { on_timeout_hours: 24 } },
      },
    ]);

    const result = await service.sweepStaleRuns();

    expect(result).toEqual({ swept: 1 });
    expect(prisma.flowRun.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.flowRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-stale', status: 'active' },
      data: {
        status: 'timed_out',
        endedAt: expect.any(Date),
        endReason: 'stale_sweep',
      },
    });
    expect(prisma.flowRunEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        flowRunId: 'run-stale',
        eventType: 'timeout',
        payload: expect.objectContaining({ policy_hours: 24 }),
      }),
    });
  });

  it('respects a shorter per-flow on_timeout_hours', async () => {
    prisma.flowRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        lastAdvancedAt: hoursAgo(2),
        flow: { fallbackPolicy: { on_timeout_hours: 1 } },
      },
    ]);
    const result = await service.sweepStaleRuns();
    expect(result).toEqual({ swept: 1 });
  });

  it('falls back to the 24h default when the policy blob is malformed', async () => {
    prisma.flowRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        lastAdvancedAt: hoursAgo(12),
        flow: { fallbackPolicy: 'garbage' },
      },
    ]);
    const result = await service.sweepStaleRuns();
    // 12h old < default 24h cutoff → untouched.
    expect(result).toEqual({ swept: 0 });
    expect(prisma.flowRun.updateMany).not.toHaveBeenCalled();
  });

  it('skips the event insert when the guarded update loses the race', async () => {
    prisma.flowRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        lastAdvancedAt: hoursAgo(48),
        flow: { fallbackPolicy: {} },
      },
    ]);
    // A concurrent advance flipped the run first — updateMany matches 0 rows.
    prisma.flowRun.updateMany.mockResolvedValue({ count: 0 });
    const result = await service.sweepStaleRuns();
    expect(result).toEqual({ swept: 0 });
    expect(prisma.flowRunEvent.create).not.toHaveBeenCalled();
  });
});
