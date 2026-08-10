import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanTakeoverService } from './human-takeover.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Pausing the AI bot when a human replies.
 *
 * The behaviour these tests protect is small; the trap they protect
 * against is not. An AI reply comes back from Meta as an echo, and the
 * echo path is one of the two things that calls this service — so if the
 * bot's own echo ever reached it, the bot would switch itself off
 * immediately after its first reply on every thread. The only thing
 * standing between those two facts is the mid dedupe at the top of
 * InstagramWebhookService.handleMessage, which is covered in that
 * service's own tests.
 */
interface UpdateManyArgs {
  where: { id: string; ai_autoreply_disabled: boolean };
  data: { ai_autoreply_disabled: boolean };
}

function makePrismaMock() {
  return {
    conversations: {
      updateMany: vi.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>(),
    },
  };
}

describe('HumanTakeoverService.noteHumanMessage', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: HumanTakeoverService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prisma.conversations.updateMany.mockResolvedValue({ count: 1 });
    service = new HumanTakeoverService(prisma as unknown as PrismaService);
  });

  it('pauses auto-reply on the conversation', async () => {
    await service.noteHumanMessage('conv-1', 'dashboard');
    expect(prisma.conversations.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1', ai_autoreply_disabled: false },
      data: { ai_autoreply_disabled: true },
    });
  });

  it('only matches a thread that is not already paused', async () => {
    // The `false` in the filter is what makes the second, third and
    // fortieth message from the same agent match zero rows instead of
    // issuing a pointless write — and, more visibly, a pointless
    // realtime event on a busy thread.
    await service.noteHumanMessage('conv-1', 'dashboard');
    expect(
      prisma.conversations.updateMany.mock.calls[0][0].where,
    ).toMatchObject({ ai_autoreply_disabled: false });
  });

  it('never re-enables the bot — this is a pause, not a toggle', async () => {
    // Resuming is a deliberate act by a person in the thread header.
    // If this service could set the flag back to false, an agent's next
    // message would silently undo their own decision to keep the bot off.
    await service.noteHumanMessage('conv-1', 'echo');
    expect(prisma.conversations.updateMany.mock.calls[0][0].data).toEqual({
      ai_autoreply_disabled: true,
    });
  });

  it('ignores an empty conversation id without querying', async () => {
    await service.noteHumanMessage('', 'dashboard');
    expect(prisma.conversations.updateMany).not.toHaveBeenCalled();
  });

  it('swallows a database failure', async () => {
    // This runs alongside sending a message. Failing to flip a flag must
    // never become a failure to deliver what the agent just typed — the
    // worst case is the bot replying once more, which is exactly what
    // happened before this existed.
    prisma.conversations.updateMany.mockRejectedValue(new Error('down'));
    await expect(
      service.noteHumanMessage('conv-1', 'dashboard'),
    ).resolves.toBeUndefined();
  });
});
