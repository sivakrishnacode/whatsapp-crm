import { describe, expect, it, vi } from 'vitest';
import { AutomationStepExecutorService } from './automation-step-executor.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * `{{ contact.* }}` must resolve in EVERY step type, not just templates.
 *
 * THE BUG THIS PINS
 *   `context.contact` is populated on demand, and for a long time the
 *   only step that remembered to ask for it was `send_template`. Every
 *   other step resolved `{{ contact.name }}` to an empty string —
 *   because that is what the engine does with an unresolvable token, by
 *   design.
 *
 *   It shipped and was found in production: a Google Sheets "Append row"
 *   step wrote a BLANK row and reported success, because the value it
 *   was given was `""`. Nothing failed. The log said "Appended row 2",
 *   Google agreed, and the spreadsheet looked untouched.
 *
 *   That is the shape of every bug in this engine: silent. Hence a test
 *   rather than a comment.
 */

interface StepRow {
  id: string;
  key: string;
  stepType: string;
  position: number;
  stepConfig: Record<string, unknown>;
}

function sheetStep(
  over: Partial<StepRow> & { values?: Record<string, unknown> } = {},
): StepRow {
  const { values, ...rest } = over;
  return {
    id: 'step-1',
    key: 'append_row',
    stepType: 'app_action',
    position: 0,
    stepConfig: {
      app: 'google_sheets',
      action: 'append_row',
      connection_id: 'conn-1',
      input: {
        spreadsheet:
          'https://docs.google.com/spreadsheets/d/abc123def456ghi789/edit',
        tab: 'page1',
        values: values ?? { name: '{{ contact.name }}' },
      },
    },
    ...rest,
  };
}

function makeExecutor(
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    company: string | null;
  },
  steps: StepRow[] = [sheetStep()],
) {
  const findUnique = vi.fn().mockResolvedValue(contact);

  const prisma = {
    automationStep: {
      findMany: vi.fn().mockResolvedValue(steps),
    },
    contacts: { findUnique },
    automationLog: { update: vi.fn(), findUnique: vi.fn() },
  };

  const run = vi.fn().mockResolvedValue({
    output: { row_number: 2 },
    detail: 'Appended row 2 to page1',
  });

  const registry = {
    requireAction: () => ({
      id: 'append_row',
      label: 'Append row',
      scopes: [],
      inputs: [
        {
          key: 'spreadsheet',
          label: 'Spreadsheet',
          kind: 'text',
          tokens: false,
        },
        { key: 'tab', label: 'Tab', kind: 'resource_select', tokens: false },
        { key: 'values', label: 'Values', kind: 'key_values', tokens: true },
      ],
      outputs: [],
    }),
    require: () => ({ name: 'Google Sheets' }),
  };

  const executor = new AutomationStepExecutorService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    registry as never,
    { run } as never,
    { add: vi.fn() } as never,
  );

  return { executor, run, findUnique };
}

const ARGS = {
  automation: { id: 'a-1', accountId: 'acc-1', userId: 'u-1' },
  contactId: 'contact-1',
  context: {},
  parentStepId: null,
  branch: null,
  startPosition: 0,
  logId: null,
  triggerEvent: 'keyword_match',
};

describe('contact token hydration', () => {
  it('resolves {{ contact.name }} in an app_action step', async () => {
    const { executor, run } = makeExecutor({
      name: 'sivakrishna',
      phone: '+917810002624',
      email: null,
      company: null,
    });

    await executor.executeStepsFrom({ ...ARGS, context: {} } as never);

    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0][0] as {
      input: { values: Record<string, unknown> };
    };
    const input = call.input;
    // The regression: this was '' — a blank row, appended successfully.
    expect(input.values.name).toBe('sivakrishna');
  });

  it('looks the contact up ONCE even though several steps reference it', async () => {
    const { executor, findUnique, run } = makeExecutor(
      { name: 'sivakrishna', phone: null, email: null, company: null },
      // Two steps, both referencing contact tokens.
      [
        sheetStep(),
        sheetStep({ id: 'step-2', key: 'append_row_2', position: 1 }),
      ],
    );

    await executor.executeStepsFrom({ ...ARGS, context: {} } as never);

    expect(run).toHaveBeenCalledTimes(2);
    // On demand, but not once per step: withContactTokens short-circuits
    // as soon as context.contact is set, and the result is kept.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not query the contact when no step mentions one', async () => {
    const { executor, findUnique } = makeExecutor(
      { name: 'sivakrishna', phone: null, email: null, company: null },
      [sheetStep({ values: { note: 'no tokens here' } })],
    );

    await executor.executeStepsFrom({ ...ARGS, context: {} } as never);

    // The whole reason hydration is on demand: most runs never need it.
    expect(findUnique).not.toHaveBeenCalled();
  });
});
