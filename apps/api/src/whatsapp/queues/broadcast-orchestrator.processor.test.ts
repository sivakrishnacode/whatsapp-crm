/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { BroadcastOrchestratorProcessor } from './broadcast-orchestrator.processor';
import type { BroadcastFinalizeService } from './broadcast-finalize.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrisma() {
  return {
    broadcasts: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'b-1',
        account_id: 'acc-1',
        status: 'queued',
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    whatsapp_config: {
      findFirst: vi.fn().mockResolvedValue({ id: 'cfg-1' }),
    },
    broadcast_recipients: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function makeJob(broadcastId = 'b-1') {
  return { data: { broadcastId } } as Job<{ broadcastId: string }>;
}

describe('BroadcastOrchestratorProcessor', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let finalize: {
    finalizeIfComplete: ReturnType<typeof vi.fn>;
    failEntireBroadcast: ReturnType<typeof vi.fn>;
  };
  let sendQueue: { addBulk: ReturnType<typeof vi.fn> };
  let processor: BroadcastOrchestratorProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    finalize = {
      finalizeIfComplete: vi.fn().mockResolvedValue(false),
      failEntireBroadcast: vi.fn().mockResolvedValue(undefined),
    };
    sendQueue = { addBulk: vi.fn().mockResolvedValue([]) };
    processor = new BroadcastOrchestratorProcessor(
      prisma as unknown as PrismaService,
      finalize as unknown as BroadcastFinalizeService,
      sendQueue as unknown as Queue,
    );
  });

  it('ignores a broadcast that is not queued or sending', async () => {
    prisma.broadcasts.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      account_id: 'acc-1',
      status: 'sent',
    });

    await processor.process(makeJob());

    expect(sendQueue.addBulk).not.toHaveBeenCalled();
    expect(prisma.broadcasts.updateMany).not.toHaveBeenCalled();
  });

  it('fails the whole broadcast once when WhatsApp is disconnected', async () => {
    prisma.whatsapp_config.findFirst.mockResolvedValueOnce(null);

    await processor.process(makeJob());

    expect(finalize.failEntireBroadcast).toHaveBeenCalledWith(
      'b-1',
      'WhatsApp not configured',
    );
    expect(sendQueue.addBulk).not.toHaveBeenCalled();
  });

  it('moves queued → sending, then fans out one job per pending recipient', async () => {
    prisma.broadcast_recipients.findMany.mockResolvedValueOnce([
      { id: 'r-1' },
      { id: 'r-2' },
    ]);

    await processor.process(makeJob());

    expect(prisma.broadcasts.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', status: 'queued' },
      data: expect.objectContaining({ status: 'sending' }),
    });
    expect(sendQueue.addBulk).toHaveBeenCalledTimes(1);

    const jobs = sendQueue.addBulk.mock.calls[0][0] as Array<{
      data: { broadcastId: string; recipientId: string };
      opts: { jobId: string };
    }>;
    expect(jobs.map((j) => j.data.recipientId)).toEqual(['r-1', 'r-2']);
    // jobId = recipient row id is the idempotency guarantee: re-running
    // the orchestrator must not queue a second send for the same person.
    expect(jobs.map((j) => j.opts.jobId)).toEqual(['r-1', 'r-2']);
  });

  it('pages with a keyset cursor rather than an offset', async () => {
    // A full page, then a partial one. OFFSET paging would skip rows
    // here, because recipients stop being 'pending' while the loop runs.
    const page1 = Array.from({ length: 500 }, (_, i) => ({ id: `r-${i}` }));
    prisma.broadcast_recipients.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([{ id: 'r-500' }]);

    await processor.process(makeJob());

    expect(prisma.broadcast_recipients.findMany).toHaveBeenCalledTimes(2);
    const secondCall = prisma.broadcast_recipients.findMany.mock
      .calls[1][0] as { where: { id?: { gt: string } } };
    expect(secondCall.where.id).toEqual({ gt: 'r-499' });
    expect(sendQueue.addBulk).toHaveBeenCalledTimes(2);
  });

  it('finalizes immediately when there is nothing left to send', async () => {
    await processor.process(makeJob());

    expect(sendQueue.addBulk).not.toHaveBeenCalled();
    expect(finalize.finalizeIfComplete).toHaveBeenCalledWith('b-1');
  });
});
