import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AutomationsService } from './automations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AutomationStepsTreeService } from './services/automation-steps-tree.service';
import type { CreateAutomationDto } from './dto/create-automation.dto';
import type { UpdateAutomationDto } from './dto/update-automation.dto';

const NOW = new Date('2024-01-01T00:00:00.000Z');

function makeAutomationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aut-1',
    accountId: 'acc-1',
    userId: 'user-1',
    name: 'Test automation',
    description: null,
    triggerType: 'new_message_received',
    triggerConfig: {},
    isActive: false,
    executionCount: 0,
    lastExecutedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    automation: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    automationStep: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    automationLog: {
      findMany: vi.fn(),
    },
  };
}

function makeStepsTreeMock() {
  return {
    insertSteps: vi.fn(),
    replaceSteps: vi.fn(),
    loadStepsTree: vi.fn().mockResolvedValue([]),
  };
}

describe('AutomationsService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let stepsTree: ReturnType<typeof makeStepsTreeMock>;
  let service: AutomationsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    stepsTree = makeStepsTreeMock();
    service = new AutomationsService(
      prisma as unknown as PrismaService,
      stepsTree as unknown as AutomationStepsTreeService,
    );
  });

  describe('list', () => {
    it('scopes by accountId and reshapes to snake_case', async () => {
      prisma.automation.findMany.mockResolvedValue([makeAutomationRow()]);
      const result = await service.list('acc-1');
      expect(prisma.automation.findMany).toHaveBeenCalledWith({
        where: { accountId: 'acc-1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result[0]).toMatchObject({
        id: 'aut-1',
        account_id: 'acc-1',
        user_id: 'user-1',
        trigger_type: 'new_message_received',
        is_active: false,
        execution_count: 0,
      });
    });
  });

  describe('create', () => {
    it('rejects when name and trigger_type are both missing', async () => {
      await expect(
        service.create('user-1', 'acc-1', {} as CreateAutomationDto),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.automation.create).not.toHaveBeenCalled();
    });

    it('seeds fields from a template when steps are empty', async () => {
      prisma.automation.create.mockResolvedValue(
        makeAutomationRow({ name: 'Welcome Message' }),
      );
      const dto = { template: 'welcome_message' } as CreateAutomationDto;
      const result = await service.create('user-1', 'acc-1', dto);
      const expectedData = expect.objectContaining({
        name: 'Welcome Message',
        triggerType: 'first_inbound_message',
      }) as Record<string, unknown>;
      expect(prisma.automation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expectedData }),
      );
      expect(stepsTree.insertSteps).toHaveBeenCalledWith(
        'aut-1',
        expect.any(Array),
      );
      expect(result.name).toBe('Welcome Message');
    });

    it('rejects activation with an invalid configuration instead of saving it', async () => {
      const dto = {
        name: 'Broken',
        trigger_type: 'new_message_received',
        is_active: true,
        steps: [],
      } as unknown as CreateAutomationDto;
      await expect(service.create('user-1', 'acc-1', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.automation.create).not.toHaveBeenCalled();
    });

    it('creates a draft with incomplete steps (drafts are allowed to be incomplete)', async () => {
      prisma.automation.create.mockResolvedValue(
        makeAutomationRow({ isActive: false }),
      );
      const dto = {
        name: 'Draft',
        trigger_type: 'new_message_received',
        is_active: false,
        steps: [],
      } as unknown as CreateAutomationDto;
      await expect(
        service.create('user-1', 'acc-1', dto),
      ).resolves.toBeDefined();
      expect(prisma.automation.create).toHaveBeenCalled();
    });
  });

  describe('getOne', () => {
    it('scopes by id+userId (not accountId)', async () => {
      prisma.automation.findFirst.mockResolvedValue(makeAutomationRow());
      await service.getOne('aut-1', 'user-1');
      expect(prisma.automation.findFirst).toHaveBeenCalledWith({
        where: { id: 'aut-1', userId: 'user-1' },
      });
    });

    it('throws NotFoundException when not found or not owned', async () => {
      prisma.automation.findFirst.mockResolvedValue(null);
      await expect(service.getOne('aut-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the automation is not owned by this user', async () => {
      prisma.automation.findUnique.mockResolvedValue({
        userId: 'someone-else',
        isActive: false,
        triggerType: 'new_message_received',
        triggerConfig: {},
      });
      await expect(
        service.update('aut-1', 'user-1', {} as UpdateAutomationDto),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.automation.update).not.toHaveBeenCalled();
    });

    it('only writes keys actually present in the body', async () => {
      prisma.automation.findUnique.mockResolvedValue({
        userId: 'user-1',
        isActive: false,
        triggerType: 'new_message_received',
        triggerConfig: {},
      });
      await service.update('aut-1', 'user-1', {
        is_active: false,
      } as UpdateAutomationDto);
      expect(prisma.automation.update).toHaveBeenCalledWith({
        where: { id: 'aut-1' },
        data: { isActive: false },
      });
    });

    it('rejects when the PATCH would leave an invalid automation active', async () => {
      prisma.automation.findUnique.mockResolvedValue({
        userId: 'user-1',
        isActive: false,
        triggerType: 'new_message_received',
        triggerConfig: {},
      });
      stepsTree.loadStepsTree.mockResolvedValue([]);
      await expect(
        service.update('aut-1', 'user-1', {
          is_active: true,
        } as UpdateAutomationDto),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.automation.update).not.toHaveBeenCalled();
    });

    it('replaces steps when steps is an array in the body', async () => {
      prisma.automation.findUnique.mockResolvedValue({
        userId: 'user-1',
        isActive: false,
        triggerType: 'new_message_received',
        triggerConfig: {},
      });
      const steps = [
        { step_type: 'send_message', step_config: { text: 'hi' } },
      ];
      await service.update('aut-1', 'user-1', {
        steps,
      } as unknown as UpdateAutomationDto);
      expect(stepsTree.replaceSteps).toHaveBeenCalledWith('aut-1', steps);
    });
  });

  describe('remove', () => {
    it('always succeeds (no NotFoundException) even if zero rows matched', async () => {
      prisma.automation.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove('aut-1', 'user-1')).resolves.toBeUndefined();
      expect(prisma.automation.deleteMany).toHaveBeenCalledWith({
        where: { id: 'aut-1', userId: 'user-1' },
      });
    });
  });

  describe('duplicate', () => {
    it('throws NotFoundException when the original is missing', async () => {
      prisma.automation.findFirst.mockResolvedValue(null);
      await expect(service.duplicate('aut-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('clones the automation into the same account with is_active=false', async () => {
      prisma.automation.findFirst.mockResolvedValue(
        makeAutomationRow({ isActive: true }),
      );
      prisma.automation.create.mockResolvedValue(
        makeAutomationRow({ id: 'aut-2', name: 'Test automation (Copy)' }),
      );
      prisma.automationStep.findMany.mockResolvedValue([]);
      const result = await service.duplicate('aut-1', 'user-1');
      const expectedData = expect.objectContaining({
        accountId: 'acc-1',
        isActive: false,
        name: 'Test automation (Copy)',
      }) as Record<string, unknown>;
      expect(prisma.automation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expectedData }),
      );
      expect(result.name).toBe('Test automation (Copy)');
    });

    it('re-maps parent_step_id references when cloning steps', async () => {
      prisma.automation.findFirst.mockResolvedValue(makeAutomationRow());
      prisma.automation.create.mockResolvedValue(
        makeAutomationRow({ id: 'aut-2' }),
      );
      prisma.automationStep.findMany.mockResolvedValue([
        {
          id: 'step-1',
          parentStepId: null,
          branch: null,
          stepType: 'condition',
          stepConfig: {},
          position: 0,
        },
        {
          id: 'step-2',
          parentStepId: 'step-1',
          branch: 'yes',
          stepType: 'send_message',
          stepConfig: {},
          position: 0,
        },
      ]);
      await service.duplicate('aut-1', 'user-1');
      const createManyCall = prisma.automationStep.createMany.mock
        .calls[0][0] as {
        data: { id: string; parentStepId: string | null }[];
      };
      const rows = createManyCall.data;
      expect(rows).toHaveLength(2);
      const root = rows.find((r) => r.parentStepId === null)!;
      const child = rows.find((r) => r.parentStepId !== null)!;
      expect(child.parentStepId).toBe(root.id);
      expect(root.id).not.toBe('step-1'); // ids are freshly generated, not reused
    });
  });

  describe('listLogs', () => {
    it('scopes by accountId (team-visible, not just the author)', async () => {
      prisma.automationLog.findMany.mockResolvedValue([]);
      await service.listLogs('aut-1', 'acc-1');
      expect(prisma.automationLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { automationId: 'aut-1', accountId: 'acc-1' },
        }),
      );
    });
  });
});
