import { describe, expect, it, vi } from 'vitest';

import { GOOGLE_TOOLS, GOOGLE_TOOL_NAMES, WRITE_GOOGLE_TOOLS } from './google';
import type { BuiltinToolContext } from './builtin';
import { AGENT_SKILLS } from '../skills';

/**
 * The properties worth pinning are the ones whose failure is a privacy
 * leak, an unwanted write, or a model quietly inventing an answer — not
 * the plumbing.
 */

function ctx(
  run: BuiltinToolContext['googleScript'] extends infer T
    ? T extends { run: infer R }
      ? R
      : never
    : never,
  skills: Record<
    string,
    { enabled: boolean; config: Record<string, unknown> }
  > = {},
): BuiltinToolContext {
  return {
    prisma: {} as BuiltinToolContext['prisma'],
    accountId: 'acc-1',
    contactId: 'c-1',
    conversationId: 'conv-1',
    actorUserId: null,
    currency: 'INR',
    skills,
    googleScript: { run },
  };
}

describe('the Google toolset', () => {
  it("exposes nothing that reads the owner's content", () => {
    // ⚠️ The agent talks to a CUSTOMER. `find_events` returns event
    // TITLES and `sheet_find` returns other customers' rows; both would
    // be summarised to whoever asked. `check_availability` is the safe
    // read because it returns intervals and no content.
    for (const forbidden of ['find_events', 'sheet_find', 'sheet_update']) {
      expect(GOOGLE_TOOLS[forbidden]).toBeUndefined();
    }
    expect(GOOGLE_TOOLS.check_availability).toBeDefined();
  });

  it('exposes nothing destructive and nothing that emails', () => {
    for (const forbidden of [
      'delete_event',
      'update_event',
      'sheet_delete_row',
      'send_email',
    ]) {
      expect(GOOGLE_TOOLS[forbidden]).toBeUndefined();
    }
  });

  it('classifies every write tool, so the draft gate cannot miss one', () => {
    // A tool present here but absent from WRITE_GOOGLE_TOOLS executes for
    // real while a human is still deciding whether to send anything.
    const reads = ['check_availability'];
    for (const name of Object.keys(GOOGLE_TOOLS)) {
      if (reads.includes(name)) continue;
      expect(WRITE_GOOGLE_TOOLS).toContain(name);
    }
    expect(GOOGLE_TOOL_NAMES.sort()).toEqual(Object.keys(GOOGLE_TOOLS).sort());
  });

  it('never lets a model name the spreadsheet it writes to', () => {
    // The sheet is an ADMIN's choice. A model-supplied id would let a
    // prompt injection append to any sheet the owner can reach.
    const props =
      GOOGLE_TOOLS.log_to_sheet.definition.parameters.properties ?? {};
    expect(Object.keys(props)).toEqual(['values']);
  });

  it('refuses to log when no spreadsheet is configured, without calling out', async () => {
    const run = vi.fn();
    const result = await GOOGLE_TOOLS.log_to_sheet.run(
      { values: ['a'] },
      ctx(run),
    );
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no spreadsheet is configured/i);
  });

  it('reads the spreadsheet from skill config and books with Meet, silently', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ output: { row: 3 }, detail: 'Row 3 added' });
    await GOOGLE_TOOLS.log_to_sheet.run(
      { values: ['a', 'b'] },
      ctx(run, {
        google_workspace: {
          enabled: true,
          config: { spreadsheet_id: 'sheet-1', sheet_tab: 'Leads' },
        },
      }),
    );
    expect(run).toHaveBeenCalledWith('acc-1', 'sheet_append', {
      spreadsheet_id: 'sheet-1',
      tab: 'Leads',
      values: ['a', 'b'],
    });
  });

  it('books with a Meet link and no Google-sent invitation', async () => {
    const run = vi.fn().mockResolvedValue({
      output: { meeting_url: 'https://meet.google.com/x' },
      detail: 'ok',
    });
    await GOOGLE_TOOLS.book_meeting.run(
      { title: 'T', starts_at: 'A', ends_at: 'B' },
      ctx(run),
    );
    const [, action, input] = run.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(action).toBe('create_event');
    expect(input.add_meet).toBe(true);
    // The customer hears the time in chat. A Google invite as well is a
    // second, unexpected message from an address they never gave us.
    expect(input.notify).toBe('none');
  });

  it('tells the model not to guess when the bridge fails', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error('The script rejected our secret.'));
    const result = await GOOGLE_TOOLS.check_availability.run(
      { from: 'a', to: 'b' },
      ctx(run),
    );
    expect(result.ok).toBe(false);
    // A bare "error" invites the model to invent an answer, and for a
    // booking that is worse than admitting it could not check.
    expect(result.detail).toMatch(/do not guess/i);
  });

  it('reports busy blocks as busy, not as availability', async () => {
    const run = vi.fn().mockResolvedValue({
      output: { busy: [{ start: '10:00', end: '11:00' }] },
      detail: '1 busy block(s)',
    });
    const result = await GOOGLE_TOOLS.check_availability.run(
      { from: 'a', to: 'b' },
      ctx(run),
    );
    expect(result.detail).toMatch(/Busy: 10:00 to 11:00/);
    expect(result.detail).toMatch(/Offer only times outside/);
  });
});

describe('the skills that unlock them', () => {
  it('wires every Google tool to exactly one skill', () => {
    const wired = AGENT_SKILLS.flatMap((s) => s.tools).filter((t) =>
      GOOGLE_TOOL_NAMES.includes(t),
    );
    // A tool no skill unlocks is dead; one two skills unlock is a toggle
    // that does not turn it off.
    expect(wired.sort()).toEqual([...GOOGLE_TOOL_NAMES].sort());
  });

  it('tells the agent a free calendar slot is not the same as an open one', () => {
    const appointments = AGENT_SKILLS.find((s) => s.id === 'appointments');
    const prompt =
      appointments?.prompt({ availability: 'Mon-Fri 10-18' }) ?? '';
    // Without this the model proposes 3am, because nothing is booked then.
    expect(prompt).toMatch(/not available/i);
    expect(prompt).toMatch(/Mon-Fri 10-18/);
  });

  it('keeps the bookkeeping skill quiet and once-per-conversation', () => {
    const workspace = AGENT_SKILLS.find((s) => s.id === 'google_workspace');
    const prompt = workspace?.prompt({}) ?? '';
    expect(prompt).toMatch(/ONCE per conversation/i);
    expect(prompt).toMatch(/Do not narrate/i);
  });
});
