import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// ------------------------------------------------------------
// Ported from apps/web/src/lib/automations/steps-tree.ts.
//
// Builder payload → flat rows for automation_steps.
// Root steps arrive in order. A Condition step carries its children
// under `branches: { yes: [...], no: [...] }`. We walk the tree and
// assign stable UUIDs so parent_step_id references resolve in a
// single INSERT.
// ------------------------------------------------------------

export interface BuilderStepInput {
  id?: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] };
  // Legacy flat form (from template seeds):
  branch?: 'yes' | 'no' | null;
  parent_index?: number | null;
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string;
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] };
}

interface InsertRow {
  id: string;
  automationId: string;
  parentStepId: string | null;
  branch: 'yes' | 'no' | null;
  stepType: string;
  stepConfig: Prisma.InputJsonValue;
  position: number;
}

@Injectable()
export class AutomationStepsTreeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Delete-then-reinsert, wrapped in a transaction (the original did this non-transactionally). */
  async replaceSteps(
    automationId: string,
    input: BuilderStepInput[],
  ): Promise<void> {
    const rows = this.buildRows(automationId, input);
    await this.prisma.$transaction([
      this.prisma.automationStep.deleteMany({ where: { automationId } }),
      ...(rows.length > 0
        ? [this.prisma.automationStep.createMany({ data: rows })]
        : []),
    ]);
  }

  async insertSteps(
    automationId: string,
    input: BuilderStepInput[],
  ): Promise<void> {
    const rows = this.buildRows(automationId, input);
    if (rows.length === 0) return;
    await this.prisma.automationStep.createMany({ data: rows });
  }

  /**
   * Load the steps for an automation and rebuild the nested tree shape
   * the builder UI expects. One query, O(n) assembly.
   */
  async loadStepsTree(automationId: string): Promise<BuilderStepNode[]> {
    const rows = await this.prisma.automationStep.findMany({
      where: { automationId },
      orderBy: { position: 'asc' },
    });

    const byId = new Map<string, BuilderStepNode>();
    for (const row of rows) {
      byId.set(row.id, {
        id: row.id,
        step_type: row.stepType,
        step_config: (row.stepConfig ?? {}) as Record<string, unknown>,
        branches: { yes: [], no: [] },
      });
    }

    const roots: BuilderStepNode[] = [];
    for (const row of rows) {
      const node = byId.get(row.id)!;
      if (row.parentStepId) {
        const parent = byId.get(row.parentStepId);
        if (parent) {
          const bucket = (row.branch ?? 'yes') as 'yes' | 'no';
          parent.branches[bucket].push(node);
        }
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  private buildRows(
    automationId: string,
    input: BuilderStepInput[],
  ): InsertRow[] {
    if (!input || input.length === 0) return [];

    const looksFlat = input.some(
      (s) => s.branch !== undefined || s.parent_index !== undefined,
    );
    const tree = looksFlat ? this.seedsToTree(input) : input;

    const rows: InsertRow[] = [];
    const walk = (
      steps: BuilderStepInput[],
      parentId: string | null,
      branch: 'yes' | 'no' | null,
    ) => {
      steps.forEach((s, idx) => {
        const id = s.id ?? randomUUID();
        rows.push({
          id,
          automationId,
          parentStepId: parentId,
          branch,
          stepType: s.step_type,
          stepConfig: (s.step_config ?? {}) as Prisma.InputJsonValue,
          position: idx,
        });
        if (s.step_type === 'condition' && s.branches) {
          if (s.branches.yes) walk(s.branches.yes, id, 'yes');
          if (s.branches.no) walk(s.branches.no, id, 'no');
        }
      });
    };
    walk(tree, null, null);
    return rows;
  }

  private seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
    const nodes: BuilderStepInput[] = seeds.map((s) => ({
      ...s,
      branches: { yes: [], no: [] },
    }));
    const roots: BuilderStepInput[] = [];
    nodes.forEach((n, i) => {
      const seed = seeds[i];
      if (seed.parent_index == null) {
        roots.push(n);
      } else {
        const parent = nodes[seed.parent_index];
        parent.branches = parent.branches ?? { yes: [], no: [] };
        const bucket = seed.branch ?? 'yes';
        (parent.branches[bucket] ??= []).push(n);
      }
    });
    return roots;
  }
}
