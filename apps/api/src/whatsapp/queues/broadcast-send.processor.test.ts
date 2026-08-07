import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { BroadcastSendProcessor } from './broadcast-send.processor';
import {
  BroadcastUnsendableError,
  type BroadcastRecipientSendService,
} from './broadcast-recipient-send.service';
import type { BroadcastFinalizeService } from './broadcast-finalize.service';
import type { BroadcastSendJobData } from './broadcast-orchestrator.processor';

function makeJob(
  overrides: Partial<Job<BroadcastSendJobData>> = {},
): Job<BroadcastSendJobData> {
  return {
    data: { broadcastId: 'b-1', recipientId: 'r-1' },
    opts: { attempts: 4 },
    attemptsMade: 0,
    ...overrides,
  } as Job<BroadcastSendJobData>;
}

describe('BroadcastSendProcessor', () => {
  let sender: {
    sendOne: ReturnType<typeof vi.fn>;
    markRecipient: ReturnType<typeof vi.fn>;
  };
  let finalize: {
    finalizeIfComplete: ReturnType<typeof vi.fn>;
    failEntireBroadcast: ReturnType<typeof vi.fn>;
  };
  let processor: BroadcastSendProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = {
      sendOne: vi.fn().mockResolvedValue({ status: 'sent', messageId: 'w-1' }),
      markRecipient: vi.fn().mockResolvedValue(undefined),
    };
    finalize = {
      finalizeIfComplete: vi.fn().mockResolvedValue(false),
      failEntireBroadcast: vi.fn().mockResolvedValue(undefined),
    };
    processor = new BroadcastSendProcessor(
      sender as unknown as BroadcastRecipientSendService,
      finalize as unknown as BroadcastFinalizeService,
    );
  });

  it('records the outcome and asks whether the broadcast is finished', async () => {
    await processor.process(makeJob());

    expect(sender.markRecipient).toHaveBeenCalledWith('r-1', {
      status: 'sent',
      messageId: 'w-1',
    });
    expect(finalize.finalizeIfComplete).toHaveBeenCalledWith('b-1');
  });

  it('ends the entire broadcast when the account cannot send', async () => {
    sender.sendOne.mockRejectedValueOnce(
      new BroadcastUnsendableError('WhatsApp not configured'),
    );

    // Resolves, rather than throwing: retrying the remaining recipients
    // through their own backoff would take hours to reach the same
    // answer.
    await expect(processor.process(makeJob())).resolves.toBeUndefined();

    expect(finalize.failEntireBroadcast).toHaveBeenCalledWith(
      'b-1',
      'WhatsApp not configured',
    );
    expect(finalize.finalizeIfComplete).not.toHaveBeenCalled();
  });

  it('propagates a transient error so BullMQ owns the retry', async () => {
    sender.sendOne.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(processor.process(makeJob())).rejects.toThrow('ECONNRESET');
    expect(sender.markRecipient).not.toHaveBeenCalled();
  });

  it('leaves the row alone while retries remain', async () => {
    await processor.onFailed(
      makeJob({ attemptsMade: 2 } as Partial<Job<BroadcastSendJobData>>),
      new Error('still failing'),
    );
    expect(sender.markRecipient).not.toHaveBeenCalled();
  });

  it('marks the recipient failed once retries are exhausted, then finalizes', async () => {
    // Without this the row would stay 'pending' forever and the
    // broadcast would never reach a terminal status — one recipient
    // short of complete.
    await processor.onFailed(
      makeJob({ attemptsMade: 4 } as Partial<Job<BroadcastSendJobData>>),
      new Error('gateway timeout'),
    );

    expect(sender.markRecipient).toHaveBeenCalledWith('r-1', {
      status: 'failed',
      error: 'gateway timeout',
    });
    expect(finalize.finalizeIfComplete).toHaveBeenCalledWith('b-1');
  });
});
