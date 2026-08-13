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
  /**
   * Author-facing reference (migration 080), used by tokens
   * (`{{ steps.<key>.… }}`) and as the canvas node id. Generated here
   * when the client omits it, so a step is always addressable.
   */
  key?: string | null;
  /** Canvas coordinates. NULL/absent = never laid out. */
  position_x?: number | null;
  position_y?: number | null;
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] };
  // Legacy flat form (from template seeds):
  branch?: 'yes' | 'no' | null;
  parent_index?: number | null;
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string;
  key: string;
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
  key: string;
  positionX: number | null;
  positionY: number | null;
}

/** Step types that own yes/no branches. Both split the flow in two and
 *  persist identically; only the decision differs. */
const BRANCHING_STEPS = new Set(['condition', 'random_split']);

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

    // Rows written before migration 080 can still have a NULL key. Mint
    // one for the editor rather than handing it a node with no id — the
    // canvas cannot render a node it cannot address, and the key is
    // written back on the next save.
    const used = new Set<string>();
    for (const row of rows) if (row.key) used.add(row.key);

    const byId = new Map<string, BuilderStepNode>();
    for (const row of rows) {
      const key = row.key ?? uniqueKey(row.stepType, used);
      byId.set(row.id, {
        id: row.id,
        key,
        step_type: row.stepType,
        step_config: (row.stepConfig ?? {}) as Record<string, unknown>,
        position_x: row.positionX,
        position_y: row.positionY,
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

    // Keys are unique per automation (partial unique index from 080). A
    // duplicate arriving from the client is renamed rather than rejected:
    // the save is the user's work, and a 500 over a name collision they
    // cannot see would lose it. Tokens pointing at the renamed step stop
    // resolving, which is visible and fixable — unlike a lost save.
    const used = new Set<string>();

    const rows: InsertRow[] = [];
    const walk = (
      steps: BuilderStepInput[],
      parentId: string | null,
      branch: 'yes' | 'no' | null,
    ) => {
      steps.forEach((s, idx) => {
        const id = s.id ?? randomUUID();
        const key = uniqueKey(s.key || s.step_type, used, s.key ?? undefined);
        rows.push({
          id,
          automationId,
          parentStepId: parentId,
          branch,
          stepType: s.step_type,
          stepConfig: (s.step_config ?? {}) as Prisma.InputJsonValue,
          position: idx,
          key,
          positionX: numberOrNull(s.position_x),
          positionY: numberOrNull(s.position_y),
        });
        if (BRANCHING_STEPS.has(s.step_type) && s.branches) {
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

/**
 * A key not yet taken in this automation.
 *
 * `preferred` (what the author typed) wins when it is free; otherwise a
 * numeric suffix is appended. Sanitised to `[a-z0-9_]` because the key
 * appears inside `{{ steps.<key>.… }}`, where a dot or a space would
 * split the path and a token would silently resolve to "".
 */
export function uniqueKey(
  base: string,
  used: Set<string>,
  preferred?: string,
): string {
  const clean = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);

  const wanted = clean(preferred || base) || 'step';
  if (!used.has(wanted)) {
    used.add(wanted);
    return wanted;
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${wanted}_${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${wanted}_${randomUUID().slice(0, 8)}`;
  used.add(fallback);
  return fallback;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
