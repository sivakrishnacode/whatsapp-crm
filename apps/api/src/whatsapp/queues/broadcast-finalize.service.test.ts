/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastFinalizeService } from './broadcast-finalize.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrisma() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    broadcast_recipients: { updateMany: vi.fn().mockResolvedValue({}) },
    broadcasts: { updateMany: vi.fn().mockResolvedValue({}) },
  };
}

/** The tagged-template call, flattened back into readable SQL. */
function sqlFrom(call: unknown[]): string {
  const [strings] = call as [TemplateStringsArray];
  return strings.join(' ? ').replace(/\s+/g, ' ');
}

describe('BroadcastFinalizeService.finalizeIfComplete', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BroadcastFinalizeService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new BroadcastFinalizeService(prisma as unknown as PrismaService);
  });

  it('tests for pending recipients and writes the status in ONE statement', async () => {
    await service.finalizeIfComplete('b-1');

    const sql = sqlFrom(prisma.$executeRaw.mock.calls[0]);
    // The whole point: a read-then-write would let one worker declare
    // the broadcast finished while another still has a send in flight.
    expect(sql).toContain('UPDATE public.broadcasts');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("status = 'pending'");
  });

  it('only finalizes a broadcast that is still in flight', async () => {
    await service.finalizeIfComplete('b-1');

    const sql = sqlFrom(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toContain("status IN ('queued', 'sending')");
  });

  it("is 'sent' when anything went out, 'failed' only when nothing did", async () => {
    await service.finalizeIfComplete('b-1');

    const sql = sqlFrom(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toContain(
      "CASE WHEN COALESCE(sent_count, 0) > 0 THEN 'sent' ELSE 'failed' END",
    );
  });

  it('reports whether this call was the one that finished it', async () => {
    prisma.$executeRaw.mockResolvedValueOnce(1);
    await expect(service.finalizeIfComplete('b-1')).resolves.toBe(true);

    // Every other recipient job calls this too; they must be no-ops.
    prisma.$executeRaw.mockResolvedValueOnce(0);
    await expect(service.finalizeIfComplete('b-1')).resolves.toBe(false);
  });

  it('never throws — the send it was called after is already recorded', async () => {
    prisma.$executeRaw.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(service.finalizeIfComplete('b-1')).resolves.toBe(false);
  });
});

describe('BroadcastFinalizeService.failEntireBroadcast', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BroadcastFinalizeService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new BroadcastFinalizeService(prisma as unknown as PrismaService);
  });

  it('puts the reason on every pending recipient, not just the broadcast', async () => {
    await service.failEntireBroadcast('b-1', 'WhatsApp not configured');

    expect(prisma.broadcast_recipients.updateMany).toHaveBeenCalledWith({
      where: { broadcast_id: 'b-1', status: 'pending' },
      data: { status: 'failed', error_message: 'WhatsApp not configured' },
    });
  });

  it('does not resurrect a broadcast that already finished', async () => {
    await service.failEntireBroadcast('b-1', 'nope');

    expect(prisma.broadcasts.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', status: { in: ['queued', 'sending'] } },
      data: expect.objectContaining({ status: 'failed' }),
    });
  });
});
