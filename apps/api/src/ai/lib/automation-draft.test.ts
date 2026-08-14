import { describe, expect, it } from 'vitest';

import {
  DRAFTABLE_STEP_TYPES,
  DRAFTABLE_TRIGGER_TYPES,
  STEP_SPECS,
  buildAutomationDraftPrompt,
  extractJsonObject,
  normalizeDraftPrompt,
  parseAutomationDraft,
} from './automation-draft';

/** A minimal well-formed model response. */
function response(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Welcome',
    description: 'Greets new contacts.',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    channels: [],
    steps: [{ step_type: 'send_message', step_config: { text: 'Hi!' } }],
    notes: [],
    ...patch,
  });
}

describe('the prompt', () => {
  it('advertises every step type and trigger the parser accepts', () => {
    const prompt = buildAutomationDraftPrompt();
    for (const type of DRAFTABLE_STEP_TYPES) {
      expect(prompt).toContain(`"${type}"`);
    }
    for (const trigger of DRAFTABLE_TRIGGER_TYPES) {
      expect(prompt).toContain(`"${trigger}"`);
    }
  });

  it('never offers time_based — a schedule has no contact to act on', () => {
    expect(DRAFTABLE_TRIGGER_TYPES).not.toContain('time_based');
    expect(buildAutomationDraftPrompt()).not.toContain('time_based');
  });

  /**
   * `allow` is what we accept; `keys` is what we told the model. A key we
   * accept but never advertised is dead code, and a key we advertised but
   * drop produces a config the model thinks it set.
   */
  it('documents every key it accepts', () => {
    for (const [type, spec] of Object.entries(STEP_SPECS)) {
      for (const key of spec.allow) {
        expect(spec.keys, `${type}.${key}`).toContain(`"${key}"`);
      }
    }
  });
});

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads a fenced object, which models emit however firmly you ask', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads an object with a sentence in front of it', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('throws on an empty response rather than returning a null draft', () => {
    expect(() => extractJsonObject('   ')).toThrow();
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJsonObject('I cannot help with that.')).toThrow();
  });
});

describe('parseAutomationDraft — the trust boundary', () => {
  it('keeps a well-formed draft intact', () => {
    const draft = parseAutomationDraft(response());
    expect(draft.name).toBe('Welcome');
    expect(draft.trigger_type).toBe('first_inbound_message');
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0].step_config.text).toBe('Hi!');
  });

  it('DROPS a step type that does not exist rather than guessing', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          { step_type: 'send_email', step_config: { to: 'a@b.c' } },
          { step_type: 'send_message', step_config: { text: 'Hi!' } },
        ],
      }),
    );
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0].step_type).toBe('send_message');
  });

  it('DROPS config keys the step type never declared', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'send_message',
            step_config: { text: 'Hi!', webhook_url: 'https://evil.test' },
          },
        ],
      }),
    );
    expect(draft.steps[0].step_config).toEqual({ text: 'Hi!' });
  });

  // The single most important behaviour here: a fabricated uuid saves
  // cleanly and then silently never matches anything.
  it('BLANKS every id the model cannot possibly know', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'add_tag',
            step_config: { tag_id: '11111111-2222-3333-4444-555555555555' },
          },
          {
            step_type: 'create_deal',
            step_config: {
              pipeline_id: 'made-up',
              stage_id: 'also-made-up',
              title: 'New deal',
            },
          },
          {
            step_type: 'add_to_segment',
            step_config: { segment_id: 'nope' },
          },
        ],
      }),
    );
    expect(draft.steps[0].step_config.tag_id).toBe('');
    expect(draft.steps[1].step_config.pipeline_id).toBe('');
    expect(draft.steps[1].step_config.stage_id).toBe('');
    expect(draft.steps[1].step_config.title).toBe('New deal');
    expect(draft.steps[2].step_config.segment_id).toBe('');
    expect(draft.needs).toContain('a tag to add');
    expect(draft.needs).toContain('a pipeline and stage');
  });

  it('blanks a tag_presence operand inside a condition rule too', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'condition',
            step_config: {
              match: 'all',
              rules: [{ subject: 'tag_presence', operand: 'guessed-uuid' }],
            },
          },
        ],
      }),
    );
    const rules = draft.steps[0].step_config.rules as { operand: string }[];
    expect(rules[0].operand).toBe('');
  });

  it('falls back to a real trigger when the model invents one', () => {
    const draft = parseAutomationDraft(
      response({ trigger_type: 'customer_sneezed' }),
    );
    expect(draft.trigger_type).toBe('new_message_received');
    expect(draft.notes.join(' ')).toMatch(/not one this product has/i);
  });

  // A wait the executor reads as zero turns a considered follow-up into
  // an instant second message.
  it('coerces a non-numeric wait rather than passing NaN through', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          { step_type: 'wait', step_config: { amount: 'two', unit: 'weeks' } },
        ],
      }),
    );
    expect(draft.steps[0].step_config.amount).toBe(1);
    expect(draft.steps[0].step_config.unit).toBe('hours');
  });

  it("clamps buttons to WhatsApp's limit of three", () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'send_buttons',
            step_config: {
              body_text: 'Pick one',
              buttons: [1, 2, 3, 4, 5].map((n) => ({
                id: `b${n}`,
                title: `Option ${n}`,
              })),
            },
          },
        ],
      }),
    );
    expect(draft.steps[0].step_config.buttons).toHaveLength(3);
  });

  it('nests branch children under a condition', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'condition',
            step_config: {
              match: 'all',
              rules: [
                {
                  subject: 'message_content',
                  operator: 'contains',
                  value: 'refund',
                },
              ],
            },
            yes: [
              { step_type: 'send_message', step_config: { text: 'Sorry!' } },
            ],
            no: [],
          },
        ],
      }),
    );
    expect(draft.steps[0].branches?.yes).toHaveLength(1);
    expect(draft.steps[0].branches?.no).toHaveLength(0);
  });

  it('does not give branches to a step type that has none', () => {
    const draft = parseAutomationDraft(
      response({
        steps: [
          {
            step_type: 'send_message',
            step_config: { text: 'Hi' },
            yes: [{ step_type: 'send_message', step_config: { text: 'Nope' } }],
          },
        ],
      }),
    );
    expect(draft.steps[0].branches).toBeUndefined();
    expect(draft.steps).toHaveLength(1);
  });

  it('caps the number of steps', () => {
    const draft = parseAutomationDraft(
      response({
        steps: Array.from({ length: 80 }, () => ({
          step_type: 'send_message',
          step_config: { text: 'spam' },
        })),
      }),
    );
    expect(draft.steps.length).toBeLessThanOrEqual(24);
  });

  it('scopes a channel-locked trigger even when the model said otherwise', () => {
    const draft = parseAutomationDraft(
      response({ trigger_type: 'web_chat_started', channels: ['whatsapp'] }),
    );
    expect(draft.channels).toEqual(['web']);
  });

  it('drops channels that are not real channels', () => {
    const draft = parseAutomationDraft(
      response({ channels: ['whatsapp', 'telegram', 'sms'] }),
    );
    expect(draft.channels).toEqual(['whatsapp']);
  });

  // A keyword trigger with no keywords fires on nothing, and looks
  // identical to a working automation from the list page.
  it('reports an empty keyword list as something the human must fix', () => {
    const draft = parseAutomationDraft(
      response({
        trigger_type: 'keyword_match',
        trigger_config: { keywords: [], match_type: 'contains' },
      }),
    );
    expect(draft.needs).toContain('at least one trigger keyword');
  });

  it('normalises keywords and the match type', () => {
    const draft = parseAutomationDraft(
      response({
        trigger_type: 'keyword_match',
        trigger_config: {
          keywords: ['  Pricing ', '', 42],
          match_type: 'fuzzy',
        },
      }),
    );
    expect(draft.trigger_config).toEqual({
      keywords: ['pricing'],
      match_type: 'contains',
    });
  });

  it('survives a response with no steps at all', () => {
    const draft = parseAutomationDraft(
      response({ steps: [], notes: ['I can only build chat automations.'] }),
    );
    expect(draft.steps).toEqual([]);
    expect(draft.notes).toHaveLength(1);
  });

  it('throws when the payload is not an object', () => {
    expect(() => parseAutomationDraft('[1,2,3]')).toThrow();
  });
});

describe('normalizeDraftPrompt', () => {
  it('rejects an empty prompt', () => {
    expect(() => normalizeDraftPrompt('   ')).toThrow();
    expect(() => normalizeDraftPrompt(undefined)).toThrow();
  });

  it('truncates rather than refusing a long one', () => {
    expect(normalizeDraftPrompt('x'.repeat(9000))).toHaveLength(2000);
  });
});
