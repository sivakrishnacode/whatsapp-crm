import { describe, expect, it } from 'vitest';

import {
  DRAFTABLE_NODE_TYPES,
  buildFlowDraftPrompt,
  normalizeFlowPrompt,
  parseFlowDraft,
} from './flow-draft';

/**
 * `parseFlowDraft` is the trust boundary: everything it returns is
 * rendered in the builder and, once a human saves, run at customers.
 * These pin the repairs — each of them turns a plausible model mistake
 * into something an author can see and fix, rather than a flow that
 * saves and then behaves nothing like the sentence that asked for it.
 */

const json = (obj: unknown) => JSON.stringify(obj);

describe('parseFlowDraft — the trust boundary', () => {
  it('keeps a well-formed draft intact', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Welcome',
        description: 'Greets and routes',
        trigger_type: 'keyword',
        trigger_config: { keywords: ['Hi', ' HELLO '], match_type: 'exact' },
        entry_node_key: 'greeting',
        nodes: [
          {
            node_key: 'greeting',
            node_type: 'send_message',
            config: { text: 'Hi there!' },
            next_node_key: 'done',
          },
          { node_key: 'done', node_type: 'end', config: {} },
        ],
        notes: ['Assumed English.'],
      }),
    );

    expect(draft.name).toBe('Welcome');
    expect(draft.entry_node_key).toBe('greeting');
    expect(draft.nodes).toHaveLength(2);
    expect(draft.nodes[0].config.next_node_key).toBe('done');
    // Keywords are lower-cased and trimmed — the matcher is
    // case-insensitive and a stray space would never match.
    expect(draft.trigger_config).toEqual({
      keywords: ['hi', 'hello'],
      match_type: 'exact',
    });
    expect(draft.notes).toContain('Assumed English.');
  });

  it('blanks an edge pointing at a node that does not exist, and says so', () => {
    // The most likely model mistake on a graph: wiring to a node it
    // described in prose but never emitted.
    const draft = parseFlowDraft(
      json({
        name: 'Broken',
        trigger_type: 'keyword',
        entry_node_key: 'a',
        nodes: [
          {
            node_key: 'a',
            node_type: 'send_message',
            config: { text: 'Hi' },
            next_node_key: 'nowhere',
          },
        ],
      }),
    );

    expect(draft.nodes[0].config.next_node_key).toBe('');
    expect(draft.notes.join(' ')).toMatch(/not in the draft/i);
  });

  it('renames duplicate node keys rather than losing a node', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Dupes',
        trigger_type: 'keyword',
        entry_node_key: 'ask',
        nodes: [
          { node_key: 'ask', node_type: 'send_message', config: { text: 'A' } },
          { node_key: 'ask', node_type: 'send_message', config: { text: 'B' } },
        ],
      }),
    );

    expect(draft.nodes).toHaveLength(2);
    expect(draft.nodes.map((n) => n.node_key)).toEqual(['ask', 'ask_2']);
  });

  it('never lets the model supply an id', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Tagger',
        trigger_type: 'keyword',
        entry_node_key: 'tag',
        nodes: [
          {
            node_key: 'tag',
            node_type: 'set_tag',
            config: {
              mode: 'add',
              // A plausible-looking uuid is the worst thing it could
              // return: it would save, and tag nothing.
              tag_id: '3f8b1e2a-0000-4000-8000-000000000000',
            },
          },
        ],
      }),
    );

    expect(draft.nodes[0].config.tag_id).toBe('');
    expect(draft.needs).toContain('a tag');
  });

  it('drops config keys the node type does not declare', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Extra',
        trigger_type: 'keyword',
        entry_node_key: 'msg',
        nodes: [
          {
            node_key: 'msg',
            node_type: 'send_message',
            config: { text: 'Hi', rm: '-rf', account_id: 'someone-else' },
          },
        ],
      }),
    );

    expect(Object.keys(draft.nodes[0].config).sort()).toEqual([
      'next_node_key',
      'text',
    ]);
  });

  it('skips a node type flows do not have, and notes it', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Unknown',
        trigger_type: 'keyword',
        entry_node_key: 'ok',
        nodes: [
          { node_key: 'ok', node_type: 'send_message', config: { text: 'Hi' } },
          { node_key: 'nope', node_type: 'send_email', config: {} },
        ],
      }),
    );

    expect(draft.nodes).toHaveLength(1);
    expect(draft.notes.join(' ')).toMatch(/no such step/i);
  });

  it('caps buttons at 3 and truncates titles to what WhatsApp accepts', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Menu',
        trigger_type: 'keyword',
        entry_node_key: 'menu',
        nodes: [
          {
            node_key: 'menu',
            node_type: 'send_buttons',
            config: {
              text: 'Pick one',
              buttons: [
                { reply_id: 'a', title: 'A'.repeat(40), next_node_key: 'menu' },
                { reply_id: 'b', title: 'B', next_node_key: 'menu' },
                { reply_id: 'c', title: 'C', next_node_key: 'menu' },
                { reply_id: 'd', title: 'D', next_node_key: 'menu' },
              ],
            },
          },
        ],
      }),
    );

    const buttons = draft.nodes[0].config.buttons as Array<{ title: string }>;
    expect(buttons).toHaveLength(3);
    expect(buttons[0].title).toHaveLength(20);
  });

  it('caps list rows at 10 ACROSS sections, not per section', () => {
    const row = (i: number) => ({
      reply_id: `r${i}`,
      title: `Row ${i}`,
      next_node_key: 'menu',
    });
    const draft = parseFlowDraft(
      json({
        name: 'List',
        trigger_type: 'keyword',
        entry_node_key: 'menu',
        nodes: [
          {
            node_key: 'menu',
            node_type: 'send_list',
            config: {
              text: 'Pick',
              button_label: 'Open',
              sections: [
                {
                  title: 'One',
                  rows: Array.from({ length: 8 }, (_, i) => row(i)),
                },
                {
                  title: 'Two',
                  rows: Array.from({ length: 8 }, (_, i) => row(i + 8)),
                },
              ],
            },
          },
        ],
      }),
    );

    const sections = draft.nodes[0].config.sections as Array<{
      rows: unknown[];
    }>;
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    expect(total).toBe(10);
  });

  it('falls back to the first node when the entry names nothing real', () => {
    const draft = parseFlowDraft(
      json({
        name: 'No entry',
        trigger_type: 'keyword',
        entry_node_key: 'ghost',
        nodes: [
          {
            node_key: 'real',
            node_type: 'send_message',
            config: { text: 'Hi' },
          },
        ],
      }),
    );

    expect(draft.entry_node_key).toBe('real');
    expect(draft.notes.join(' ')).toMatch(/starts at the first node/i);
  });

  it('falls back to the keyword trigger when the model invents one', () => {
    const draft = parseFlowDraft(
      json({
        name: 'Bad trigger',
        trigger_type: 'when_the_moon_is_full',
        entry_node_key: 'a',
        nodes: [
          { node_key: 'a', node_type: 'send_message', config: { text: 'Hi' } },
        ],
      }),
    );

    expect(draft.trigger_type).toBe('keyword');
    expect(draft.notes.join(' ')).toMatch(/not one flows support/i);
  });

  it('reads a fenced JSON response', () => {
    const draft = parseFlowDraft(
      '```json\n' +
        json({
          name: 'Fenced',
          trigger_type: 'keyword',
          entry_node_key: 'a',
          nodes: [{ node_key: 'a', node_type: 'end', config: {} }],
        }) +
        '\n```',
    );
    expect(draft.name).toBe('Fenced');
  });

  it('rejects a response that is not a flow at all', () => {
    expect(() => parseFlowDraft('I cannot help with that.')).toThrow();
  });
});

describe('buildFlowDraftPrompt', () => {
  it('documents every node type the parser accepts', () => {
    const prompt = buildFlowDraftPrompt();
    for (const type of DRAFTABLE_NODE_TYPES) {
      expect(prompt, `"${type}" must be described to the model`).toContain(
        `"${type}"`,
      );
    }
  });

  it('does not offer `start` — entry_node_key already says where it begins', () => {
    expect(DRAFTABLE_NODE_TYPES).not.toContain('start');
  });
});

describe('normalizeFlowPrompt', () => {
  it('refuses an empty prompt', () => {
    expect(() => normalizeFlowPrompt('   ')).toThrow();
    expect(() => normalizeFlowPrompt(undefined)).toThrow();
  });

  it('caps a very long prompt', () => {
    expect(normalizeFlowPrompt('x'.repeat(5000))).toHaveLength(2000);
  });
});
