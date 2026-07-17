/* eslint-disable @typescript-eslint/no-unsafe-assignment --
   vitest's asymmetric matchers (expect.any / expect.objectContaining)
   are typed `any`; property-position usage trips the rule spuriously. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FlowsService } from './flows.service';
import type { PrismaService } from '../prisma/prisma.service';

// Fresh coverage — the original 8 route files had no tests. Mocked-
// Prisma tier, same pattern as automations.service.test.ts. Focus:
// ownership/tenant scoping, the exact `{ error }` payload contract,
// the activate 422 + issues shape, and the create/import rollbacks.

const NOW = new Date('2024-01-01T00:00:00.000Z');

function makeFlowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flow-1',
    userId: 'user-1',
    accountId: 'acc-1',
    name: 'Welcome',
    description: null,
    status: 'draft',
    triggerType: 'keyword',
    triggerConfig: { keywords: ['support'] },
    entryNodeId: 'start',
    fallbackPolicy: {},
    executionCount: 0,
    lastExecutedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeNodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node-1',
    flowId: 'flow-1',
    nodeKey: 'start',
    nodeType: 'start',
    config: { next_node_key: 'ho' },
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    flow: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    flowNode: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    flowRun: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    flowRunEvent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('FlowsService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: FlowsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new FlowsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('scopes by accountId and reshapes to snake_case', async () => {
      prisma.flow.findMany.mockResolvedValue([makeFlowRow()]);
      const result = await service.list('acc-1');
      expect(prisma.flow.findMany).toHaveBeenCalledWith({
        where: { accountId: 'acc-1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result[0]).toMatchObject({
        id: 'flow-1',
        account_id: 'acc-1',
        user_id: 'user-1',
        trigger_type: 'keyword',
        entry_node_id: 'start',
        execution_count: 0,
        created_at: NOW.toISOString(),
      });
    });
  });

  describe('create', () => {
    it("rejects a plain create without a name using the original's message", async () => {
      await expect(service.create('user-1', 'acc-1', {})).rejects.toMatchObject(
        new BadRequestException({ error: 'name is required' }),
      );
    });

    it('rejects an unknown template_slug', async () => {
      await expect(
        service.create('user-1', 'acc-1', { template_slug: 'nope' }),
      ).rejects.toMatchObject(
        new BadRequestException({ error: 'Unknown template_slug "nope"' }),
      );
    });

    it('creates a draft with defaulted trigger_type', async () => {
      prisma.flow.create.mockResolvedValue(makeFlowRow());
      await service.create('user-1', 'acc-1', { name: '  My flow  ' });
      expect(prisma.flow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          accountId: 'acc-1',
          name: 'My flow',
          status: 'draft',
          triggerType: 'keyword',
        }),
      });
    });

    it('clones a template with its nodes; body name overrides', async () => {
      prisma.flow.create.mockResolvedValue(makeFlowRow({ id: 'flow-t' }));
      await service.create('user-1', 'acc-1', {
        template_slug: 'welcome_menu',
        name: 'Custom name',
      });
      expect(prisma.flow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Custom name',
          status: 'draft',
          triggerType: 'keyword',
          entryNodeId: 'start',
        }),
      });
      expect(prisma.flowNode.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ flowId: 'flow-t', nodeKey: 'start' }),
          expect.objectContaining({ nodeKey: 'welcome' }),
        ]),
      });
    });

    it('rolls the flow row back when template node insert fails', async () => {
      prisma.flow.create.mockResolvedValue(makeFlowRow({ id: 'flow-t' }));
      prisma.flowNode.createMany.mockRejectedValue(new Error('insert failed'));
      await expect(
        service.create('user-1', 'acc-1', { template_slug: 'faq_bot' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.flow.delete).toHaveBeenCalledWith({
        where: { id: 'flow-t' },
      });
    });
  });

  describe('getOne', () => {
    it("404s with { error: 'Not found' } for a flow outside the account", async () => {
      prisma.flow.findFirst.mockResolvedValue(null);
      await expect(service.getOne('flow-x', 'acc-1')).rejects.toMatchObject(
        new NotFoundException({ error: 'Not found' }),
      );
      expect(prisma.flow.findFirst).toHaveBeenCalledWith({
        where: { id: 'flow-x', accountId: 'acc-1' },
      });
    });

    it('returns the flow with its nodes ordered by creation', async () => {
      prisma.flow.findFirst.mockResolvedValue(makeFlowRow());
      prisma.flowNode.findMany.mockResolvedValue([makeNodeRow()]);
      const result = await service.getOne('flow-1', 'acc-1');
      expect(prisma.flowNode.findMany).toHaveBeenCalledWith({
        where: { flowId: 'flow-1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result.nodes[0]).toMatchObject({
        node_key: 'start',
        node_type: 'start',
        position_x: 0,
      });
    });
  });

  describe('update', () => {
    it('rejects an empty name', async () => {
      await expect(
        service.update('flow-1', 'acc-1', { name: '   ' }),
      ).rejects.toMatchObject(
        new BadRequestException({ error: 'name cannot be empty' }),
      );
    });

    it('replaces the node graph only when nodes are present in the body', async () => {
      prisma.flow.findFirst.mockResolvedValue(makeFlowRow());
      prisma.flow.update.mockResolvedValue(makeFlowRow());
      prisma.flow.findUnique.mockResolvedValue(makeFlowRow());

      await service.update('flow-1', 'acc-1', { name: 'Renamed' });
      expect(prisma.flowNode.deleteMany).not.toHaveBeenCalled();

      await service.update('flow-1', 'acc-1', {
        nodes: [
          {
            node_key: 'a',
            node_type: 'start',
            config: { next_node_key: 'b' },
            position_x: 10,
          },
        ],
      });
      expect(prisma.flowNode.deleteMany).toHaveBeenCalledWith({
        where: { flowId: 'flow-1' },
      });
      expect(prisma.flowNode.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            flowId: 'flow-1',
            nodeKey: 'a',
            positionX: 10,
            positionY: 0,
          }),
        ],
      });
    });
  });

  describe('setStatus (activate route)', () => {
    it("rejects invalid statuses with the original's message", async () => {
      await expect(
        service.setStatus('flow-1', 'acc-1', 'paused'),
      ).rejects.toMatchObject(
        new BadRequestException({
          error: "status must be one of 'draft' | 'active' | 'archived'",
        }),
      );
    });

    it('422s with the full issue list when activating a broken flow', async () => {
      prisma.flow.findFirst.mockResolvedValue(
        makeFlowRow({ entryNodeId: 'ghost' }),
      );
      prisma.flowNode.findMany.mockResolvedValue([
        makeNodeRow({
          nodeKey: 'start',
          nodeType: 'start',
          config: { next_node_key: 'missing' },
        }),
      ]);
      let caught: unknown;
      try {
        await service.setStatus('flow-1', 'acc-1', 'active');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnprocessableEntityException);
      const body = (caught as UnprocessableEntityException).getResponse() as {
        error: string;
        issues: unknown[];
      };
      expect(body.error).toBe(
        'Cannot activate flow — fix the issues below first.',
      );
      expect(body.issues.length).toBeGreaterThan(0);
    });

    it('archives unconditionally — no validation', async () => {
      prisma.flow.findFirst.mockResolvedValue(makeFlowRow());
      prisma.flow.update.mockResolvedValue(makeFlowRow({ status: 'archived' }));
      const result = await service.setStatus('flow-1', 'acc-1', 'archived');
      expect(prisma.flowNode.findMany).not.toHaveBeenCalled();
      expect(result?.status).toBe('archived');
    });
  });

  describe('export', () => {
    it('strips tenant/UUID fields and always exports as draft', async () => {
      prisma.flow.findFirst.mockResolvedValue(
        makeFlowRow({ status: 'active', name: 'My Flow!' }),
      );
      prisma.flowNode.findMany.mockResolvedValue([makeNodeRow()]);
      const { payload, filename } = await service.export('flow-1', 'acc-1');
      expect(payload).toMatchObject({
        schema_version: 1,
        flow: expect.objectContaining({ name: 'My Flow!', status: 'draft' }),
      });
      const flowBlock = payload.flow as Record<string, unknown>;
      expect(flowBlock).not.toHaveProperty('id');
      expect(flowBlock).not.toHaveProperty('account_id');
      expect(flowBlock).not.toHaveProperty('user_id');
      const nodes = payload.nodes as Array<Record<string, unknown>>;
      expect(nodes[0]).not.toHaveProperty('id');
      expect(nodes[0]).not.toHaveProperty('flow_id');
      expect(filename).toMatch(/^flow_my_flow__\d+\.json$/);
    });
  });

  describe('import', () => {
    const validPayload = {
      schema_version: 1,
      flow: {
        name: 'Imported',
        trigger_type: 'keyword' as const,
        trigger_config: { keywords: ['hi'] },
        entry_node_id: 'start',
      },
      nodes: [
        {
          node_key: 'start',
          node_type: 'start',
          config: { next_node_key: 'ho' },
        },
        { node_key: 'ho', node_type: 'handoff', config: {} },
      ],
    };

    it('rejects unsupported schema versions', async () => {
      await expect(
        service.import('user-1', 'acc-1', {
          ...validPayload,
          schema_version: 2,
        }),
      ).rejects.toMatchObject(
        new BadRequestException({
          error: 'Unsupported schema_version "2". Supported: 1.',
        }),
      );
    });

    it('rejects an invalid trigger_type', async () => {
      await expect(
        service.import('user-1', 'acc-1', {
          ...validPayload,
          flow: {
            ...validPayload.flow,
            trigger_type: 'wibble' as never,
          },
        }),
      ).rejects.toMatchObject(
        new BadRequestException({ error: 'Invalid trigger_type "wibble".' }),
      );
    });

    it('rejects nodes missing a node_key', async () => {
      await expect(
        service.import('user-1', 'acc-1', {
          ...validPayload,
          nodes: [{ node_key: ' ', node_type: 'start', config: {} }],
        }),
      ).rejects.toMatchObject(
        new BadRequestException({
          error: 'Each node must have a non-empty "node_key".',
        }),
      );
    });

    it('always inserts as draft and rolls back on node failure', async () => {
      prisma.flow.create.mockResolvedValue(makeFlowRow({ id: 'flow-i' }));
      prisma.flowNode.createMany.mockRejectedValue(new Error('bad node'));
      await expect(
        service.import('user-1', 'acc-1', validPayload),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.flow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'draft', name: 'Imported' }),
      });
      expect(prisma.flow.delete).toHaveBeenCalledWith({
        where: { id: 'flow-i' },
      });
    });
  });

  describe('listRuns', () => {
    it('caps at 50 newest runs and embeds contact + events', async () => {
      prisma.flow.findFirst.mockResolvedValue(makeFlowRow());
      prisma.flowRun.findMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          currentNodeKey: null,
          startedAt: NOW,
          lastAdvancedAt: NOW,
          endedAt: NOW,
          endReason: 'end_node',
          vars: { name: 'Alice' },
          repromptCount: 0,
          contact: { id: 'c-1', name: 'Alice', phone: '+123' },
        },
      ]);
      prisma.flowRunEvent.findMany.mockResolvedValue([
        {
          flowRunId: 'run-1',
          eventType: 'started',
          nodeKey: 'start',
          payload: {},
          createdAt: NOW,
        },
      ]);

      const result = await service.listRuns('flow-1', 'acc-1');

      expect(prisma.flowRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { flowId: 'flow-1' },
          orderBy: { startedAt: 'desc' },
          take: 50,
        }),
      );
      expect(result.flow).toEqual({ id: 'flow-1', name: 'Welcome' });
      expect(result.runs[0]).toMatchObject({
        id: 'run-1',
        status: 'completed',
        vars: { name: 'Alice' },
        contact: { id: 'c-1', name: 'Alice', phone: '+123' },
      });
      expect(result.events[0]).toMatchObject({
        flow_run_id: 'run-1',
        event_type: 'started',
      });
    });

    it('degrades to an empty timeline when the events fetch fails', async () => {
      prisma.flow.findFirst.mockResolvedValue(makeFlowRow());
      prisma.flowRun.findMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'active',
          currentNodeKey: 'menu',
          startedAt: NOW,
          lastAdvancedAt: NOW,
          endedAt: null,
          endReason: null,
          vars: {},
          repromptCount: 0,
          contact: null,
        },
      ]);
      prisma.flowRunEvent.findMany.mockRejectedValue(new Error('boom'));
      const result = await service.listRuns('flow-1', 'acc-1');
      expect(result.runs).toHaveLength(1);
      expect(result.events).toEqual([]);
    });
  });

  describe('listTemplates', () => {
    it('returns the shallow gallery shape', () => {
      const templates = service.listTemplates();
      expect(templates.map((t) => t.slug).sort()).toEqual([
        'faq_bot',
        'lead_capture',
        'welcome_menu',
      ]);
      for (const t of templates) {
        expect(t).toMatchObject({
          slug: expect.any(String),
          name: expect.any(String),
          description: expect.any(String),
          icon: expect.any(String),
          trigger_type: expect.any(String),
          node_count: expect.any(Number),
        });
        expect(t).not.toHaveProperty('nodes');
      }
    });
  });
});
