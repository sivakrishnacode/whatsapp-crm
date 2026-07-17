import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Flow, FlowNode } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getFlowTemplate, listFlowTemplates } from './flow-templates';
import { validateFlowForActivation } from './flow-validate';
import type { CreateFlowDto } from './dto/create-flow.dto';
import type { UpdateFlowDto } from './dto/update-flow.dto';
import type { ImportFlowDto } from './dto/import-flow.dto';
import type {
  FlowJson,
  FlowNodeJson,
  FlowRunEventJson,
  FlowRunJson,
  FlowRunStatus,
  FlowStatus,
  FlowTriggerType,
} from './flow.types';

const SUPPORTED_SCHEMA_VERSIONS = [1];

/**
 * CRUD for the Flows domain — ported from the 8 Next.js route files
 * under apps/web/src/app/api/flows/**. Every response is reshaped to
 * the frontend's existing snake_case JSON shape via `toFlowJson`/
 * `toNodeJson`, and every error is thrown with an **object** payload
 * (`{ error: string }`, plus `issues` on the activate 422) because
 * the dashboard reads `json.error` on non-2xx — Nest's default string
 * wrapping would silently break that contract (same gotcha Phase 1
 * hit with the automation builder).
 *
 * Ownership: the original routes leaned on RLS via the caller's
 * cookie client (account-membership scoping post-migration-017), then
 * wrote through the service-role client. Prisma bypasses RLS entirely,
 * so every lookup here filters by accountId explicitly.
 */
@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // GET /flows
  // ============================================================

  async list(accountId: string): Promise<FlowJson[]> {
    const rows = await this.prisma.flow.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toFlowJson(r));
  }

  // ============================================================
  // POST /flows — template-clone-with-rollback or blank draft
  // ============================================================

  async create(
    userId: string,
    accountId: string,
    body: CreateFlowDto,
  ): Promise<FlowJson> {
    // -------- Template clone path --------
    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug);
      if (!template) {
        throw new BadRequestException({
          error: `Unknown template_slug "${body.template_slug}"`,
        });
      }
      const flow = await this.prisma.flow.create({
        data: {
          userId,
          accountId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: 'draft',
          triggerType: template.trigger_type,
          triggerConfig: template.trigger_config as Prisma.InputJsonValue,
          entryNodeId: template.entry_node_id,
        },
      });
      if (template.nodes.length > 0) {
        try {
          await this.prisma.flowNode.createMany({
            data: template.nodes.map((n) => ({
              flowId: flow.id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: n.config as Prisma.InputJsonValue,
            })),
          });
        } catch (err) {
          // Roll back the parent flow so a half-cloned template doesn't
          // sit as an empty draft. CASCADE on flow_id removes the
          // (probably zero) nodes too.
          await this.prisma.flow.delete({ where: { id: flow.id } });
          throw new InternalServerErrorException({
            error: (err as Error).message,
          });
        }
      }
      return this.toFlowJson(flow);
    }

    // -------- Plain (empty) create path --------
    if (!body.name?.trim()) {
      throw new BadRequestException({ error: 'name is required' });
    }
    const triggerType = body.trigger_type ?? 'keyword';

    const flow = await this.prisma.flow.create({
      data: {
        userId,
        accountId,
        name: body.name.trim(),
        description: body.description ?? null,
        status: 'draft',
        triggerType,
        triggerConfig: (body.trigger_config ?? {}) as Prisma.InputJsonValue,
      },
    });
    return this.toFlowJson(flow);
  }

  // ============================================================
  // GET /flows/:id — flow + nodes
  // ============================================================

  async getOne(
    id: string,
    accountId: string,
  ): Promise<{ flow: FlowJson; nodes: FlowNodeJson[] }> {
    const flow = await this.requireOwnedFlow(id, accountId);
    const nodes = await this.prisma.flowNode.findMany({
      where: { flowId: id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      flow: this.toFlowJson(flow),
      nodes: nodes.map((n) => this.toNodeJson(n)),
    };
  }

  // ============================================================
  // PUT /flows/:id — replace header fields + (optionally) the full
  // node graph. Delete-then-insert, intentionally non-transactional
  // per the original: the runner handles mid-edit reads safely (a
  // node_not_found ends the run cleanly).
  // ============================================================

  async update(
    id: string,
    accountId: string,
    body: UpdateFlowDto,
  ): Promise<{ flow: FlowJson | null; nodes: FlowNodeJson[] }> {
    if (body.name !== undefined && !body.name.trim()) {
      throw new BadRequestException({ error: 'name cannot be empty' });
    }
    await this.requireOwnedFlow(id, accountId);

    // Update the flow row first — the body may not include `nodes` (a
    // header-only save for editing the trigger config without touching
    // the graph). Skip node replacement in that case.
    const patch: Prisma.FlowUpdateInput = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description;
    if (body.trigger_type !== undefined) patch.triggerType = body.trigger_type;
    if (body.trigger_config !== undefined)
      patch.triggerConfig = body.trigger_config as Prisma.InputJsonValue;
    if (body.entry_node_id !== undefined)
      patch.entryNodeId = body.entry_node_id;
    if (body.fallback_policy !== undefined)
      patch.fallbackPolicy = body.fallback_policy as Prisma.InputJsonValue;

    try {
      await this.prisma.flow.update({ where: { id }, data: patch });
    } catch (err) {
      throw new InternalServerErrorException({ error: (err as Error).message });
    }

    if (body.nodes !== undefined) {
      try {
        await this.prisma.flowNode.deleteMany({ where: { flowId: id } });
        if (body.nodes.length > 0) {
          await this.prisma.flowNode.createMany({
            data: body.nodes.map((n) => ({
              flowId: id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: (n.config ?? {}) as Prisma.InputJsonValue,
              positionX: n.position_x ?? 0,
              positionY: n.position_y ?? 0,
            })),
          });
        }
      } catch (err) {
        throw new InternalServerErrorException({
          error: (err as Error).message,
        });
      }
    }

    // Re-fetch and return the new state — the editor uses the response
    // to reconcile its local form state.
    const [flow, nodes] = await Promise.all([
      this.prisma.flow.findUnique({ where: { id } }),
      this.prisma.flowNode.findMany({
        where: { flowId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      flow: flow ? this.toFlowJson(flow) : null,
      nodes: nodes.map((n) => this.toNodeJson(n)),
    };
  }

  // ============================================================
  // DELETE /flows/:id — hard delete; FK CASCADE cleans up nodes,
  // runs, events. Active runs end abruptly — intentional (see the
  // original's comment): the partial unique index frees the contact
  // for new triggers immediately.
  // ============================================================

  async remove(id: string, accountId: string): Promise<void> {
    await this.requireOwnedFlow(id, accountId);
    try {
      await this.prisma.flow.delete({ where: { id } });
    } catch (err) {
      throw new InternalServerErrorException({ error: (err as Error).message });
    }
  }

  // ============================================================
  // POST /flows/:id/activate — state transition. Activating runs the
  // full validator and refuses on any 'error' severity issue. Drafts
  // and archives are unconditional.
  // ============================================================

  async setStatus(
    id: string,
    accountId: string,
    status: unknown,
  ): Promise<FlowJson | null> {
    if (
      typeof status !== 'string' ||
      !['draft', 'active', 'archived'].includes(status)
    ) {
      throw new BadRequestException({
        error: "status must be one of 'draft' | 'active' | 'archived'",
      });
    }
    const flow = await this.requireOwnedFlow(id, accountId);

    if (status === 'active') {
      const nodes = await this.prisma.flowNode.findMany({
        where: { flowId: id },
        select: { nodeKey: true, nodeType: true, config: true },
      });
      const issues = validateFlowForActivation(
        {
          name: flow.name,
          trigger_type: flow.triggerType as FlowTriggerType,
          trigger_config: (flow.triggerConfig ?? {}) as Record<string, unknown>,
          entry_node_id: flow.entryNodeId,
        },
        nodes.map((n) => ({
          node_key: n.nodeKey,
          node_type: n.nodeType,
          config: (n.config ?? {}) as Record<string, unknown>,
        })),
      );
      const blockers = issues.filter((i) => i.severity === 'error');
      if (blockers.length > 0) {
        throw new UnprocessableEntityException({
          error: 'Cannot activate flow — fix the issues below first.',
          issues,
        });
      }
    }

    try {
      const updated = await this.prisma.flow.update({
        where: { id },
        data: { status, updatedAt: new Date() },
      });
      return this.toFlowJson(updated);
    } catch (err) {
      throw new InternalServerErrorException({ error: (err as Error).message });
    }
  }

  // ============================================================
  // GET /flows/:id/export — portable JSON; strips account_id/user_id
  // and all internal auto-generated UUIDs so the file can be imported
  // to any account. node_key references (the stable edge identifiers
  // inside JSONB configs) are preserved.
  // ============================================================

  async export(
    id: string,
    accountId: string,
  ): Promise<{ payload: Record<string, unknown>; filename: string }> {
    const flow = await this.requireOwnedFlow(id, accountId);
    const nodes = await this.prisma.flowNode.findMany({
      where: { flowId: id },
      orderBy: { createdAt: 'asc' },
    });

    const payload = {
      /** Schema version — increment when the shape changes incompatibly. */
      schema_version: 1,
      exported_at: new Date().toISOString(),
      flow: {
        name: flow.name,
        description: flow.description,
        status: 'draft' as const, // always import as draft
        trigger_type: flow.triggerType,
        trigger_config: flow.triggerConfig,
        entry_node_id: flow.entryNodeId, // node_key-based — safe to carry over
        fallback_policy: flow.fallbackPolicy,
      },
      nodes: nodes.map((n) => ({
        node_key: n.nodeKey,
        node_type: n.nodeType,
        config: n.config,
        position_x: n.positionX,
        position_y: n.positionY,
      })),
    };

    const safeName = flow.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const filename = `flow_${safeName}_${Date.now()}.json`;
    return { payload, filename };
  }

  // ============================================================
  // GET /flows/:id/runs — 50 most recent runs + joined contact +
  // event timeline. Debugging surface, not heavy querying.
  // ============================================================

  async listRuns(
    id: string,
    accountId: string,
  ): Promise<{
    flow: { id: string; name: string };
    runs: FlowRunJson[];
    events: FlowRunEventJson[];
  }> {
    const flow = await this.requireOwnedFlow(id, accountId);

    const runs = await this.prisma.flowRun.findMany({
      where: { flowId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        currentNodeKey: true,
        startedAt: true,
        lastAdvancedAt: true,
        endedAt: true,
        endReason: true,
        vars: true,
        repromptCount: true,
        contact: { select: { id: true, name: true, phone: true } },
      },
    });

    const runIds = runs.map((r) => r.id);
    let events: FlowRunEventJson[] = [];
    if (runIds.length > 0) {
      try {
        const rows = await this.prisma.flowRunEvent.findMany({
          where: { flowRunId: { in: runIds } },
          orderBy: { createdAt: 'asc' },
          select: {
            flowRunId: true,
            eventType: true,
            nodeKey: true,
            payload: true,
            createdAt: true,
          },
        });
        events = rows.map((e) => ({
          flow_run_id: e.flowRunId,
          event_type: e.eventType,
          node_key: e.nodeKey,
          payload: (e.payload ?? {}) as Record<string, unknown>,
          created_at: e.createdAt.toISOString(),
        }));
      } catch (err) {
        // Non-fatal — the page can still show runs without timelines.
        this.logger.error(`events fetch failed: ${(err as Error).message}`);
      }
    }

    return {
      flow: { id: flow.id, name: flow.name },
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status as FlowRunStatus,
        current_node_key: r.currentNodeKey,
        started_at: r.startedAt.toISOString(),
        last_advanced_at: r.lastAdvancedAt.toISOString(),
        ended_at: r.endedAt ? r.endedAt.toISOString() : null,
        end_reason: r.endReason,
        vars: (r.vars ?? {}) as Record<string, unknown>,
        reprompt_count: r.repromptCount,
        contact: r.contact
          ? { id: r.contact.id, name: r.contact.name, phone: r.contact.phone }
          : null,
      })),
      events,
    };
  }

  // ============================================================
  // POST /flows/import — accepts the shape produced by export and
  // creates a new **draft** flow (fresh UUIDs) owned by the caller's
  // account. Each call creates a new flow — no duplicate detection.
  // ============================================================

  async import(
    userId: string,
    accountId: string,
    body: ImportFlowDto,
  ): Promise<FlowJson> {
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(body.schema_version as number)) {
      throw new BadRequestException({
        error:
          `Unsupported schema_version "${body.schema_version}". ` +
          `Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
      });
    }

    const flowDef = body.flow;
    const nodeDefs = body.nodes ?? [];
    if (!flowDef) {
      throw new BadRequestException({
        error: 'Missing "flow" field in export payload.',
      });
    }
    if (!flowDef.name?.trim()) {
      throw new BadRequestException({
        error: 'flow.name is required and cannot be empty.',
      });
    }
    const validTriggers = ['keyword', 'first_inbound_message', 'manual'];
    if (!validTriggers.includes(flowDef.trigger_type as string)) {
      throw new BadRequestException({
        error: `Invalid trigger_type "${flowDef.trigger_type}".`,
      });
    }

    if (!Array.isArray(nodeDefs)) {
      throw new BadRequestException({ error: '"nodes" must be an array.' });
    }
    for (const n of nodeDefs) {
      if (typeof n.node_key !== 'string' || !n.node_key.trim()) {
        throw new BadRequestException({
          error: 'Each node must have a non-empty "node_key".',
        });
      }
      if (typeof n.node_type !== 'string' || !n.node_type.trim()) {
        throw new BadRequestException({
          error: 'Each node must have a non-empty "node_type".',
        });
      }
    }

    // Insert the flow as a fresh draft — always `status: 'draft'`
    // regardless of what the export file carries. The user can
    // activate it after review.
    let flow: Flow;
    try {
      flow = await this.prisma.flow.create({
        data: {
          userId,
          accountId,
          name: flowDef.name.trim(),
          description: flowDef.description ?? null,
          status: 'draft',
          triggerType: flowDef.trigger_type as string,
          triggerConfig: (flowDef.trigger_config ??
            {}) as Prisma.InputJsonValue,
          entryNodeId: flowDef.entry_node_id ?? null,
          // Omit fallback_policy entirely when absent — the DB default
          // fills it in (matches the original's `?? undefined`).
          ...(flowDef.fallback_policy !== undefined && {
            fallbackPolicy: flowDef.fallback_policy as Prisma.InputJsonValue,
          }),
        },
      });
    } catch (err) {
      throw new InternalServerErrorException({ error: (err as Error).message });
    }

    if (nodeDefs.length > 0) {
      try {
        await this.prisma.flowNode.createMany({
          data: nodeDefs.map((n) => ({
            flowId: flow.id,
            nodeKey: n.node_key,
            nodeType: n.node_type,
            config: (n.config ?? {}) as Prisma.InputJsonValue,
            positionX: n.position_x ?? 0,
            positionY: n.position_y ?? 0,
          })),
        });
      } catch (err) {
        // Roll back — a half-inserted flow is worse than no flow.
        await this.prisma.flow.delete({ where: { id: flow.id } });
        throw new InternalServerErrorException({
          error: (err as Error).message,
        });
      }
    }

    return this.toFlowJson(flow);
  }

  // ============================================================
  // GET /flows/templates — static gallery, shallow shape so the
  // client doesn't have to know about the full node tree.
  // ============================================================

  listTemplates(): Array<{
    slug: string;
    name: string;
    description: string;
    icon: string;
    trigger_type: string;
    node_count: number;
  }> {
    return listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }));
  }

  // ============================================================
  // Shared helpers
  // ============================================================

  /** Account-scoped ownership check — 404 (not 403) on miss, matching
   *  the original's RLS-driven "not yours = not found" behavior. */
  private async requireOwnedFlow(id: string, accountId: string): Promise<Flow> {
    const flow = await this.prisma.flow.findFirst({
      where: { id, accountId },
    });
    if (!flow) throw new NotFoundException({ error: 'Not found' });
    return flow;
  }

  private toFlowJson(row: Flow): FlowJson {
    return {
      id: row.id,
      account_id: row.accountId,
      user_id: row.userId,
      name: row.name,
      description: row.description,
      status: row.status as FlowStatus,
      trigger_type: row.triggerType as FlowTriggerType,
      trigger_config: (row.triggerConfig ?? {}) as Record<string, unknown>,
      entry_node_id: row.entryNodeId,
      fallback_policy: (row.fallbackPolicy ?? {}) as Record<string, unknown>,
      execution_count: row.executionCount,
      last_executed_at: row.lastExecutedAt
        ? row.lastExecutedAt.toISOString()
        : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private toNodeJson(row: FlowNode): FlowNodeJson {
    return {
      id: row.id,
      flow_id: row.flowId,
      node_key: row.nodeKey,
      node_type: row.nodeType,
      config: (row.config ?? {}) as Record<string, unknown>,
      position_x: row.positionX,
      position_y: row.positionY,
      created_at: row.createdAt.toISOString(),
    };
  }
}
