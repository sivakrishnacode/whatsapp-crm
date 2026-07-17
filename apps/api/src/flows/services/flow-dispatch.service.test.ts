/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { FlowDispatchService } from './flow-dispatch.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { FlowMetaSendService } from '../../whatsapp/flow-meta-send.service';
import type { DispatchInboundInput } from '../flow.types';

// Fresh coverage — the web original's dispatchInboundToFlows /
// startNewRun / handleReplyForActiveRun / advance loop had zero tests
// (only the pure helpers were covered). Mocked-Prisma tier, same
// pattern as automations.service.test.ts.

const NOW = new Date('2024-01-01T00:00:00.000Z');

function makeFlowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flow-1',
    userId: 'user-1',
    accountId: 'acc-1',
    name: 'Welcome',
    description: null,
    status: 'active',
    triggerType: 'keyword',
    triggerConfig: { keywords: ['support'] },
    entryNodeId: 'start',
    fallbackPolicy: {
      on_unknown_reply: 'reprompt',
      max_reprompts: 2,
      on_timeout_hours: 24,
      on_exhaust: 'handoff',
    },
    executionCount: 0,
    lastExecutedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    flowId: 'flow-1',
    userId: 'user-1',
    accountId: 'acc-1',
    contactId: 'contact-1',
    conversationId: 'conv-1',
    status: 'active',
    currentNodeKey: 'menu',
    lastPromptMessageId: null,
    vars: {},
    repromptCount: 0,
    startedAt: NOW,
    lastAdvancedAt: NOW,
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

function makeNode(
  nodeKey: string,
  nodeType: string,
  config: Record<string, unknown>,
) {
  return {
    id: `node-${nodeKey}`,
    flowId: 'flow-1',
    nodeKey,
    nodeType,
    config,
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
  };
}

function makePrismaMock() {
  return {
    flow: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    flowNode: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    flowRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    flowRunEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    contacts: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    contact_tags: {
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    conversations: {
      update: vi.fn().mockResolvedValue({}),
    },
    messages: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
}

function makeMetaSendMock() {
  return {
    sendText: vi.fn().mockResolvedValue({ whatsapp_message_id: 'wamid.text' }),
    sendMedia: vi
      .fn()
      .mockResolvedValue({ whatsapp_message_id: 'wamid.media' }),
    sendInteractiveButtons: vi
      .fn()
      .mockResolvedValue({ whatsapp_message_id: 'wamid.buttons' }),
    sendInteractiveList: vi
      .fn()
      .mockResolvedValue({ whatsapp_message_id: 'wamid.list' }),
  };
}

function makeInput(
  overrides: Partial<DispatchInboundInput> = {},
): DispatchInboundInput {
  return {
    accountId: 'acc-1',
    userId: 'user-1',
    contactId: 'contact-1',
    conversationId: 'conv-1',
    message: { kind: 'text', text: 'support', meta_message_id: 'wamid.in-1' },
    isFirstInboundMessage: false,
    ...overrides,
  };
}

describe('FlowDispatchService.dispatchInbound', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let metaSend: ReturnType<typeof makeMetaSendMock>;
  let service: FlowDispatchService;

  beforeEach(() => {
    prisma = makePrismaMock();
    metaSend = makeMetaSendMock();
    service = new FlowDispatchService(
      prisma as unknown as PrismaService,
      metaSend as unknown as FlowMetaSendService,
    );
  });

  it('returns no_match when there is no active run and no trigger matches', async () => {
    prisma.flow.findMany.mockResolvedValue([
      makeFlowRow({ triggerConfig: { keywords: ['pricing'] } }),
    ]);
    const result = await service.dispatchInbound(makeInput());
    expect(result).toEqual({ consumed: false, outcome: 'no_match' });
    // Tenant scoping on the active-run lookup.
    expect(prisma.flowRun.findFirst).toHaveBeenCalledWith({
      where: { accountId: 'acc-1', contactId: 'contact-1', status: 'active' },
      orderBy: { startedAt: 'desc' },
    });
  });

  it('interactive replies never start a new run', async () => {
    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'interactive_reply',
          reply_id: 'x',
          reply_title: 'X',
          meta_message_id: 'wamid.in-1',
        },
      }),
    );
    expect(result).toEqual({ consumed: false, outcome: 'no_match' });
    // No entry-flow scan needed — the runner short-circuits on kind.
    expect(prisma.flow.findMany).not.toHaveBeenCalled();
  });

  it('starts a new run on keyword match, walks auto-advance nodes, suspends at send_buttons', async () => {
    prisma.flow.findMany.mockResolvedValue([makeFlowRow()]);
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('start', 'start', { next_node_key: 'greet' }),
      makeNode('greet', 'send_message', {
        text: 'Hello!',
        next_node_key: 'menu',
      }),
      makeNode('menu', 'send_buttons', {
        text: 'Pick one',
        buttons: [{ reply_id: 'a', title: 'A', next_node_key: 'ho' }],
      }),
      makeNode('ho', 'handoff', {}),
    ]);
    prisma.flowRun.create.mockResolvedValue(
      makeRunRow({ currentNodeKey: 'start' }),
    );

    const result = await service.dispatchInbound(makeInput());

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'started',
    });
    expect(metaSend.sendText).toHaveBeenCalledWith({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Hello!',
    });
    expect(metaSend.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    // Execution counter incremented atomically.
    expect(prisma.flow.update).toHaveBeenCalledWith({
      where: { id: 'flow-1' },
      data: {
        executionCount: { increment: 1 },
        lastExecutedAt: expect.any(Date),
      },
    });
    // Optimistic advance: from the entry key to the suspending node.
    expect(prisma.flowRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'active', currentNodeKey: 'start' },
      data: { currentNodeKey: 'menu', lastAdvancedAt: expect.any(Date) },
    });
  });

  it('treats a P2002 on run insert as a concurrent duplicate start', async () => {
    prisma.flow.findMany.mockResolvedValue([makeFlowRow()]);
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('start', 'start', { next_node_key: 'ho' }),
      makeNode('ho', 'handoff', {}),
    ]);
    prisma.flowRun.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate key', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const result = await service.dispatchInbound(makeInput());
    expect(result).toEqual({
      consumed: true,
      outcome: 'duplicate_inbound_ignored',
    });
  });

  it('ignores a duplicate inbound (Meta retry) for an active run', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(makeRunRow());
    prisma.flowRunEvent.findFirst.mockResolvedValue({ id: 'evt-1' });

    const result = await service.dispatchInbound(makeInput());

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'duplicate_inbound_ignored',
    });
    expect(prisma.flowRunEvent.findFirst).toHaveBeenCalledWith({
      where: {
        eventType: 'reply_received',
        payload: { path: ['meta_message_id'], equals: 'wamid.in-1' },
        flowRun: { accountId: 'acc-1', contactId: 'contact-1' },
      },
      select: { id: true },
    });
  });

  it('advances an active run on a matching button tap into a handoff', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(makeRunRow());
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('menu', 'send_buttons', {
        text: 'Pick one',
        buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: 'ho' }],
      }),
      makeNode('ho', 'handoff', { note: 'escalate' }),
    ]);

    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'interactive_reply',
          reply_id: 'yes',
          reply_title: 'Yes',
          meta_message_id: 'wamid.in-2',
        },
      }),
    );

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'handed_off',
    });
    // Conversation flipped to pending by the handoff executor.
    expect(prisma.conversations.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { status: 'pending', updated_at: expect.any(Date) },
    });
    // Run ended as handed_off.
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'handed_off',
        endedAt: expect.any(Date),
        endReason: 'handoff_node',
      },
    });
  });

  it('captures a collect_input text reply into vars and advances to end', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(
      makeRunRow({ currentNodeKey: 'ask' }),
    );
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('ask', 'collect_input', {
        prompt_text: "What's your name?",
        var_key: 'name',
        next_node_key: 'bye',
      }),
      makeNode('bye', 'end', {}),
    ]);

    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'text',
          text: '  Alice  ',
          meta_message_id: 'wamid.in-3',
        },
      }),
    );

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'completed',
    });
    // Trimmed capture persisted with the reprompt counter reset.
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { vars: { name: 'Alice' }, repromptCount: 0 },
    });
    // Run ended via the end node.
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'completed',
        endedAt: expect.any(Date),
        endReason: 'end_node',
      },
    });
  });

  it('reprompts on an unknown reply within the policy budget', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(makeRunRow());
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('menu', 'send_buttons', {
        text: 'Pick one',
        buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: 'ho' }],
      }),
      makeNode('ho', 'handoff', {}),
    ]);
    prisma.flow.findUnique.mockResolvedValue(makeFlowRow());

    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'text',
          text: 'what??',
          meta_message_id: 'wamid.in-4',
        },
      }),
    );

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'fallback_fired',
    });
    // Counter bumped, prompt re-sent.
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { repromptCount: 1 },
    });
    expect(metaSend.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  it('escalates to handoff once reprompts are exhausted', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(
      makeRunRow({ repromptCount: 2 }),
    );
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('menu', 'send_buttons', {
        text: 'Pick one',
        buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: 'ho' }],
      }),
      makeNode('ho', 'handoff', {}),
    ]);
    prisma.flow.findUnique.mockResolvedValue(makeFlowRow());

    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'text',
          text: 'still lost',
          meta_message_id: 'wamid.in-5',
        },
      }),
    );

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'handed_off',
    });
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'handed_off',
        endedAt: expect.any(Date),
        endReason: 'fallback_exhausted',
      },
    });
    // No re-prompt sent on the exhaust path.
    expect(metaSend.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("does not consume when the policy says 'ignore' — automations get their shot", async () => {
    prisma.flowRun.findFirst.mockResolvedValue(makeRunRow());
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('menu', 'send_buttons', {
        text: 'Pick one',
        buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: 'ho' }],
      }),
      makeNode('ho', 'handoff', {}),
    ]);
    prisma.flow.findUnique.mockResolvedValue(
      makeFlowRow({
        fallbackPolicy: {
          on_unknown_reply: 'ignore',
          max_reprompts: 2,
          on_timeout_hours: 24,
          on_exhaust: 'handoff',
        },
      }),
    );

    const result = await service.dispatchInbound(
      makeInput({
        message: {
          kind: 'text',
          text: 'off-script',
          meta_message_id: 'wamid.in-6',
        },
      }),
    );

    expect(result).toEqual({
      consumed: false,
      flow_run_id: 'run-1',
      outcome: 'no_match',
    });
  });

  it('fails the run when a Meta send blows up mid-advance', async () => {
    prisma.flow.findMany.mockResolvedValue([makeFlowRow()]);
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('start', 'start', { next_node_key: 'greet' }),
      makeNode('greet', 'send_message', {
        text: 'Hello!',
        next_node_key: 'bye',
      }),
      makeNode('bye', 'end', {}),
    ]);
    prisma.flowRun.create.mockResolvedValue(
      makeRunRow({ currentNodeKey: 'start' }),
    );
    metaSend.sendText.mockRejectedValue(new Error('Meta API error: 400'));

    const result = await service.dispatchInbound(makeInput());

    expect(result).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'completed',
    });
    expect(prisma.flowRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'failed',
        endedAt: expect.any(Date),
        endReason: 'send_text_failed',
      },
    });
  });

  it('interpolates captured vars into subsequent prompts', async () => {
    prisma.flowRun.findFirst.mockResolvedValue(
      makeRunRow({ currentNodeKey: 'ask_name' }),
    );
    prisma.flowNode.findMany.mockResolvedValue([
      makeNode('ask_name', 'collect_input', {
        prompt_text: "What's your name?",
        var_key: 'name',
        next_node_key: 'ask_email',
      }),
      makeNode('ask_email', 'collect_input', {
        prompt_text: "Thanks {{vars.name}}! What's your email?",
        var_key: 'email',
        next_node_key: 'bye',
      }),
      makeNode('bye', 'end', {}),
    ]);

    await service.dispatchInbound(
      makeInput({
        message: { kind: 'text', text: 'Alice', meta_message_id: 'wamid.7' },
      }),
    );

    expect(metaSend.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Thanks Alice! What's your email?" }),
    );
  });
});
