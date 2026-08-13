import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStepExecutorService } from './automation-step-executor.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AutomationConditionService } from './automation-condition.service';
import type { AutomationMetaSendService } from '../../whatsapp/automation-meta-send.service';
import type { ChannelSenderService } from '../../common/messaging/channel-sender.service';
import type { SegmentMembershipService } from '../../common/segments/segment-membership.service';
import type { StepExecutionArgs } from '../automation.types';

/**
 * add_to_segment / remove_from_segment.
 *
 * BOTH ENDS ARE PINNED, AND THAT IS THE POINT OF THIS FILE.
 *
 *   The segment id comes from a config blob an admin saved; the contact
 *   id comes, ultimately, from a Meta webhook payload. `add_tag` next
 *   door leans on the dispatch service's ownership guard alone, which is
 *   defensible for a join table with no account column — but a segment
 *   is a named audience someone will broadcast to, so the step checks
 *   the segment belongs to this workspace (here) and the SQL function
 *   checks the contact belongs to the segment's (in migration 076).
 *   Either check alone leaves a cross-tenant write open.
 *
 * The dynamic-segment refusal is the other invariant: a saved filter has
 * no membership to edit, and failing loudly is what stops an automation
 * that has been quietly doing nothing for a month.
 */

const AUTOMATION = { id: 'auto-1', accountId: 'acc-1', userId: 'u-1' };

function makeArgs(
  overrides: Partial<StepExecutionArgs> = {},
): StepExecutionArgs {
  return {
    automation: AUTOMATION,
    contactId: 'c-1',
    context: {} as StepExecutionArgs['context'],
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: null,
    triggerEvent: 'message_received',
    ...overrides,
  };
}

function makeSegmentsMock() {
  return {
    findForAccount: vi
      .fn()
      .mockResolvedValue({ id: 'seg-1', name: 'VIPs', kind: 'static' }),
    add: vi.fn().mockResolvedValue(1),
    remove: vi.fn().mockResolvedValue(1),
    resolve: vi.fn().mockResolvedValue([]),
    resolveMany: vi.fn().mockResolvedValue([]),
    segmentsForContact: vi.fn().mockResolvedValue([]),
  };
}

function makeService(segments: ReturnType<typeof makeSegmentsMock>) {
  const service = new AutomationStepExecutorService(
    {} as unknown as PrismaService,
    {} as unknown as AutomationConditionService,
    {} as unknown as AutomationMetaSendService,
    {} as unknown as ChannelSenderService,
    segments as unknown as SegmentMembershipService,
    // start_flow only; a segment step never reaches it.
    { startForContact: vi.fn() } as never,
    { add: vi.fn() } as never,
  );
  // runStep is private by design — it is an interpreter step, not an
  // API. Reaching it directly is what lets these assertions be about one
  // step's behaviour instead of a whole automation run.
  //
  // It returns `{ detail, output }` now that steps publish data to later
  // steps; these tests are about the human-readable line, so unwrap it
  // here rather than in every assertion.
  return async (
    step: { stepType: string; stepConfig: unknown },
    args: StepExecutionArgs = makeArgs(),
  ) => {
    const result = await (
      service as unknown as {
        runStep: (
          s: {
            id: string;
            stepType: string;
            stepConfig: unknown;
            position: number;
          },
          a: StepExecutionArgs,
        ) => Promise<{ detail: string; output?: unknown }>;
      }
    ).runStep({ id: 'step-1', position: 0, ...step }, args);
    return result.detail;
  };
}

describe('add_to_segment', () => {
  let segments: ReturnType<typeof makeSegmentsMock>;
  let runStep: ReturnType<typeof makeService>;

  beforeEach(() => {
    segments = makeSegmentsMock();
    runStep = makeService(segments);
  });

  it('pins the segment to the automation’s own account', async () => {
    await runStep({
      stepType: 'add_to_segment',
      stepConfig: { segment_id: 'seg-1' },
    });
    expect(segments.findForAccount).toHaveBeenCalledWith('acc-1', 'seg-1');
  });

  it('refuses a segment that belongs to another workspace', async () => {
    segments.findForAccount.mockResolvedValue(null);
    await expect(
      runStep({
        stepType: 'add_to_segment',
        stepConfig: { segment_id: 'seg-of-acc-2' },
      }),
    ).rejects.toThrow(/not found in this workspace/i);
    expect(segments.add).not.toHaveBeenCalled();
  });

  it('refuses a dynamic segment loudly instead of no-oping', async () => {
    segments.findForAccount.mockResolvedValue({
      id: 'seg-9',
      name: 'Has a phone',
      kind: 'dynamic',
    });
    await expect(
      runStep({
        stepType: 'add_to_segment',
        stepConfig: { segment_id: 'seg-9' },
      }),
    ).rejects.toThrow(/dynamic segment/i);
    expect(segments.add).not.toHaveBeenCalled();
  });

  it('records the automation as the source of the membership row', async () => {
    // 'automation' vs 'manual' is what later answers "why did this
    // person get that broadcast".
    await runStep({
      stepType: 'add_to_segment',
      stepConfig: { segment_id: 'seg-1' },
    });
    expect(segments.add).toHaveBeenCalledWith('seg-1', ['c-1'], 'automation');
  });

  it('reports "already in" separately from "added"', async () => {
    segments.add.mockResolvedValue(0);
    await expect(
      runStep({
        stepType: 'add_to_segment',
        stepConfig: { segment_id: 'seg-1' },
      }),
    ).resolves.toMatch(/already in/i);
  });

  it('requires a contact and a segment id', async () => {
    await expect(
      runStep(
        { stepType: 'add_to_segment', stepConfig: { segment_id: 'seg-1' } },
        makeArgs({ contactId: null }),
      ),
    ).rejects.toThrow(/needs contact/i);

    await expect(
      runStep({ stepType: 'add_to_segment', stepConfig: {} }),
    ).rejects.toThrow(/segment_id/i);
  });
});

describe('remove_from_segment', () => {
  let segments: ReturnType<typeof makeSegmentsMock>;
  let runStep: ReturnType<typeof makeService>;

  beforeEach(() => {
    segments = makeSegmentsMock();
    runStep = makeService(segments);
  });

  it('removes only the triggering contact', async () => {
    await runStep({
      stepType: 'remove_from_segment',
      stepConfig: { segment_id: 'seg-1' },
    });
    expect(segments.remove).toHaveBeenCalledWith('seg-1', ['c-1']);
    expect(segments.add).not.toHaveBeenCalled();
  });

  it('is subject to the same account check as add', async () => {
    segments.findForAccount.mockResolvedValue(null);
    await expect(
      runStep({
        stepType: 'remove_from_segment',
        stepConfig: { segment_id: 'seg-of-acc-2' },
      }),
    ).rejects.toThrow(/not found in this workspace/i);
    expect(segments.remove).not.toHaveBeenCalled();
  });

  it('says so when they were not a member', async () => {
    segments.remove.mockResolvedValue(0);
    await expect(
      runStep({
        stepType: 'remove_from_segment',
        stepConfig: { segment_id: 'seg-1' },
      }),
    ).resolves.toMatch(/was not in/i);
  });
});
