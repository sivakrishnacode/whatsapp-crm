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
import { findGoogleScriptAction } from '../google-script/google-script.catalog';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './services/automation-validate';
import type { CreateAutomationDto } from './dto/create-automation.dto';
import type { UpdateAutomationDto } from './dto/update-automation.dto';
import type { Channel } from '../common/messaging/channel';
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
      const steps = (effectiveSteps ?? []) as unknown as {
        step_type: string;
        step_config: Record<string, unknown>;
      }[];
      const issues = [
        ...validateTriggerForActivation(triggerType, triggerConfig ?? {}),
        ...validateStepsForActivation(steps),
        ...(await this.validateGoogleActions(accountId, steps)),
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
        // Empty = every channel, which is what an author who never
        // touched the picker means.
        channels: body.channels ?? [],
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
        // Needed to scope the app-connection check below: a step's
        // connection_id is author-supplied and must be verified against
        // the automation's OWN account, never taken on trust.
        accountId: true,
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
    if (presentKeys.has('channels')) update.channels = body.channels;
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
        ...(await this.validateGoogleActions(existing.accountId, mergedSteps)),
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
        // A copy that quietly ran on more channels than its original
        // would be a surprising way to start editing one.
        channels: original.channels,
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
      include: {
        contact: {
          // ig_username so the logs UI can name an Instagram contact,
          // who has no phone to fall back to.
          select: { id: true, name: true, phone: true, ig_username: true },
        },
      },
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
      channel: r.channel,
      error_message: r.errorMessage,
      created_at: r.createdAt.toISOString(),
      contact: r.contact
        ? {
            id: r.contact.id,
            name: r.contact.name ?? '',
            phone: r.contact.phone,
            ig_username: r.contact.ig_username,
          }
        : null,
    }));
  }

  /**
   * The half of `google_action` validation that needs the database.
   *
   * `validateStepsForActivation` is pure and synchronous — it checks the
   * step's shape. This checks the world: that the action still exists in
   * the catalogue, that the workspace has a script bridge set up at all,
   * and that every required field is filled.
   *
   * WHY THIS BLOCKS ACTIVATION RATHER THAN FAILING AT RUN TIME
   *   Everything that goes wrong during an automation run is silent by
   *   design: an unsupported step is skipped, an unknown token is empty.
   *   A missing Google setup would therefore turn "email the customer"
   *   into "quietly do nothing", and the first anyone hears of it is a
   *   customer who never got a reply. Activation is the last moment
   *   somebody is actually looking at the automation.
   *
   * ⚠️ NOTE WHAT IS NO LONGER CHECKED, AND WHY THAT IS SAFE.
   *   The predecessor verified a `connection_id` against this account,
   *   because a pasted id from another workspace had to read as "not
   *   found". A google_action config names no connection: the bridge is
   *   resolved from the automation's own account at run time, so there is
   *   no cross-tenant id to defend against. Scope checks are gone for the
   *   same reason — the customer's script holds its own grant, and we have
   *   no scope list to compare against.
   *
   *   What we CANNOT check here is whether their deployed script is
   *   current. A script predating a catalogue action answers "unknown
   *   action" at run time; the Integrations page compares versions, which
   *   is the right place for it.
   */
  private async validateGoogleActions(
    accountId: string,
    steps: { step_type: string; step_config: Record<string, unknown> }[],
  ): Promise<{ path: string; message: string }[]> {
    const issues: { path: string; message: string }[] = [];

    const googleSteps = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.step_type === 'google_action');
    if (googleSteps.length === 0) return issues;

    const connection = await this.prisma.google_script_connections.findUnique({
      where: { account_id: accountId },
      select: { execUrl: true },
    });
    const connected = Boolean(connection?.execUrl);

    for (const { step, index } of googleSteps) {
      const path = `steps.${index}`;
      const cfg = step.step_config ?? {};
      const actionId = String(cfg.action ?? '');

      // Shape problems are already reported by validateStepsForActivation;
      // reporting them twice would show the author the same issue in two
      // places.
      if (!actionId) continue;

      const action = findGoogleScriptAction(actionId);
      if (!action) {
        issues.push({
          path: `${path}.action`,
          message: `unknown Google action "${actionId}"`,
        });
        continue;
      }

      if (!connected) {
        issues.push({
          path: `${path}.action`,
          message:
            'Google is not connected for this workspace — set it up in Settings → Integrations',
        });
        continue;
      }

      // Required inputs are checked against the action's own FieldSpec, so
      // the served catalogue stays the single authority on what a field is
      // called and whether it is needed.
      for (const spec of action.inputs) {
        if (!spec.required) continue;
        const value = (cfg.input as Record<string, unknown> | undefined)?.[
          spec.key
        ];
        const empty =
          value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0);
        if (empty) {
          issues.push({
            path: `${path}.input.${spec.key}`,
            message: `"${spec.label}" is required`,
          });
        }
      }
    }

    return issues;
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
      channels: row.channels as Channel[],
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
