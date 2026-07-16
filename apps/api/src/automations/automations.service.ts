import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Automation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutomationStepsTreeService,
  type BuilderStepInput,
  type BuilderStepNode,
} from './services/automation-steps-tree.service';
import { getTemplate } from './services/automation-templates';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './services/automation-validate';
import type { CreateAutomationDto } from './dto/create-automation.dto';
import type { UpdateAutomationDto } from './dto/update-automation.dto';
import type {
  AutomationJson,
  AutomationLogJson,
  AutomationLogStatus,
  AutomationLogStepResult,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from './automation.types';

/**
 * CRUD for the Automations domain — ported from the 6 Next.js route
 * files under apps/web/src/app/api/automations/**. Every response is
 * reshaped back to the frontend's existing snake_case JSON shape via
 * `toAutomationJson`/`toLogJson` so the dashboard UI needs zero changes.
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepsTree: AutomationStepsTreeService,
  ) {}

  async list(accountId: string): Promise<AutomationJson[]> {
    const rows = await this.prisma.automation.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toAutomationJson(r));
  }

  async create(
    userId: string,
    accountId: string,
    body: CreateAutomationDto,
  ): Promise<AutomationJson> {
    let name = body.name;
    let description = body.description;
    let triggerType = body.trigger_type;
    let triggerConfig = body.trigger_config;
    let effectiveSteps = body.steps as unknown as
      BuilderStepInput[] | undefined;

    if (body.template && (!body.steps || body.steps.length === 0)) {
      const t = getTemplate(body.template);
      if (t) {
        name ??= t.name;
        description ??= t.description;
        triggerType ??= t.trigger_type;
        triggerConfig ??= t.trigger_config as Record<string, unknown>;
        effectiveSteps = t.steps as unknown as BuilderStepInput[];
      }
    }

    if (!name || !triggerType) {
      throw new BadRequestException({
        error: 'name and trigger_type are required',
      });
    }

    // Block activation of a clearly broken automation up-front instead of
    // letting every trigger silently produce a failed log row. Drafts
    // (is_active=false) are allowed to be incomplete so users can save
    // progress mid-build.
    if (body.is_active) {
      const issues = [
        ...validateTriggerForActivation(triggerType, triggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as {
            step_type: string;
            step_config: Record<string, unknown>;
          }[],
        ),
      ];
      if (issues.length > 0) {
        throw new BadRequestException({
          error: 'Cannot activate automation with invalid configuration',
          issues,
        });
      }
    }

    const automation = await this.prisma.automation.create({
      data: {
        userId,
        accountId,
        name,
        description: description ?? null,
        triggerType,
        triggerConfig: (triggerConfig ?? {}) as Prisma.InputJsonValue,
        isActive: !!body.is_active,
      },
    });

    if (effectiveSteps && effectiveSteps.length > 0) {
      await this.stepsTree.insertSteps(automation.id, effectiveSteps);
    }

    return this.toAutomationJson(automation);
  }

  /** Scoped by id+userId (narrower than account) — preserves the original's exact behavior. */
  async getOne(
    id: string,
    userId: string,
  ): Promise<{ automation: AutomationJson; steps: BuilderStepNode[] }> {
    const automation = await this.prisma.automation.findFirst({
      where: { id, userId },
    });
    if (!automation) throw new NotFoundException({ error: 'Not found' });
    const steps = await this.stepsTree.loadStepsTree(id);
    return { automation: this.toAutomationJson(automation), steps };
  }

  async update(
    id: string,
    userId: string,
    body: UpdateAutomationDto,
  ): Promise<void> {
    const existing = await this.prisma.automation.findUnique({
      where: { id },
      select: {
        userId: true,
        isActive: true,
        triggerType: true,
        triggerConfig: true,
      },
    });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException({ error: 'Not found' });
    }

    // Only touch keys actually present in the parsed body (class-transformer
    // omits absent optional keys entirely rather than setting them undefined).
    const presentKeys = new Set(Object.keys(body));
    const update: Prisma.AutomationUpdateInput = {};
    if (presentKeys.has('name')) update.name = body.name;
    if (presentKeys.has('description')) update.description = body.description;
    if (presentKeys.has('trigger_type')) update.triggerType = body.trigger_type;
    if (presentKeys.has('trigger_config'))
      update.triggerConfig = body.trigger_config as Prisma.InputJsonValue;
    if (presentKeys.has('is_active')) update.isActive = body.is_active;

    // If this PATCH leaves the automation active (either explicitly
    // activating it OR editing an already-active one), validate the
    // merged configuration first. Activation is the natural gate — drafts
    // are still allowed to be incomplete.
    const willBeActive =
      typeof body.is_active === 'boolean' ? body.is_active : existing.isActive;
    if (willBeActive) {
      const mergedTriggerType = body.trigger_type ?? existing.triggerType;
      const mergedTriggerConfig =
        body.trigger_config ??
        ((existing.triggerConfig ?? {}) as Record<string, unknown>);
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as unknown as {
            step_type: string;
            step_config: Record<string, unknown>;
          }[])
        : ((await this.stepsTree.loadStepsTree(id)) as unknown as {
            step_type: string;
            step_config: Record<string, unknown>;
          }[]);
      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ];
      if (issues.length > 0) {
        throw new BadRequestException({
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        });
      }
    }

    if (Object.keys(update).length > 0) {
      await this.prisma.automation.update({ where: { id }, data: update });
    }

    if (Array.isArray(body.steps)) {
      await this.stepsTree.replaceSteps(
        id,
        body.steps as unknown as BuilderStepInput[],
      );
    }
  }

  /**
   * Matches the original route exactly: a delete filtered by id+userId
   * that matches zero rows is NOT treated as an error — it always
   * returns success, whether or not anything was actually deleted.
   */
  async remove(id: string, userId: string): Promise<void> {
    await this.prisma.automation.deleteMany({ where: { id, userId } });
  }

  async duplicate(id: string, userId: string): Promise<AutomationJson> {
    const original = await this.prisma.automation.findFirst({
      where: { id, userId },
    });
    if (!original) throw new NotFoundException({ error: 'Not found' });

    const copy = await this.prisma.automation.create({
      data: {
        // Clone into the same account as the original.
        accountId: original.accountId,
        userId,
        name: `${original.name} (Copy)`,
        description: original.description,
        triggerType: original.triggerType,
        triggerConfig: original.triggerConfig as Prisma.InputJsonValue,
        isActive: false,
      },
    });

    const steps = await this.prisma.automationStep.findMany({
      where: { automationId: id },
      orderBy: { position: 'asc' },
    });

    if (steps.length > 0) {
      // Re-map parent_step_id: build old→new id map first so the second
      // pass inserts rows with correct parent references.
      const idMap = new Map<string, string>();
      for (const row of steps) idMap.set(row.id, randomUUID());
      const rows = steps.map((row) => ({
        id: idMap.get(row.id)!,
        automationId: copy.id,
        parentStepId: row.parentStepId
          ? (idMap.get(row.parentStepId) ?? null)
          : null,
        branch: row.branch,
        stepType: row.stepType,
        stepConfig: row.stepConfig as Prisma.InputJsonValue,
        position: row.position,
      }));
      await this.prisma.automationStep.createMany({ data: rows });
    }

    return this.toAutomationJson(copy);
  }

  /**
   * New route (no Next.js equivalent — logs were previously read via a
   * direct RLS-scoped Supabase query from the browser). Scoped by
   * accountId (team-visible), matching the RLS behavior it replaces —
   * NOT by userId, to avoid a visibility regression for teammates.
   */
  async listLogs(id: string, accountId: string): Promise<AutomationLogJson[]> {
    const rows = await this.prisma.automationLog.findMany({
      where: { automationId: id, accountId },
      include: { contact: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      automation_id: r.automationId,
      user_id: r.userId,
      contact_id: r.contactId,
      trigger_event: r.triggerEvent,
      steps_executed: (r.stepsExecuted ??
        []) as unknown as AutomationLogStepResult[],
      status: r.status as AutomationLogStatus,
      error_message: r.errorMessage,
      created_at: r.createdAt.toISOString(),
      contact: r.contact
        ? {
            id: r.contact.id,
            name: r.contact.name ?? '',
            phone: r.contact.phone,
          }
        : null,
    }));
  }

  private toAutomationJson(row: Automation): AutomationJson {
    return {
      id: row.id,
      account_id: row.accountId,
      user_id: row.userId,
      name: row.name,
      description: row.description,
      trigger_type: row.triggerType as AutomationTriggerType,
      trigger_config: row.triggerConfig as AutomationTriggerConfig,
      is_active: row.isActive,
      execution_count: row.executionCount,
      last_executed_at: row.lastExecutedAt
        ? row.lastExecutedAt.toISOString()
        : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
