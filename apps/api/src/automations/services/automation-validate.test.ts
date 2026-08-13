import { describe, expect, it } from 'vitest';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './automation-validate';

describe('validateStepsForActivation', () => {
  it('rejects empty or missing step lists', () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: 'steps', message: 'active automations need at least one step' },
    ]);
    expect(validateStepsForActivation(undefined as unknown as never[])).toEqual(
      [{ path: 'steps', message: 'active automations need at least one step' }],
    );
  });

  it('passes a fully-populated step set', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: 'hi' } },
      {
        step_type: 'wait',
        step_config: { amount: 5, unit: 'minutes' },
      },
      { step_type: 'add_tag', step_config: { tag_id: 'tag-uuid' } },
      { step_type: 'close_conversation', step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags every required field that is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: '  ' } },
      { step_type: 'send_template', step_config: {} },
      { step_type: 'add_tag', step_config: { tag_id: '' } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].text',
      'steps[1].template_name',
      'steps[2].tag_id',
    ]);
  });

  it('checks wait amount and unit boundaries', () => {
    const issues = validateStepsForActivation([
      { step_type: 'wait', step_config: { amount: 0, unit: 'minutes' } },
      { step_type: 'wait', step_config: { amount: 5, unit: 'seconds' } },
      { step_type: 'wait', step_config: { amount: -1, unit: 'hours' } },
      {
        step_type: 'wait',
        step_config: { amount: Number.POSITIVE_INFINITY, unit: 'days' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].amount',
      'steps[1].unit',
      'steps[2].amount',
      'steps[3].amount',
    ]);
  });

  it('validates webhook URLs', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'https://hooks.example.com/in' },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: {} },
    ]);
    // Wording is shared with `http_request` now that both run the same
    // validator, so it no longer says "webhook".
    expect(noUrl.map((i) => i.message)).toContain('a URL is required');

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'ftp://files.example.com' },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      'the URL must use http or https',
    );

    const garbage = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: { url: 'not a url' } },
    ]);
    expect(garbage.map((i) => i.message)).toContain('that is not a valid URL');
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: 'assign_conversation', step_config: { mode: 'specific' } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      'steps[0].agent_id',
    ]);
  });

  it('flags create_deal when required fields are missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'create_deal', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].pipeline_id',
      'steps[0].stage_id',
      'steps[0].title',
    ]);
  });

  it('flags update_contact_field when field or value is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'update_contact_field', step_config: { field: 'name' } },
      {
        step_type: 'update_contact_field',
        step_config: { field: '', value: 'x' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].value',
      'steps[1].field',
    ]);
  });

  it('recursively walks condition branches with stable dot-paths', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: { subject: 'tag', operand: 'vip' },
        branches: {
          yes: [{ step_type: 'add_tag', step_config: { tag_id: '' } }],
          no: [
            {
              step_type: 'send_message',
              step_config: { text: '' },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].yes.steps[0].tag_id',
      'steps[0].no.steps[0].text',
    ]);
  });

  it('reports an issue for unknown step types', () => {
    const issues = validateStepsForActivation([
      { step_type: 'do_a_barrel_roll', step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: 'steps[0]', message: 'unknown step type: do_a_barrel_roll' },
    ]);
  });

  it('asks for a rule when a condition is empty', () => {
    // An empty condition reports ONE issue, not two. It used to flag the
    // missing subject and the missing operand separately, which read as
    // two problems when there is only one: the condition has no rules.
    const issues = validateStepsForActivation([
      { step_type: 'condition', step_config: {} },
    ]);
    expect(issues).toEqual([
      {
        path: 'steps[0].subject',
        message: 'add at least one rule to this condition',
      },
    ]);
  });

  it('validates each rule of a multi-rule condition', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          match: 'all',
          rules: [
            { subject: 'tag_presence', operand: 'tag-1' },
            // No operand — nothing to look at.
            { subject: 'contact_field' },
            // `channel` reads its comparison from `value`, so a missing
            // operand is correct here and must NOT be flagged.
            { subject: 'channel', value: 'whatsapp' },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].rules[1].operand']);
  });

  it('still accepts the legacy single-rule condition shape', () => {
    // Every condition written before rules[] existed has this shape and
    // must keep activating — these rows are live.
    expect(
      validateStepsForActivation([
        {
          step_type: 'condition',
          step_config: { subject: 'tag_presence', operand: 'tag-1' },
        },
      ]),
    ).toEqual([]);
  });

  it('skips URL shape checks when the URL is built from tokens', () => {
    // `{{ vars.endpoint }}/orders` is not parseable until run time. The
    // SSRF guard still checks the resolved value, which is the check
    // that matters.
    expect(
      validateStepsForActivation([
        {
          step_type: 'http_request',
          step_config: { url: '{{ vars.endpoint }}/orders' },
        },
      ]),
    ).toEqual([]);
  });

  it('catches malformed JSON in a raw webhook body', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'http_request',
        step_config: {
          url: 'https://example.test/hook',
          body_mode: 'raw',
          body_template: '{"a": 1,}',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].body_template']);
  });

  it('enforces WhatsApp interactive limits at save time', () => {
    // Meta rejects the whole send for a 4th button, so catching it here
    // is the difference between a form error and a dead automation.
    const issues = validateStepsForActivation([
      {
        step_type: 'send_buttons',
        step_config: {
          body_text: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.message)).toEqual([
      'WhatsApp allows at most 3 buttons',
    ]);
  });
});

describe('validateTriggerForActivation', () => {
  it('accepts a valid keyword_match config', () => {
    expect(
      validateTriggerForActivation('keyword_match', {
        keywords: ['hello', 'hi'],
        match_type: 'exact',
      }),
    ).toEqual([]);
  });

  it('rejects keyword_match with empty keyword array', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: [],
      match_type: 'exact',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.keywords');
  });

  it('rejects keyword_match with whitespace-only entries', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi', '   '],
      match_type: 'contains',
    });
    expect(issues.map((i) => i.message)).toContain(
      'keywords cannot be empty strings',
    );
  });

  it('rejects keyword_match with an unknown match_type', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi'],
      match_type: 'fuzzy',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.match_type');
  });

  it('accepts keyword_match with a missing match_type (defaults to contains)', () => {
    expect(
      validateTriggerForActivation('keyword_match', { keywords: ['hi'] }),
    ).toEqual([]);
  });

  it('requires schedule on time_based triggers', () => {
    expect(validateTriggerForActivation('time_based', {})).toEqual([
      { path: 'trigger.schedule', message: 'schedule is required' },
    ]);
    expect(
      validateTriggerForActivation('time_based', { schedule: '0 9 * * *' }),
    ).toEqual([]);
  });

  it('requires tag_id on tag_added triggers', () => {
    expect(validateTriggerForActivation('tag_added', {})).toEqual([
      { path: 'trigger.tag_id', message: 'tag is required' },
    ]);
    expect(
      validateTriggerForActivation('tag_added', { tag_id: 'tag-uuid' }),
    ).toEqual([]);
  });

  it('does not flag unknown trigger types (handled elsewhere)', () => {
    expect(validateTriggerForActivation('some_future_trigger', {})).toEqual([]);
  });
});
