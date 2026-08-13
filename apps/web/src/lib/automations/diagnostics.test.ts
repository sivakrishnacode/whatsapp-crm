import { describe, expect, it } from 'vitest';
import { runDiagnostics, type DiagnosticsInput } from './diagnostics';
import { stepAvailability } from './availability';
import type { BuilderStep } from './graph';
import type { AutomationStepType } from '@/types';

function step(
  key: string,
  type: AutomationStepType,
  config: Record<string, unknown> = {},
  branches?: { yes: BuilderStep[]; no: BuilderStep[] },
): BuilderStep {
  return { key, step_type: type, step_config: config, branches };
}

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    steps: [],
    triggerType: 'keyword_match',
    triggerConfig: { keywords: ['hi'] },
    channels: [],
    isActive: true,
    ...over,
  };
}

const titles = (d: ReturnType<typeof runDiagnostics>) => d.map((x) => x.title);

describe('channel availability', () => {
  it('flags a template on an Instagram-only automation', () => {
    // The reported bug: Instagram has no template mechanism at all, and
    // the engine SKIPS the step silently, so the automation looks fine
    // and sends nothing.
    const found = runDiagnostics(
      input({
        channels: ['instagram'],
        steps: [step('send_template', 'send_template', { template_name: 'x' })],
      }),
    );
    expect(found.some((d) => d.level === 'error' && /never run/i.test(d.title))).toBe(
      true,
    );
  });

  it('treats the same step as a partial skip on a mixed-channel automation', () => {
    // Sending a template on WhatsApp and plain text on Instagram from one
    // automation is legitimate — it is why the channel condition exists.
    const availability = stepAvailability(
      'send_template',
      ['whatsapp', 'instagram'],
      'keyword_match',
    );
    expect(availability.status).toBe('partial');
    expect(availability.unsupported).toEqual(['instagram']);
  });

  it('allows a template when no channels are set', () => {
    // Empty means every channel, so WhatsApp can trigger it.
    expect(
      stepAvailability('send_template', [], 'keyword_match').status,
    ).toBe('ok');
  });

  it('flags a list message on Instagram but not buttons', () => {
    expect(
      stepAvailability('send_list', ['instagram'], 'keyword_match').status,
    ).toBe('never');
    // Instagram quick replies are a genuine equivalent, not a downgrade.
    expect(
      stepAvailability('send_buttons', ['instagram'], 'keyword_match').status,
    ).toBe('ok');
  });
});

describe('trigger capability', () => {
  it('flags contact steps in a scheduled automation', () => {
    const found = runDiagnostics(
      input({
        triggerType: 'time_based',
        triggerConfig: { schedule: '09:00' },
        steps: [step('add_tag', 'add_tag', { tag_id: 't1' })],
      }),
    );
    expect(found.some((d) => d.level === 'error')).toBe(true);
  });

  it('warns that sends may be skipped on a form trigger', () => {
    const found = runDiagnostics(
      input({
        triggerType: 'form_submitted',
        triggerConfig: {},
        steps: [step('send_message', 'send_message', { text: 'hi' })],
      }),
    );
    expect(found.some((d) => d.level === 'warning')).toBe(true);
  });

  it('flags a keyword trigger with no keywords', () => {
    const found = runDiagnostics(
      input({
        triggerConfig: {},
        steps: [step('send_message', 'send_message', { text: 'hi' })],
      }),
    );
    expect(titles(found)).toContain('No keywords set');
  });
});

describe('token references', () => {
  it('flags a token pointing at a step that does not exist', () => {
    // Resolves to an empty string at run time: the message still sends,
    // with a hole in it.
    const found = runDiagnostics(
      input({
        steps: [
          step('send_message', 'send_message', {
            text: 'Your order {{ steps.lookup.body.id }}',
          }),
        ],
      }),
    );
    expect(titles(found)).toContain('No step called “lookup”');
  });

  it('flags a token pointing at a LATER step', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('greet', 'send_message', { text: '{{ steps.lookup.status }}' }),
          step('lookup', 'http_request', { url: 'https://a.test' }),
        ],
      }),
    );
    expect(titles(found)).toContain('“lookup” has not run yet');
  });

  it('flags a token reaching across a branch', () => {
    // The two branches are mutually exclusive, so this can only ever be
    // empty.
    const found = runDiagnostics(
      input({
        steps: [
          step('check', 'condition', { rules: [{ subject: 'channel', value: 'whatsapp' }] }, {
            yes: [step('lookup', 'http_request', { url: 'https://a.test' })],
            no: [
              step('reply', 'send_message', {
                text: '{{ steps.lookup.status }}',
              }),
            ],
          }),
        ],
      }),
    );
    expect(titles(found)).toContain('“lookup” has not run yet');
  });

  it('accepts a token from a genuinely earlier step', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('lookup', 'http_request', { url: 'https://a.test' }),
          step('reply', 'send_message', {
            text: 'Status {{ steps.lookup.status }}',
          }),
        ],
      }),
    );
    expect(found.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('warns about a variable nothing writes', () => {
    const found = runDiagnostics(
      input({
        steps: [step('reply', 'send_message', { text: 'Hi {{ vars.tier }}' })],
      }),
    );
    expect(titles(found)).toContain('Nothing sets “tier”');
  });

  it('accepts a variable a Set variable step writes', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('set_variable', 'set_variable', { name: 'tier', value: 'gold' }),
          step('reply', 'send_message', { text: 'Hi {{ vars.tier }}' }),
        ],
      }),
    );
    expect(found.filter((d) => d.level !== 'info')).toEqual([]);
  });

  it('accepts a variable written by save_as on any step', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('lookup', 'http_request', {
            url: 'https://a.test',
            save_as: 'order',
          }),
          step('reply', 'send_message', { text: '{{ vars.order.id }}' }),
        ],
      }),
    );
    expect(found.some((d) => /Nothing sets/.test(d.title))).toBe(false);
  });

  it('flags an unfinished token', () => {
    const found = runDiagnostics(
      input({
        steps: [step('reply', 'send_message', { text: 'Hi {{ contact.name' })],
      }),
    );
    expect(titles(found)).toContain('Unfinished token');
  });

  it('ignores filters when resolving the path', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('reply', 'send_message', {
            text: 'Hi {{ contact.name | default: "there" }}',
          }),
        ],
      }),
    );
    expect(found.filter((d) => d.level === 'error')).toEqual([]);
  });
});

describe('WhatsApp 24-hour window', () => {
  it('flags a plain message after a two-day wait', () => {
    // The single most common automation shape, and it silently stops
    // delivering on WhatsApp.
    const found = runDiagnostics(
      input({
        channels: ['whatsapp'],
        steps: [
          step('wait', 'wait', { amount: 2, unit: 'days' }),
          step('follow_up', 'send_message', { text: 'Still interested?' }),
        ],
      }),
    );
    expect(titles(found)).toContain('Outside WhatsApp’s 24-hour window');
  });

  it('does not flag a template after the same wait', () => {
    // A template is exactly the right answer outside the window.
    const found = runDiagnostics(
      input({
        channels: ['whatsapp'],
        steps: [
          step('wait', 'wait', { amount: 2, unit: 'days' }),
          step('follow_up', 'send_template', { template_name: 'nudge' }),
        ],
      }),
    );
    expect(titles(found)).not.toContain('Outside WhatsApp’s 24-hour window');
  });

  it('does not flag a short wait', () => {
    const found = runDiagnostics(
      input({
        channels: ['whatsapp'],
        steps: [
          step('wait', 'wait', { amount: 2, unit: 'hours' }),
          step('follow_up', 'send_message', { text: 'hi' }),
        ],
      }),
    );
    expect(titles(found)).not.toContain('Outside WhatsApp’s 24-hour window');
  });

  it('sums waits along the branch a step is in', () => {
    const found = runDiagnostics(
      input({
        channels: ['whatsapp'],
        steps: [
          step('w1', 'wait', { amount: 20, unit: 'hours' }),
          step('check', 'condition', { rules: [{ subject: 'channel', value: 'whatsapp' }] }, {
            yes: [
              step('w2', 'wait', { amount: 10, unit: 'hours' }),
              step('late', 'send_message', { text: 'hi' }),
            ],
            no: [],
          }),
        ],
      }),
    );
    expect(found.some((d) => d.stepKey === 'late')).toBe(true);
  });
});

describe('step-specific traps', () => {
  it('flags a dynamic segment in an add-to-segment step', () => {
    const found = runDiagnostics(
      input({
        steps: [step('add_to_segment', 'add_to_segment', { segment_id: 's1' })],
        segments: [{ id: 's1', name: 'Lapsed', kind: 'dynamic' }],
      }),
    );
    expect(titles(found)).toContain('“Lapsed” is a filter segment');
  });

  it('flags a draft flow in a start-flow step', () => {
    const found = runDiagnostics(
      input({
        steps: [step('start_flow', 'start_flow', { flow_id: 'f1' })],
        flows: [{ id: 'f1', name: 'Onboarding', status: 'draft' }],
      }),
    );
    expect(titles(found)).toContain('“Onboarding” is not active');
  });

  it('flags an automation that runs itself', () => {
    const found = runDiagnostics(
      input({
        currentAutomationId: 'a1',
        steps: [step('run_automation', 'run_automation', { automation_id: 'a1' })],
      }),
    );
    expect(titles(found)).toContain('This automation runs itself');
  });

  it('flags an internal URL the SSRF guard will refuse', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('http_request', 'http_request', {
            url: 'http://192.168.1.10/hook',
          }),
        ],
      }),
    );
    expect(titles(found)).toContain(
      'That address is not reachable from the server',
    );
  });

  it('warns about plain HTTP', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('http_request', 'http_request', { url: 'http://example.test/h' }),
        ],
      }),
    );
    expect(titles(found)).toContain('Unencrypted request');
  });

  it('warns when a send follows a close', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('close', 'close_conversation'),
          step('after', 'send_message', { text: 'one more thing' }),
        ],
      }),
    );
    expect(titles(found)).toContain('Sends after closing the conversation');
  });

  it('warns about a condition with two empty branches', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('check', 'condition', { rules: [{ subject: 'channel', value: 'whatsapp' }] }, {
            yes: [],
            no: [],
          }),
        ],
      }),
    );
    expect(titles(found)).toContain('Both branches are empty');
  });

  it('flags two steps sharing a reference name', () => {
    const found = runDiagnostics(
      input({
        steps: [
          step('dupe', 'send_message', { text: 'a' }),
          step('dupe', 'send_message', { text: 'b' }),
        ],
      }),
    );
    expect(found.some((d) => /both called/.test(d.title))).toBe(true);
  });

  it('flags an automation with no steps', () => {
    expect(titles(runDiagnostics(input({ steps: [] })))).toContain(
      'This automation does nothing',
    );
  });
});

describe('a well-formed automation', () => {
  it('reports nothing above info level', () => {
    const found = runDiagnostics(
      input({
        channels: ['whatsapp'],
        steps: [
          step('lookup', 'http_request', {
            url: 'https://api.example.test/orders',
            save_as: 'order',
          }),
          step('reply', 'send_message', {
            text: 'Hi {{ contact.name }}, order {{ steps.lookup.body.id }} is on its way.',
          }),
          step('tag', 'add_tag', { tag_id: 'tag-1' }),
        ],
      }),
    );
    expect(found.filter((d) => d.level !== 'info')).toEqual([]);
  });
});
