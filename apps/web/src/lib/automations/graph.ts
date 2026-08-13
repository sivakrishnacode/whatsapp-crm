/**
 * The automation editor's graph model.
 *
 * WHAT AN AUTOMATION ACTUALLY IS
 *   A sequence of steps, where a branching step (condition, random
 *   split) owns two child sequences — `yes` and `no`. That is the shape
 *   `automation_steps` persists (parent_step_id + branch) and the shape
 *   the executor interprets. It is a TREE, not a free graph.
 *
 * WHAT THE CANVAS SHOWS
 *   A graph derived from that tree. Every edge here is a fact about
 *   execution order, not a stored pointer:
 *     - sequential edges inside one scope,
 *     - a branching step to the head of each of its branches (yes/no),
 *     - a DASHED "continue" edge from a branching step to whatever
 *       follows it in the parent sequence.
 *
 *   That last one exists because the executor resumes the parent
 *   sequence after a branch finishes. Leaving it out made every
 *   condition look like the end of the automation, and people duplicated
 *   their follow-up steps into both branches to compensate.
 *
 * WHY EDGES ARE DERIVED RATHER THAN STORED
 *   A stored edge can disagree with the tree; a derived one cannot. Drag
 *   -to-connect is therefore a MOVE (see `connectSteps`), not a link — it
 *   restructures the tree and the picture follows.
 */

import { autoLayout } from '@/lib/flows/layout';
import { STEP_META, blankConfig } from '@/lib/automations/step-meta';
import type { AutomationStepType } from '@/types';

// ============================================================
// Model
// ============================================================

export interface BuilderStep {
  /**
   * Stable, author-facing identity (migration 080). Doubles as the
   * canvas node id and the token path (`{{ steps.<key>.… }}`).
   *
   * Row ids cannot serve either purpose: saving is delete-then-reinsert,
   * so every id changes on every save.
   */
  key: string;
  step_type: AutomationStepType;
  step_config: Record<string, unknown>;
  /** Canvas coordinates. null = never laid out (auto-layout will run). */
  position_x?: number | null;
  position_y?: number | null;
  branches?: { yes: BuilderStep[]; no: BuilderStep[] };
}

/** Where a step sits — the address used by insert/move operations. */
export type StepScope =
  | { kind: 'root' }
  | { kind: 'branch'; parentKey: string; branch: 'yes' | 'no' };

export interface FlatStep {
  step: BuilderStep;
  scope: StepScope;
  /** Index within its own scope. */
  index: number;
  /** Nesting depth, for layout hints and indentation. */
  depth: number;
}

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 96;
export const TRIGGER_KEY = '__trigger__';

// ============================================================
// Traversal
// ============================================================

/** Every step, in document order, with its scope. */
export function flattenSteps(
  steps: BuilderStep[],
  scope: StepScope = { kind: 'root' },
  depth = 0,
): FlatStep[] {
  const out: FlatStep[] = [];
  steps.forEach((step, index) => {
    out.push({ step, scope, index, depth });
    if (step.branches) {
      out.push(
        ...flattenSteps(
          step.branches.yes,
          { kind: 'branch', parentKey: step.key, branch: 'yes' },
          depth + 1,
        ),
        ...flattenSteps(
          step.branches.no,
          { kind: 'branch', parentKey: step.key, branch: 'no' },
          depth + 1,
        ),
      );
    }
  });
  return out;
}

export function findStep(
  steps: BuilderStep[],
  key: string,
): FlatStep | undefined {
  return flattenSteps(steps).find((f) => f.step.key === key);
}

export function allKeys(steps: BuilderStep[]): Set<string> {
  return new Set(flattenSteps(steps).map((f) => f.step.key));
}

/**
 * A key not already taken.
 *
 * Sanitised to `[a-z0-9_]` because it appears inside
 * `{{ steps.<key>.… }}`, where a dot or a space would split the path and
 * the token would silently resolve to nothing. Mirrors `uniqueKey()` in
 * apps/api/src/automations/services/automation-steps-tree.service.ts —
 * the server sanitises again, so the two must agree or a saved key would
 * differ from the one the author's tokens reference.
 */
export function uniqueStepKey(base: string, taken: Set<string>): string {
  const clean =
    String(base)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'step';
  if (!taken.has(clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(`${clean}_${n}`)) return `${clean}_${n}`;
  }
  return `${clean}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A new step of `type`, with its default config and a free key. */
export function blankStep(
  type: AutomationStepType,
  taken: Set<string>,
  config?: Record<string, unknown>,
): BuilderStep {
  return {
    key: uniqueStepKey(type, taken),
    step_type: type,
    step_config: config ?? blankConfig(type),
    branches: STEP_META[type]?.branching ? { yes: [], no: [] } : undefined,
  };
}

// ============================================================
// Mutations — all immutable, all addressed by key
// ============================================================

function mapScope(
  steps: BuilderStep[],
  scope: StepScope,
  fn: (list: BuilderStep[]) => BuilderStep[],
): BuilderStep[] {
  if (scope.kind === 'root') return fn(steps);
  return steps.map((s) => {
    if (s.key === scope.parentKey && s.branches) {
      return {
        ...s,
        branches: { ...s.branches, [scope.branch]: fn(s.branches[scope.branch]) },
      };
    }
    if (!s.branches) return s;
    return {
      ...s,
      branches: {
        yes: mapScope(s.branches.yes, scope, fn),
        no: mapScope(s.branches.no, scope, fn),
      },
    };
  });
}

export function insertStep(
  steps: BuilderStep[],
  scope: StepScope,
  index: number,
  step: BuilderStep,
): BuilderStep[] {
  return mapScope(steps, scope, (list) => {
    const copy = [...list];
    copy.splice(Math.max(0, Math.min(index, copy.length)), 0, step);
    return copy;
  });
}

export function updateStep(
  steps: BuilderStep[],
  key: string,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  return steps.map((s) => {
    const next = s.key === key ? updater(s) : s;
    if (!next.branches) return next;
    return {
      ...next,
      branches: {
        yes: updateStep(next.branches.yes, key, updater),
        no: updateStep(next.branches.no, key, updater),
      },
    };
  });
}

export function updateStepConfig(
  steps: BuilderStep[],
  key: string,
  patch: Record<string, unknown>,
): BuilderStep[] {
  return updateStep(steps, key, (s) => ({
    ...s,
    step_config: { ...s.step_config, ...patch },
  }));
}

/**
 * Remove a step.
 *
 * Its branch children go with it. Splicing them into the parent
 * sequence would be the "helpful" alternative, and it is wrong: those
 * steps were written to run only under a condition, and silently
 * promoting them to unconditional is how a discount code gets sent to
 * everybody.
 */
export function removeStep(steps: BuilderStep[], key: string): BuilderStep[] {
  return steps
    .filter((s) => s.key !== key)
    .map((s) =>
      s.branches
        ? {
            ...s,
            branches: {
              yes: removeStep(s.branches.yes, key),
              no: removeStep(s.branches.no, key),
            },
          }
        : s,
    );
}

/** Detach a step (with its subtree) and return both halves. */
function detachStep(
  steps: BuilderStep[],
  key: string,
): { steps: BuilderStep[]; detached: BuilderStep | null } {
  const found = findStep(steps, key);
  if (!found) return { steps, detached: null };
  return { steps: removeStep(steps, key), detached: found.step };
}

export function moveStepWithin(
  steps: BuilderStep[],
  key: string,
  direction: -1 | 1,
): BuilderStep[] {
  const found = findStep(steps, key);
  if (!found) return steps;
  return mapScope(steps, found.scope, (list) => {
    const i = list.findIndex((s) => s.key === key);
    const j = i + direction;
    if (i === -1 || j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });
}

/**
 * Drag-to-connect: make `targetKey` run immediately after `sourceKey`.
 *
 * A connection is a MOVE, not a link. The tree is the source of truth,
 * so the only honest reading of "draw an arrow from A to B" is "B now
 * follows A" — which for a branch handle means "B is now the first step
 * of that branch".
 *
 * Refused when the target is an ancestor of the source: that would
 * detach the subtree the source lives in and reattach it inside itself.
 */
export function connectSteps(
  steps: BuilderStep[],
  sourceKey: string,
  handle: 'next' | 'yes' | 'no',
  targetKey: string,
): BuilderStep[] {
  if (sourceKey === targetKey) return steps;
  const source = findStep(steps, sourceKey);
  const target = findStep(steps, targetKey);
  if (!source || !target) return steps;
  // Moving a step into its own subtree would orphan everything below it.
  if (isAncestor(steps, targetKey, sourceKey)) return steps;

  const { steps: without, detached } = detachStep(steps, targetKey);
  if (!detached) return steps;

  if (handle === 'yes' || handle === 'no') {
    return insertStep(
      without,
      { kind: 'branch', parentKey: sourceKey, branch: handle },
      0,
      detached,
    );
  }

  // "next" — sits directly after the source in the source's own scope.
  // Re-read the source after the detach: removing the target may have
  // shifted its index.
  const afterDetach = findStep(without, sourceKey);
  if (!afterDetach) return steps;
  return insertStep(
    without,
    afterDetach.scope,
    afterDetach.index + 1,
    detached,
  );
}

/** Is `maybeAncestorKey` on the path from a root to `key`? */
export function isAncestor(
  steps: BuilderStep[],
  maybeAncestorKey: string,
  key: string,
): boolean {
  const ancestor = findStep(steps, maybeAncestorKey);
  if (!ancestor?.step.branches) return false;
  const inside = flattenSteps([ancestor.step]).map((f) => f.step.key);
  return inside.includes(key) && maybeAncestorKey !== key;
}

export function setStepPosition(
  steps: BuilderStep[],
  key: string,
  x: number,
  y: number,
): BuilderStep[] {
  return updateStep(steps, key, (s) => ({ ...s, position_x: x, position_y: y }));
}

/**
 * Copy a step, its config and its branches under fresh keys.
 *
 * Tokens INSIDE the copy that referenced the original's key are left
 * alone deliberately: they still point at a step that exists and still
 * resolve. Rewriting them to the copy would change behaviour the author
 * never asked to change.
 */
export function duplicateStep(
  steps: BuilderStep[],
  key: string,
): { steps: BuilderStep[]; newKey: string | null } {
  const found = findStep(steps, key);
  if (!found) return { steps, newKey: null };
  const taken = allKeys(steps);

  const clone = (s: BuilderStep): BuilderStep => {
    const newKey = uniqueStepKey(s.key, taken);
    taken.add(newKey);
    return {
      ...s,
      key: newKey,
      // Offset so the copy is visibly a second card rather than sitting
      // exactly on top of the original.
      position_x: s.position_x == null ? null : s.position_x + 40,
      position_y: s.position_y == null ? null : s.position_y + 40,
      step_config: structuredClone(s.step_config),
      branches: s.branches
        ? { yes: s.branches.yes.map(clone), no: s.branches.no.map(clone) }
        : undefined,
    };
  };

  const copy = clone(found.step);
  return {
    steps: insertStep(steps, found.scope, found.index + 1, copy),
    newKey: copy.key,
  };
}

// ============================================================
// Canvas derivation
// ============================================================

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Must name a handle the SOURCE card actually renders — React Flow
   *  resolves by id and silently drops an edge that names a missing one. */
  sourceHandle: 'next' | 'yes' | 'no' | 'continue';
  label?: string;
  /** The post-branch continuation — drawn dashed, since it is a return
   *  to the parent sequence rather than a step's own output. */
  dashed?: boolean;
}

export function deriveEdges(steps: BuilderStep[]): CanvasEdge[] {
  const edges: CanvasEdge[] = [];

  const walkScope = (list: BuilderStep[], parentSourceKey: string) => {
    list.forEach((step, i) => {
      const previous = i === 0 ? parentSourceKey : list[i - 1].key;
      const previousIsBranching =
        i > 0 && Boolean(list[i - 1].branches);
      if (previous) {
        edges.push({
          id: `${previous}->${step.key}`,
          source: previous,
          target: step.key,
          // MUST match a handle the source card actually renders. A
          // branching card has yes / no / continue and NO `next`, and
          // React Flow resolves handles by id — naming a handle that is
          // not there drops the edge silently, leaving the receiving
          // card with an inbound port and nothing arriving at it.
          sourceHandle: previousIsBranching ? 'continue' : 'next',
          // From a branching step, this is the "whatever the branch
          // decided, carry on here" edge.
          dashed: previousIsBranching,
          label: previousIsBranching ? 'continues after' : undefined,
        });
      }

      if (step.branches) {
        for (const branch of ['yes', 'no'] as const) {
          const head = step.branches[branch][0];
          if (!head) continue;
          edges.push({
            id: `${step.key}-${branch}->${head.key}`,
            source: step.key,
            target: head.key,
            sourceHandle: branch,
            label: branch === 'yes' ? 'Yes' : 'No',
          });
          walkScope(step.branches[branch], head.key);
          // walkScope links head→rest; the head's own inbound edge is
          // the branch edge above, so pass the head as the anchor and
          // skip its duplicate.
        }
      }
    });
  };

  // The trigger is the anchor for the first root step.
  walkScope(steps, TRIGGER_KEY);
  // Deduplicate: walkScope(branchList, head.key) re-emits head→[1] only,
  // but a branch of one step would otherwise produce a self-edge.
  return edges.filter((e) => e.source !== e.target);
}

/**
 * Positions for every node, running dagre when any node has never been
 * placed.
 *
 * All-or-nothing on purpose: mixing saved coordinates with freshly
 * generated ones puts new cards on top of old ones, which reads as a
 * rendering bug. Either the author has arranged this canvas or they
 * have not.
 *
 * ⚠️ THE CALLER MUST PERSIST WHAT THIS GENERATES (see
 * `needsAutoLayout`). Left unpersisted, a single unpositioned step keeps
 * this on the dagre path, and every drag is silently overwritten by the
 * next layout pass — the canvas simply refuses to be arranged.
 */
/**
 * Does any step still lack a position?
 *
 * The canvas persists the generated layout the first time this is true,
 * so the state is transient rather than permanent — which is what makes
 * a drag stick.
 */
export function needsAutoLayout(steps: BuilderStep[]): boolean {
  const flat = flattenSteps(steps);
  if (flat.length === 0) return false;
  return flat.some(
    (f) =>
      typeof f.step.position_x !== 'number' ||
      typeof f.step.position_y !== 'number',
  );
}

export function derivePositions(
  steps: BuilderStep[],
): Map<string, { x: number; y: number }> {
  const flat = flattenSteps(steps);
  const placed = !needsAutoLayout(steps);

  if (placed && flat.length > 0) {
    const map = new Map<string, { x: number; y: number }>();
    map.set(TRIGGER_KEY, triggerPosition(flat));
    for (const f of flat) {
      map.set(f.step.key, {
        x: f.step.position_x as number,
        y: f.step.position_y as number,
      });
    }
    return map;
  }

  const edges = deriveEdges(steps);
  return autoLayout(
    [
      { id: TRIGGER_KEY, width: NODE_WIDTH, height: NODE_HEIGHT },
      ...flat.map((f) => ({
        id: f.step.key,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
    ],
    edges.map((e) => ({ source: e.source, target: e.target })),
    // LEFT TO RIGHT. An automation reads as a sentence — trigger, then
    // this, then that — and a horizontal spine matches how the branches
    // fan out. It also keeps a long automation on one screen height
    // rather than one screen width.
    { direction: 'LR' },
  );
}

/**
 * Where the trigger card sits on an already-arranged canvas.
 *
 * To the LEFT of the first step and vertically aligned with it, so an
 * author who dragged their steps somewhere far from the origin does not
 * have to scroll back to find what starts the automation.
 */
function triggerPosition(flat: FlatStep[]): { x: number; y: number } {
  if (flat.length === 0) return { x: 0, y: 0 };
  const first = flat[0].step;
  return {
    x: (first.position_x ?? 0) - (NODE_WIDTH + 80),
    y: first.position_y ?? 0,
  };
}

// ============================================================
// Serialisation
// ============================================================

export interface ApiStep {
  step_type: string;
  step_config: Record<string, unknown>;
  key: string;
  position_x?: number | null;
  position_y?: number | null;
  branches?: { yes: ApiStep[]; no: ApiStep[] };
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    key: s.key,
    position_x: s.position_x ?? null,
    position_y: s.position_y ?? null,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }));
}

export interface ServerStepNode {
  id: string;
  key?: string | null;
  step_type: string;
  step_config: Record<string, unknown>;
  position_x?: number | null;
  position_y?: number | null;
  branches?: { yes: ServerStepNode[]; no: ServerStepNode[] };
}

/**
 * Server tree → editor tree.
 *
 * A missing key (a row written before migration 080, or by an older
 * client) is minted here rather than left empty: the canvas addresses
 * nodes by key, and a node with no id cannot be rendered, selected or
 * deleted.
 */
export function fromServerSteps(
  nodes: ServerStepNode[],
  taken: Set<string> = new Set(),
): BuilderStep[] {
  return nodes.map((n) => {
    const key = uniqueStepKey(n.key || n.step_type, taken);
    taken.add(key);
    const type = n.step_type as AutomationStepType;
    return {
      key,
      step_type: type,
      step_config: n.step_config ?? {},
      position_x: n.position_x ?? null,
      position_y: n.position_y ?? null,
      branches: STEP_META[type]?.branching
        ? {
            yes: fromServerSteps(n.branches?.yes ?? [], taken),
            no: fromServerSteps(n.branches?.no ?? [], taken),
          }
        : undefined,
    };
  });
}
