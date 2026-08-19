import type { BuiltinTool, BuiltinToolContext } from './builtin';

/**
 * ============================================================
 * Google tools — the ones backed by the workspace's Apps Script bridge.
 *
 * Everything here runs through `GoogleScriptExecutorService`, which
 * resolves the deployment from the ACCOUNT and nothing else. As with the
 * database tools, no schema below has an account, url or secret
 * parameter: a model that hallucinates one must be unable to express it.
 *
 * ⚠️⚠️ WHAT IS DELIBERATELY *NOT* HERE, AND WHY
 *
 *   The bridge can do more than this. The agent may not, because it is
 *   talking to a CUSTOMER and the owner's Google account is not the
 *   customer's to see or change.
 *
 *   `find_events` — READS EVENT TITLES. "Board meeting re: layoffs" is
 *     exactly the sort of thing a model will happily summarise to whoever
 *     asked. `check_availability` exists for this reason: it returns busy
 *     INTERVALS and no content, which is the honest answer to "when are
 *     you free". That distinction is the whole reason the bridge has two
 *     calendar reads rather than one.
 *   `sheet_find` — same shape, bigger surface: a business spreadsheet is
 *     full of other customers' rows.
 *   `send_email` — leaves WhatsApp, is permanent, and arrives under the
 *     owner's own address. A hallucinated price in a chat bubble is
 *     embarrassing; the same sentence in an email from the business reads
 *     like a commitment.
 *   `delete_event`, `update_event`, `sheet_update`, `sheet_delete_row` —
 *     destructive, and a model's judgement is not the thing that should
 *     stand between a customer's typo and somebody's calendar.
 *
 *   Adding any of them is a product decision, not a refactor.
 *
 * ⚠️ WRITE TOOLS ARE WITHHELD IN DRAFT MODE (see agent-runtime.service).
 *   Pressing "draft a reply" three times must not book three meetings for
 *   a customer who never received a message. `WRITE_GOOGLE_TOOLS` is the
 *   list that gate reads; a tool added here and not there executes for
 *   real while a human is still deciding whether to send anything.
 * ============================================================
 */

/** Names withheld while drafting. Anything that changes the world. */
export const WRITE_GOOGLE_TOOLS = [
  'book_meeting',
  'log_to_sheet',
  'save_to_contacts',
  'create_task',
];

/** Every tool in this file, for the "is Google connected" gate. */
export const GOOGLE_TOOL_NAMES = ['check_availability', ...WRITE_GOOGLE_TOOLS];

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Run one bridge action, turning any failure into something the MODEL can
 * act on.
 *
 * The detail strings matter as much as the call: a tool that returns
 * "error" invites the model to invent an answer, which for a booking is
 * worse than admitting it could not check.
 */
async function callBridge(
  ctx: BuiltinToolContext,
  action: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; output?: Record<string, unknown> }> {
  if (!ctx.googleScript) {
    return {
      ok: false,
      detail:
        'Google is not available on this workspace. Do not claim anything was booked or saved.',
    };
  }
  try {
    const result = await ctx.googleScript.run(ctx.accountId, action, input);
    return {
      ok: true,
      detail: result.detail ?? 'Done.',
      output: result.output,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      // The message is written for a human reading an automation log, so
      // it is safe to pass through — but the instruction after it is what
      // stops the model papering over the failure.
      detail: `${message} Do not guess — tell the customer you could not complete that and offer to have someone follow up.`,
    };
  }
}

const checkAvailability: BuiltinTool = {
  definition: {
    name: 'check_availability',
    description:
      "Check which times are already busy in the business's calendar between two instants. Returns busy periods only, never what the meetings are. Call this before offering a customer a specific time.",
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'Start of the window to check, ISO 8601 with a timezone offset, e.g. 2026-08-20T09:00:00+05:30.',
        },
        to: {
          type: 'string',
          description: 'End of the window, ISO 8601 with a timezone offset.',
        },
      },
      required: ['from', 'to'],
    },
  },
  async run(args, ctx) {
    const from = str(args, 'from');
    const to = str(args, 'to');
    if (!from || !to) {
      return {
        ok: false,
        detail: 'Both a start and an end are needed to check availability.',
      };
    }

    const result = await callBridge(ctx, 'check_availability', { from, to });
    if (!result.ok) return { ok: false, detail: result.detail };

    const raw = Array.isArray(result.output?.busy) ? result.output.busy : [];
    // Only string instants survive. The bridge sends them as ISO strings,
    // but this text goes STRAIGHT INTO THE MODEL'S CONTEXT — an object
    // slipping through would read as "[object Object] to [object Object]",
    // and the model would relay that to a customer as a time.
    const periods = raw
      .map((b) => {
        const block = (b ?? {}) as { start?: unknown; end?: unknown };
        const start = typeof block.start === 'string' ? block.start : null;
        const end = typeof block.end === 'string' ? block.end : null;
        return start && end ? `${start} to ${end}` : null;
      })
      .filter((p): p is string => p !== null);

    if (periods.length === 0) {
      return {
        ok: true,
        detail: 'Nothing is booked in that window — every time in it is free.',
      };
    }
    return {
      ok: true,
      detail: `Busy: ${periods.join('; ')}. Every other time in the window is free. Offer only times outside those periods.`,
    };
  },
};

const bookMeeting: BuiltinTool = {
  definition: {
    name: 'book_meeting',
    description:
      "Put a meeting on the business's calendar and get a Google Meet link back. Check availability first, and only call this once the customer has agreed to a specific time.",
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'What the meeting is, e.g. "Consultation — Priya Sharma".',
        },
        starts_at: {
          type: 'string',
          description: 'Start, ISO 8601 with a timezone offset.',
        },
        ends_at: {
          type: 'string',
          description: 'End, ISO 8601 with a timezone offset.',
        },
        description: {
          type: 'string',
          description: 'What the customer asked for, in a sentence or two.',
        },
        attendee_email: {
          type: 'string',
          description:
            "The customer's email, only if they have given it. Leave out otherwise — do not invent one.",
        },
      },
      required: ['title', 'starts_at', 'ends_at'],
    },
  },
  async run(args, ctx) {
    const title = str(args, 'title');
    const startsAt = str(args, 'starts_at');
    const endsAt = str(args, 'ends_at');
    if (!title || !startsAt || !endsAt) {
      return {
        ok: false,
        detail: 'A title, a start and an end are all needed to book.',
      };
    }

    const input: Record<string, unknown> = {
      title,
      starts_at: startsAt,
      ends_at: endsAt,
      add_meet: true,
      // The customer is told the link in chat. A calendar invite emailed by
      // Google as well would be a second, unexpected message from an
      // address the customer never gave anyone permission to use.
      notify: 'none',
    };
    const description = str(args, 'description');
    if (description) input.description = description;
    const attendee = str(args, 'attendee_email');
    if (attendee) input.attendees = attendee;

    // `create_event` is the catalogue id; `book_meeting` is what the
    // model sees. They differ because the tool is a narrower, safer thing
    // than the action: Meet always on, notifications always off.
    const result = await callBridge(ctx, 'create_event', input);
    return result.ok
      ? { ok: true, detail: result.detail }
      : { ok: false, detail: result.detail };
  },
};

const logToSheet: BuiltinTool = {
  definition: {
    name: 'log_to_sheet',
    description:
      'Append a row to the spreadsheet the business configured for this agent. Use it to log an enquiry or outcome. It only ever adds a row; it cannot read or change what is already there.',
    parameters: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { type: 'string' },
          description:
            "The cells to write, left to right, matching the sheet's columns.",
        },
      },
      required: ['values'],
    },
  },
  async run(args, ctx) {
    const raw = args.values;
    const values = Array.isArray(raw) ? raw.map((v) => String(v)) : null;
    if (!values || values.length === 0) {
      return { ok: false, detail: 'Nothing to write — values were empty.' };
    }

    // ⚠️ The spreadsheet is an ADMIN's choice, read from the skill config,
    // never a model argument. A model-supplied id would let a prompt
    // injection write into any sheet the owner can reach.
    const config = ctx.skills?.google_workspace?.config as
      Record<string, unknown> | undefined;
    const spreadsheetId =
      typeof config?.spreadsheet_id === 'string'
        ? config.spreadsheet_id.trim()
        : '';
    if (!spreadsheetId) {
      return {
        ok: false,
        detail:
          'No spreadsheet is configured for this agent, so nothing was logged. Carry on normally.',
      };
    }
    const tab =
      typeof config?.sheet_tab === 'string' ? config.sheet_tab.trim() : '';

    const result = await callBridge(ctx, 'sheet_append', {
      spreadsheet_id: spreadsheetId,
      ...(tab ? { tab } : {}),
      values,
    });
    return { ok: result.ok, detail: result.detail };
  },
};

const saveToContacts: BuiltinTool = {
  definition: {
    name: 'save_to_contacts',
    description:
      "Save this customer to the business's Google Contacts, so they appear in the owner's phone. Call it once you know their name.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name." },
        phone: {
          type: 'string',
          description:
            'Their phone number in full international form, if known.',
        },
        email: {
          type: 'string',
          description: 'Their email, if they gave one.',
        },
        company: {
          type: 'string',
          description: 'Their company, if they gave one.',
        },
        notes: {
          type: 'string',
          description:
            'One line on what they wanted, for the owner to read later.',
        },
      },
      required: ['name'],
    },
  },
  async run(args, ctx) {
    const name = str(args, 'name');
    if (!name)
      return { ok: false, detail: 'A name is needed to save a contact.' };

    const input: Record<string, unknown> = { name };
    for (const key of ['phone', 'email', 'company', 'notes']) {
      const value = str(args, key);
      if (value) input[key] = value;
    }

    const result = await callBridge(ctx, 'contact_save', input);
    return { ok: result.ok, detail: result.detail };
  },
};

const createTask: BuiltinTool = {
  definition: {
    name: 'create_task',
    description:
      "Add a follow-up to the business's own task list. Use it when something needs a human later — not for things you have already handled.",
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'The task, as an instruction, e.g. "Send Priya the price list".',
        },
        notes: {
          type: 'string',
          description: 'Any detail the person will need.',
        },
        due: {
          type: 'string',
          description: 'Due date as YYYY-MM-DD, if the customer implied one.',
        },
      },
      required: ['title'],
    },
  },
  async run(args, ctx) {
    const title = str(args, 'title');
    if (!title) return { ok: false, detail: 'A task needs a title.' };

    const input: Record<string, unknown> = { title };
    const notes = str(args, 'notes');
    const due = str(args, 'due');
    if (notes) input.notes = notes;
    if (due) input.due = due;

    const result = await callBridge(ctx, 'create_task', input);
    return { ok: result.ok, detail: result.detail };
  },
};

export const GOOGLE_TOOLS: Record<string, BuiltinTool> = {
  check_availability: checkAvailability,
  book_meeting: bookMeeting,
  log_to_sheet: logToSheet,
  save_to_contacts: saveToContacts,
  create_task: createTask,
};
