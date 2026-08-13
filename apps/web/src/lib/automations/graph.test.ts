import { describe, expect, it } from 'vitest';
import {
  allKeys,
  blankStep,
  connectSteps,
  deriveEdges,
  duplicateStep,
  findStep,
  flattenSteps,
  fromServerSteps,
  insertStep,
  removeStep,
  toApiSteps,
  uniqueStepKey,
  type BuilderStep,
} from './graph';
import { precedingSteps, tokensFor } from './tokens';

function step(
  key: string,
  type: BuilderStep['step_type'] = 'send_message',
  branches?: { yes: BuilderStep[]; no: BuilderStep[] },
): BuilderStep {
  return { key, step_type: type, step_config: {}, branches };
}

/** send → condition(yes: tag, no: note) → close */
function sampleTree(): BuilderStep[] {
  return [
    step('greet'),
    step('check', 'condition', {
      yes: [step('tag_vip', 'add_tag')],
      no: [step('leave_note', 'add_note')],
    }),
    step('wrap_up', 'close_conversation'),
  ];
}

describe('keys', () => {
  it('sanitises to what a token path can address', () => {
    // A dot or a space would split `{{ steps.<key>.… }}` and the token
    // would silently resolve to nothing.
    expect(uniqueStepKey('Look Up Order!', new Set())).toBe('look_up_order');
  });

  it('suffixes rather than colliding', () => {
    const taken = new Set(['http_request']);
    expect(uniqueStepKey('http_request', taken)).toBe('http_request_2');
  });

  it('gives every new step a free key', () => {
    const taken = new Set<string>();
    const a = blankStep('send_message', taken);
    taken.add(a.key);
    const b = blankStep('send_message', taken);
    expect(a.key).not.toBe(b.key);
  });

  it('gives a branching step its branches and a plain step none', () => {
    expect(blankStep('condition', new Set()).branches).toEqual({ yes: [], no: [] });
    expect(blankStep('random_split', new Set()).branches).toEqual({ yes: [], no: [] });
    expect(blankStep('send_message', new Set()).branches).toBeUndefined();
  });
});

describe('traversal', () => {
  it('flattens in document order with scopes', () => {
    expect(flattenSteps(sampleTree()).map((f) => f.step.key)).toEqual([
      'greet',
      'check',
      'tag_vip',
      'leave_note',
      'wrap_up',
    ]);
  });

  it('reports the scope a branch child lives in', () => {
    const found = findStep(sampleTree(), 'leave_note');
    expect(found?.scope).toEqual({
      kind: 'branch',
      parentKey: 'check',
      branch: 'no',
    });
  });
});

describe('edges', () => {
  it('anchors the first step to the trigger', () => {
    const edges = deriveEdges(sampleTree());
    expect(edges[0]).toMatchObject({ source: '__trigger__', target: 'greet' });
  });

  it('labels each branch and marks the rejoin dashed', () => {
    const edges = deriveEdges(sampleTree());
    expect(
      edges.find((e) => e.sourceHandle === 'yes' && e.target === 'tag_vip'),
    ).toMatchObject({ label: 'Yes' });
    expect(
      edges.find((e) => e.sourceHandle === 'no' && e.target === 'leave_note'),
    ).toMatchObject({ label: 'No' });
    // After a branch, execution returns to the parent sequence. Without
    // this edge a condition looks like the end of the automation, which
    // is what made people duplicate their follow-up into both branches.
    expect(
      edges.find((e) => e.source === 'check' && e.target === 'wrap_up'),
    ).toMatchObject({ dashed: true });
  });

  it('never emits a self-edge for a one-step branch', () => {
    const edges = deriveEdges(sampleTree());
    expect(edges.some((e) => e.source === e.target)).toBe(false);
  });
});

describe('connect = move', () => {
  it('moves a step to run directly after the source', () => {
    const next = connectSteps(sampleTree(), 'greet', 'next', 'wrap_up');
    expect(next.map((s) => s.key)).toEqual(['greet', 'wrap_up', 'check']);
  });

  it('moves a step into a branch when dropped on a branch port', () => {
    const next = connectSteps(sampleTree(), 'check', 'yes', 'wrap_up');
    const check = next.find((s) => s.key === 'check');
    expect(check?.branches?.yes.map((s) => s.key)).toEqual(['wrap_up', 'tag_vip']);
    expect(next.map((s) => s.key)).toEqual(['greet', 'check']);
  });

  it('refuses to move a step inside its own subtree', () => {
    // Would detach the subtree the source lives in and reattach it
    // inside itself, orphaning everything below.
    const tree = sampleTree();
    expect(connectSteps(tree, 'tag_vip', 'next', 'check')).toEqual(tree);
  });

  it('refuses a self-connection', () => {
    const tree = sampleTree();
    expect(connectSteps(tree, 'greet', 'next', 'greet')).toEqual(tree);
  });
});

describe('remove', () => {
  it('takes branch children with it', () => {
    // Splicing them into the parent sequence would promote steps written
    // to run conditionally into unconditional ones — how a discount code
    // gets sent to everybody.
    const next = removeStep(sampleTree(), 'check');
    expect(flattenSteps(next).map((f) => f.step.key)).toEqual([
      'greet',
      'wrap_up',
    ]);
  });
});

describe('duplicate', () => {
  it('copies the subtree under fresh keys, next to the original', () => {
    const { steps: next, newKey } = duplicateStep(sampleTree(), 'check');
    const keys = next.map((s) => s.key);
    expect(keys).toEqual(['greet', 'check', newKey, 'wrap_up']);
    const copy = next.find((s) => s.key === newKey);
    expect(copy?.branches?.yes[0].key).not.toBe('tag_vip');
    // Every key in the tree stays unique, or a token would address two
    // steps at once.
    expect(allKeys(next).size).toBe(flattenSteps(next).length);
  });
});

describe('serialisation', () => {
  it('round-trips through the API shape', () => {
    const api = toApiSteps(sampleTree());
    expect(api[1].branches?.yes[0].key).toBe('tag_vip');
    const back = fromServerSteps(
      api.map((s) => ({
        id: 'x',
        key: s.key,
        step_type: s.step_type,
        step_config: s.step_config,
        branches: s.branches
          ? {
              yes: s.branches.yes.map((b) => ({
                id: 'y',
                key: b.key,
                step_type: b.step_type,
                step_config: b.step_config,
              })),
              no: s.branches.no.map((b) => ({
                id: 'z',
                key: b.key,
                step_type: b.step_type,
                step_config: b.step_config,
              })),
            }
          : undefined,
      })),
    );
    expect(flattenSteps(back).map((f) => f.step.key)).toEqual([
      'greet',
      'check',
      'tag_vip',
      'leave_note',
      'wrap_up',
    ]);
  });

  it('mints a key for a row saved before migration 080', () => {
    // The canvas addresses nodes by key; a node with no id cannot be
    // rendered, selected or deleted.
    const back = fromServerSteps([
      { id: 'a', step_type: 'send_message', step_config: {} },
      { id: 'b', step_type: 'send_message', step_config: {} },
    ]);
    expect(back[0].key).toBeTruthy();
    expect(back[0].key).not.toBe(back[1].key);
  });
});

describe('available data', () => {
  it('offers earlier steps only', () => {
    const before = precedingSteps(sampleTree(), 'wrap_up').map((p) => p.step.key);
    expect(before).toContain('greet');
    expect(before).toContain('check');
  });

  it('never offers the opposite branch', () => {
    // A step in `no` can never read a step from `yes` — they are
    // mutually exclusive, so offering it would offer a guaranteed empty
    // string.
    const before = precedingSteps(sampleTree(), 'leave_note').map(
      (p) => p.step.key,
    );
    expect(before).toContain('greet');
    expect(before).toContain('check');
    expect(before).not.toContain('tag_vip');
  });

  it('does not offer a step its own output or anything downstream', () => {
    const before = precedingSteps(sampleTree(), 'greet').map((p) => p.step.key);
    expect(before).toEqual([]);
  });

  it('groups an HTTP step’s outputs under its reference name', () => {
    const steps = [
      step('lookup', 'http_request'),
      step('reply', 'send_message'),
    ];
    const groups = tokensFor(steps, 'reply', 'keyword_match');
    const stepGroup = groups.find((g) => g.id === 'step:lookup');
    expect(stepGroup?.options.map((o) => o.path)).toContain(
      'steps.lookup.body',
    );
    expect(stepGroup?.options.map((o) => o.path)).toContain(
      'steps.lookup.status',
    );
  });

  it('narrows trigger tokens to the trigger in use', () => {
    const formTokens = tokensFor([], null, 'form_submitted')
      .find((g) => g.id === 'trigger')
      ?.options.map((o) => o.path);
    expect(formTokens).toContain('trigger.submission_id');
    // Offering {{ trigger.form_id }} on a keyword automation would be
    // offering an empty string, and a picker listing impossible options
    // teaches people not to trust it.
    const keywordTokens = tokensFor([], null, 'keyword_match')
      .find((g) => g.id === 'trigger')
      ?.options.map((o) => o.path);
    expect(keywordTokens).not.toContain('trigger.submission_id');
    expect(keywordTokens).toContain('message.text');
  });
});

describe('insert', () => {
  it('adds into a named branch', () => {
    const next = insertStep(
      sampleTree(),
      { kind: 'branch', parentKey: 'check', branch: 'yes' },
      1,
      step('later', 'add_note'),
    );
    const check = next.find((s) => s.key === 'check');
    expect(check?.branches?.yes.map((s) => s.key)).toEqual(['tag_vip', 'later']);
  });
});
