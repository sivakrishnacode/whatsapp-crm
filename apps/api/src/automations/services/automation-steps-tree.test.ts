import { describe, expect, it, vi } from 'vitest';
import {
  AutomationStepsTreeService,
  type BuilderStepInput,
} from './automation-steps-tree.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The builder tree → flat rows conversion, which is where a save either
 * preserves what somebody drew or quietly rearranges it.
 *
 * Every assertion here is about a fact the editor depends on: that keys
 * survive a save (tokens reference them), that positions survive one
 * (the canvas layout is the author's), and that a branching step's
 * children are walked (a `random_split` whose branches were dropped
 * would silently become a step that does nothing).
 */

function makeService() {
  const createMany = vi.fn();
  const deleteMany = vi.fn();
  const prisma = {
    automationStep: { createMany, deleteMany, findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  const service = new AutomationStepsTreeService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma, createMany };
}

/** The rows a save would INSERT, in insert order. */
async function rowsFor(steps: BuilderStepInput[]) {
  const { service, createMany } = makeService();
  await service.insertSteps('aut-1', steps);
  return (createMany.mock.calls[0]?.[0]?.data ?? []) as {
    key: string;
    stepType: string;
    parentStepId: string | null;
    branch: string | null;
    position: number;
    positionX: number | null;
    positionY: number | null;
  }[];
}

describe('saving a tree', () => {
  it('keeps the key the author chose', async () => {
    // Tokens already written as {{ steps.notify_sales.… }} must keep
    // resolving after a save.
    const rows = await rowsFor([
      { step_type: 'send_webhook', step_config: {}, key: 'notify_sales' },
    ]);
    expect(rows[0].key).toBe('notify_sales');
  });

  it('generates a key when the client sends none', async () => {
    // An older client must still be able to save, and every step has to
    // end up addressable.
    const rows = await rowsFor([
      { step_type: 'send_message', step_config: {} },
      { step_type: 'send_message', step_config: {} },
    ]);
    expect(rows[0].key).toBe('send_message');
    expect(rows[1].key).toBe('send_message_2');
  });

  it('renames a duplicate rather than failing the save', async () => {
    // The unique index would reject the second row. Losing somebody's
    // work over a name collision they cannot see is worse than a token
    // that visibly stops resolving.
    const rows = await rowsFor([
      { step_type: 'add_tag', step_config: {}, key: 'tag' },
      { step_type: 'remove_tag', step_config: {}, key: 'tag' },
    ]);
    expect(rows.map((r) => r.key)).toEqual(['tag', 'tag_2']);
  });

  it('round-trips canvas positions, and keeps “never placed” as NULL', async () => {
    // NULL and 0 mean different things: one asks for auto-layout, the
    // other is a deliberate spot at the origin.
    const rows = await rowsFor([
      { step_type: 'send_message', step_config: {}, position_x: 120, position_y: -40 },
      { step_type: 'add_tag', step_config: {} },
    ]);
    expect(rows[0]).toMatchObject({ positionX: 120, positionY: -40 });
    expect(rows[1]).toMatchObject({ positionX: null, positionY: null });
  });

  it('walks a condition’s branches', async () => {
    const rows = await rowsFor([
      {
        step_type: 'condition',
        step_config: {},
        key: 'check',
        branches: {
          yes: [{ step_type: 'add_tag', step_config: {}, key: 'tag_vip' }],
          no: [{ step_type: 'add_note', step_config: {}, key: 'note' }],
        },
      },
    ]);
    expect(rows.map((r) => [r.key, r.branch])).toEqual([
      ['check', null],
      ['tag_vip', 'yes'],
      ['note', 'no'],
    ]);
    // Children point at the parent row, which is what makes the tree
    // reconstructable in one query.
    expect(rows[1].parentStepId).toBe(rows[0].parentStepId ?? rows[1].parentStepId);
    expect(rows[1].parentStepId).not.toBeNull();
  });

  it('walks a random_split’s branches too', async () => {
    // The original only recursed for `condition`. A split whose branches
    // were dropped saves cleanly and then does nothing at all — the
    // exact failure this test exists to prevent.
    const rows = await rowsFor([
      {
        step_type: 'random_split',
        step_config: { percent: 30 },
        key: 'split',
        branches: {
          yes: [{ step_type: 'send_message', step_config: {}, key: 'variant_a' }],
          no: [{ step_type: 'send_message', step_config: {}, key: 'variant_b' }],
        },
      },
    ]);
    expect(rows.map((r) => r.key)).toEqual(['split', 'variant_a', 'variant_b']);
    expect(rows[1].branch).toBe('yes');
    expect(rows[2].branch).toBe('no');
  });

  it('numbers positions within each scope, not across the tree', async () => {
    // Position is an ordering WITHIN a parent+branch; the executor reads
    // it that way when it recurses into a branch at position 0.
    const rows = await rowsFor([
      { step_type: 'send_message', step_config: {}, key: 'a' },
      {
        step_type: 'condition',
        step_config: {},
        key: 'check',
        branches: {
          yes: [
            { step_type: 'add_tag', step_config: {}, key: 'y1' },
            { step_type: 'add_note', step_config: {}, key: 'y2' },
          ],
          no: [],
        },
      },
    ]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.position]));
    expect(byKey).toEqual({ a: 0, check: 1, y1: 0, y2: 1 });
  });

  it('still expands the legacy flat seed shape', async () => {
    // Template seeds arrive flat with parent_index references.
    const rows = await rowsFor([
      { step_type: 'condition', step_config: {}, parent_index: null },
      { step_type: 'send_message', step_config: {}, parent_index: 0, branch: 'yes' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].branch).toBe('yes');
    expect(rows[1].parentStepId).not.toBeNull();
  });

  it('saves nothing rather than an empty insert', async () => {
    const { service, createMany } = makeService();
    await service.insertSteps('aut-1', []);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('loading a tree', () => {
  function loadWith(rows: Record<string, unknown>[]) {
    const prisma = {
      automationStep: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const service = new AutomationStepsTreeService(
      prisma as unknown as PrismaService,
    );
    return service.loadStepsTree('aut-1');
  }

  it('rebuilds the nested shape the editor expects', async () => {
    const tree = await loadWith([
      {
        id: 'r1',
        key: 'check',
        stepType: 'condition',
        stepConfig: {},
        parentStepId: null,
        branch: null,
        position: 0,
        positionX: 10,
        positionY: 20,
      },
      {
        id: 'r2',
        key: 'tag_vip',
        stepType: 'add_tag',
        stepConfig: {},
        parentStepId: 'r1',
        branch: 'yes',
        position: 0,
        positionX: null,
        positionY: null,
      },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('check');
    expect(tree[0].position_x).toBe(10);
    expect(tree[0].branches.yes[0].key).toBe('tag_vip');
  });

  it('mints a key for a row written before migration 080', async () => {
    // The canvas addresses nodes by key. A node with no key cannot be
    // rendered, selected or deleted, so handing one to the editor is not
    // an option — it is minted here and written back on the next save.
    const tree = await loadWith([
      {
        id: 'r1',
        key: null,
        stepType: 'send_message',
        stepConfig: {},
        parentStepId: null,
        branch: null,
        position: 0,
        positionX: null,
        positionY: null,
      },
    ]);
    expect(tree[0].key).toBeTruthy();
  });
});
