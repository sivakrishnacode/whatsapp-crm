/**
 * ============================================================
 * Turn a sentence into an automation draft.
 * ============================================================
 *
 * WHAT THIS IS NOT
 *   It is not a tool-calling agent and it does not touch the database.
 *   One completion, one JSON object back, validated hard. An automation
 *   is a small tree of typed configs, which is exactly the shape a model
 *   is good at and exactly the shape that must never be trusted.
 *
 * ⚠️ THE MODEL'S OUTPUT IS UNTRUSTED INPUT.
 *   `parseAutomationDraft` is the boundary. Everything the model sends
 *   passes through a per-step-type whitelist; anything not on it is
 *   dropped rather than forwarded. That matters more here than in a chat
 *   reply because the result is a CONFIG that will later run against
 *   customers, and because the prompt describing what to build is
 *   attacker-adjacent — it can be pasted from anywhere.
 *
 * ⚠️ THE MODEL NEVER SUPPLIES AN ID.
 *   Tag ids, segment ids, pipeline stages, connection ids, flow ids: it
 *   cannot know them, so a plausible-looking uuid is the single worst
 *   thing it could return. Those fields are forced to '' and reported in
 *   `needs` so the UI can say "pick a tag" — the same contract the
 *   template catalogue uses for the same reason.
 *
 * ⚠️ THE DRAFT IS NEVER ACTIVE.
 *   Nothing here writes a row. The draft is handed to the builder, and a
 *   human presses save. An LLM that can activate an automation is an LLM
 *   that can message every one of your customers.
 */

import { AiError } from './types';

// ============================================================
// The vocabulary the model is allowed to use
// ============================================================

/**
 * Triggers offered to the model.
 *
 * `time_based` is deliberately EXCLUDED: it fires for the workspace with
 * no contact attached, so every messaging step under it is dead config
 * (see `availability.ts`). A model asked for "message everyone every
 * Monday" would reach for it and produce an automation that looks right
 * and does nothing.
 */
const TRIGGERS: Record<string, string> = {
  new_message_received: 'Any inbound message from a contact.',
  first_inbound_message:
    "A contact's first-ever message. Use this for welcome/greeting automations.",
  keyword_match:
    'An inbound message containing one of trigger_config.keywords (string[]) with trigger_config.match_type of "contains" or "exact".',
  new_contact_created: 'A contact was created.',
  conversation_assigned: 'A conversation was assigned to an agent.',
  tag_added:
    'A tag was added to a contact. trigger_config.tag_id names the tag and must be left as "".',
  instagram_comment:
    'Someone commented on an Instagram post. Accepts the same keywords/match_type config as keyword_match. Instagram only.',
  instagram_story_reply:
    'Someone replied to an Instagram story. Instagram only.',
  web_chat_started: 'A visitor opened the website chat widget. Web only.',
  form_submitted:
    'One of your forms was submitted. There may be no chat thread.',
  appointment_booked: 'An appointment was booked.',
  appointment_cancelled: 'An appointment was cancelled.',
  appointment_rescheduled: 'An appointment was moved.',
};

/**
 * Step types offered to the model, with the exact config keys allowed.
 *
 * A step type absent from here cannot appear in a draft at all — which
 * is why `send_webhook`, `close_conversation` and `app_action` are
 * missing (all superseded, see STEP_META.deprecated) and why
 * `run_automation` and `start_flow` are missing too: both need an id of
 * something in the workspace, so the model can only ever produce a
 * broken one.
 *
 * `google_action` is absent for a third reason: its fields are a wire
 * contract with a script deployed in the customer's Google account, and
 * a drafted spreadsheet id or ISO timestamp would be invented. Those are jobs for the builder, and the draft says so in
 * `needs` when the request clearly wanted one.
 */
interface StepSpec {
  /** One line, shown to the model. */
  blurb: string;
  /**
   * The config shape, as shown to the model. DOCUMENTATION ONLY — it is
   * prose in a prompt, not a schema.
   */
  keys: string;
  /**
   * Top-level config keys actually accepted. Anything else the model
   * sends is dropped.
   *
   * Deliberately a separate list rather than parsed out of `keys`:
   * `keys` contains nested shapes (a condition rule, a list row), so
   * scraping it would accept `subject` and `title` as top-level config
   * keys. `automation-draft.test.ts` asserts every entry here appears in
   * `keys`, which is the drift that actually matters — a key we accept
   * but never told the model about is dead code.
   */
  allow: string[];
  /** Owns yes/no branches. */
  branching?: boolean;
  /** Config keys forced to '' — an id only the workspace knows. */
  blanks?: string[];
  /** What the author must then pick, when `blanks` were emptied. */
  needs?: string;
}

const STEPS: Record<string, StepSpec> = {
  send_message: {
    blurb: 'Send a plain text message on whatever channel the contact used.',
    keys: '{ "text": string }',
    allow: ['text'],
  },
  send_buttons: {
    blurb: 'Send up to 3 tappable quick replies.',
    keys: '{ "body_text": string, "buttons": [{ "id": string, "title": string }] }',
    allow: ['body_text', 'buttons'],
  },
  send_list: {
    blurb: 'Send a menu of up to 10 options. Not available on Instagram.',
    keys: '{ "body_text": string, "button_label": string, "sections": [{ "title": string, "rows": [{ "id": string, "title": string, "description"?: string }] }] }',
    allow: ['body_text', 'button_label', 'sections'],
  },
  send_media: {
    blurb: 'Send an image, video, document or audio file by URL.',
    keys: '{ "kind": "image"|"video"|"document"|"audio", "link": string, "caption"?: string }',
    allow: ['kind', 'link', 'caption'],
  },
  add_tag: {
    blurb: 'Label the contact with a tag.',
    keys: '{ "tag_id": "" }',
    allow: ['tag_id'],
    blanks: ['tag_id'],
    needs: 'a tag to add',
  },
  remove_tag: {
    blurb: 'Take a tag off the contact.',
    keys: '{ "tag_id": "" }',
    allow: ['tag_id'],
    blanks: ['tag_id'],
    needs: 'a tag to remove',
  },
  add_to_segment: {
    blurb: 'File the contact into a named audience.',
    keys: '{ "segment_id": "" }',
    allow: ['segment_id'],
    blanks: ['segment_id'],
    needs: 'a segment',
  },
  remove_from_segment: {
    blurb: 'Take the contact out of a named audience.',
    keys: '{ "segment_id": "" }',
    allow: ['segment_id'],
    blanks: ['segment_id'],
    needs: 'a segment',
  },
  update_contact_field: {
    blurb:
      'Write a contact field. `field` is one of "name", "email", "company".',
    keys: '{ "field": "name"|"email"|"company", "value": string }',
    allow: ['field', 'value'],
  },
  add_note: {
    blurb: 'Leave an internal note on the contact. The customer never sees it.',
    keys: '{ "text": string }',
    allow: ['text'],
  },
  create_deal: {
    blurb: 'Open a deal in a pipeline stage.',
    keys: '{ "pipeline_id": "", "stage_id": "", "title": string, "value"?: number }',
    allow: ['pipeline_id', 'stage_id', 'title', 'value'],
    blanks: ['pipeline_id', 'stage_id'],
    needs: 'a pipeline and stage',
  },
  update_deal: {
    blurb: "Move the contact's latest deal, or mark it won/lost.",
    keys: '{ "target": "latest_for_contact", "status"?: "open"|"won"|"lost" }',
    allow: ['target', 'status'],
  },
  notify_team: {
    blurb: 'Send an in-app notification to the team.',
    keys: '{ "recipient": "all"|"assigned_agent", "title": string, "body"?: string }',
    allow: ['recipient', 'title', 'body'],
  },
  assign_conversation: {
    blurb: 'Hand the thread to an agent.',
    keys: '{ "mode": "round_robin" }',
    allow: ['mode'],
  },
  set_conversation_status: {
    blurb: 'Set the conversation to open, pending or closed.',
    keys: '{ "status": "open"|"pending"|"closed" }',
    allow: ['status'],
  },
  condition: {
    blurb:
      'Branch. Steps go in its "yes" and "no" arrays. Rule subjects: "message_content" (operand unused, value is the text to look for), "contact_field" (operand is the field name), "time_of_day" (operand is "HH:mm-HH:mm"), "day_of_week" (operand is a comma list like "sat,sun"), "channel" (value is "whatsapp"|"instagram"|"web"), "tag_presence" (operand must be ""), "expression" (operand is a token path).',
    keys: '{ "match": "all"|"any", "rules": [{ "subject": string, "operand"?: string, "operator"?: "equals"|"not_equals"|"contains"|"not_contains"|"starts_with"|"ends_with"|"is_empty"|"is_not_empty"|"greater_than"|"less_than", "value"?: string }] }',
    allow: ['match', 'rules'],
    branching: true,
  },
  random_split: {
    blurb:
      'Send a percentage down "yes" and the rest down "no". For A/B tests.',
    keys: '{ "percent": number }',
    allow: ['percent'],
    branching: true,
  },
  wait: {
    blurb: 'Pause, then carry on.',
    keys: '{ "amount": number, "unit": "minutes"|"hours"|"days" }',
    allow: ['amount', 'unit'],
  },
  wait_until: {
    blurb: 'Pause until a time of day.',
    keys: '{ "time": "HH:mm", "timezone": string, "days": number[] }',
    allow: ['time', 'timezone', 'days'],
  },
  http_request: {
    blurb:
      'Call an HTTP API and keep the response for later steps to read as {{ steps.<key>.body.<field> }}.',
    keys: '{ "method": "GET"|"POST"|"PUT"|"PATCH"|"DELETE", "url": string, "body_mode": "json"|"none", "body_fields": object, "timeout_seconds": number }',
    allow: ['method', 'url', 'body_mode', 'body_fields', 'timeout_seconds'],
  },
  set_variable: {
    blurb: 'Store a value for later steps, read back as {{ vars.<name> }}.',
    keys: '{ "name": string, "value": string }',
    allow: ['name', 'value'],
  },
};

/** Step types the parser knows. Exported for the test that pins the vocabulary. */
export const DRAFTABLE_STEP_TYPES = Object.keys(STEPS);
export const DRAFTABLE_TRIGGER_TYPES = Object.keys(TRIGGERS);
export const STEP_SPECS: Readonly<Record<string, StepSpec>> = STEPS;

const MAX_STEPS = 24;
const MAX_PROMPT_CHARS = 2000;

/** Tokens the model may put inside message copy. */
const TOKEN_HELP = `{{ contact.name }}, {{ contact.phone }}, {{ contact.email }}, {{ message.text }}, {{ conversation.channel }}, {{ now.date }}, {{ vars.<name> }}, {{ steps.<step_key>.<path> }}. An unknown token renders as an empty string, so only use these. Prefer "{{ contact.name | default: \\"there\\" }}" when greeting by name.`;

export function buildAutomationDraftPrompt(): string {
  const triggers = Object.entries(TRIGGERS)
    .map(([id, blurb]) => `- "${id}": ${blurb}`)
    .join('\n');

  const steps = Object.entries(STEPS)
    .map(
      ([id, spec]) =>
        `- "${id}": ${spec.blurb}\n  step_config: ${spec.keys}${
          spec.branching
            ? '\n  branching: put child steps in "yes" / "no".'
            : ''
        }`,
    )
    .join('\n');

  return `You design automations for a WhatsApp / Instagram / web-chat CRM called Converse360.

The user will describe, in their own words, something they want to happen automatically. You return ONE automation as JSON. Nothing is saved — a human reviews your draft in a visual builder before it runs.

## Output format

Return ONLY a JSON object, no markdown fence, no commentary:

{
  "name": "Short title, max 60 chars",
  "description": "One sentence describing what it does.",
  "trigger_type": "<one of the triggers below>",
  "trigger_config": { },
  "channels": [],
  "steps": [
    { "step_type": "<one of the steps below>", "step_config": { }, "yes": [], "no": [] }
  ],
  "notes": ["Anything the human should know or decide, one short sentence each."]
}

## Triggers

${triggers}

## Steps

${steps}

## Rules

1. Use ONLY the trigger and step types listed above. If the request needs something not listed (sending email, writing to a spreadsheet, starting a flow, running another automation), build the closest thing you CAN and add a note saying what is missing and that they can add it in the builder.
2. NEVER invent an id. tag_id, segment_id, pipeline_id, stage_id are always "". Say in "notes" which one the human still has to pick.
3. "yes" and "no" are only meaningful on "condition" and "random_split". Leave them out everywhere else.
4. "channels" scopes which channels the automation runs on. Leave it [] (all channels) unless the request is clearly about one — Instagram triggers imply ["instagram"], web_chat_started implies ["web"].
5. Message copy must be finished, ready-to-send text in the user's language. No placeholders like [YOUR BUSINESS] and no lorem ipsum. Warm and brief.
6. Interpolation tokens available: ${TOKEN_HELP}
7. Do not send more than 2 messages in a row without a "wait" between them.
8. At most ${MAX_STEPS} steps.
9. If the request is vague, pick the most common sensible interpretation and record the assumption in "notes". Do not ask a question — you get one shot.
10. If the request has nothing to do with building an automation, return a draft with "steps": [] and one note explaining what you can build instead.`;
}

// ============================================================
// Parsing — the trust boundary
// ============================================================

export interface DraftStep {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes: DraftStep[]; no: DraftStep[] };
}

export interface AutomationDraft {
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  channels: string[];
  steps: DraftStep[];
  /** Model-authored caveats plus anything the parser had to correct. */
  notes: string[];
  /** Ids the human still has to choose, deduplicated. */
  needs: string[];
}

const CHANNELS = new Set(['whatsapp', 'instagram', 'web']);

/** Triggers that only make sense on one channel. Mirrors TRIGGER_CHANNEL_LOCK. */
const TRIGGER_CHANNEL_LOCK: Record<string, string> = {
  instagram_comment: 'instagram',
  instagram_story_reply: 'instagram',
  web_chat_started: 'web',
};

/**
 * Pull the JSON object out of whatever the model actually said.
 *
 * Models fence JSON in ```json blocks roughly half the time however
 * firmly you ask them not to, and some prefix a sentence. Both are
 * recoverable and neither is worth a failed generation the user paid
 * for — so strip the fence, then fall back to the outermost braces.
 */
export function extractJsonObject(raw: string): unknown {
  const text = String(raw ?? '').trim();
  if (!text)
    throw new AiError('The AI returned an empty response.', {
      code: 'ai_empty_response',
      status: 502,
    });

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // fall through to the next candidate
        }
      }
    }
  }

  throw new AiError(
    'The AI did not return a usable automation. Try describing it again, more specifically.',
    { code: 'ai_bad_draft', status: 502 },
  );
}

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

const MAX_TEXT = 4000;

/** Strings are capped, everything else is passed as JSON.parse produced it. */
function cappedString(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, options: T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/**
 * Per-type coercion, after the key filter.
 *
 * WHY COERCE AND NOT REJECT
 *   A draft is opened in a visual builder by a human before anything
 *   runs, so a wrong enum is a wasted generation, not an incident. The
 *   values fixed here are the ones where the WRONG value is worse than
 *   an empty one: a `wait` of "two days" is a NaN the executor would
 *   read as zero (turning a considered follow-up into an instant second
 *   message), and a 6-button card is one WhatsApp rejects at send time
 *   with an error the author never sees.
 */
function coerceConfig(
  type: string,
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case 'send_message':
    case 'add_note':
      return { text: cappedString(cfg.text) };

    case 'send_buttons': {
      const buttons = (Array.isArray(cfg.buttons) ? cfg.buttons : [])
        .slice(0, 3) // WhatsApp's hard limit — see INTERACTIVE_LIMITS.
        .map((b, i) => {
          const row = (b ?? {}) as Record<string, unknown>;
          return {
            id: cappedString(row.id, 60) || `btn_${i + 1}`,
            title: cappedString(row.title, 20),
          };
        });
      return {
        body_text: cappedString(cfg.body_text, 1024),
        buttons: buttons.length > 0 ? buttons : [{ id: 'btn_1', title: '' }],
      };
    }

    case 'send_list': {
      const sections = (Array.isArray(cfg.sections) ? cfg.sections : [])
        .slice(0, 10)
        .map((s) => {
          const row = (s ?? {}) as Record<string, unknown>;
          return {
            title: cappedString(row.title, 24) || 'Options',
            rows: (Array.isArray(row.rows) ? row.rows : [])
              .slice(0, 10)
              .map((r, i) => {
                const item = (r ?? {}) as Record<string, unknown>;
                return {
                  id: cappedString(item.id, 60) || `row_${i + 1}`,
                  title: cappedString(item.title, 24),
                  description: cappedString(item.description, 72),
                };
              }),
          };
        });
      return {
        body_text: cappedString(cfg.body_text, 1024),
        button_label: cappedString(cfg.button_label, 20) || 'Choose',
        sections:
          sections.length > 0
            ? sections
            : [{ title: 'Options', rows: [{ id: 'row_1', title: '' }] }],
      };
    }

    case 'send_media':
      return {
        kind: oneOf(cfg.kind, ['image', 'video', 'document', 'audio'], 'image'),
        link: cappedString(cfg.link, 2048),
        caption: cappedString(cfg.caption, 1024),
      };

    case 'update_contact_field':
      return {
        field: oneOf(cfg.field, ['name', 'email', 'company'], 'name'),
        value: cappedString(cfg.value, 500),
      };

    case 'create_deal':
      return {
        pipeline_id: '',
        stage_id: '',
        title: cappedString(cfg.title, 120),
        value: clampNumber(cfg.value, 0, 1_000_000_000, 0),
      };

    case 'update_deal':
      return {
        target: 'latest_for_contact',
        status: oneOf(cfg.status, ['open', 'won', 'lost'], 'open'),
      };

    case 'notify_team':
      return {
        recipient: oneOf(cfg.recipient, ['all', 'assigned_agent'], 'all'),
        title: cappedString(cfg.title, 120),
        body: cappedString(cfg.body, 1000),
      };

    case 'assign_conversation':
      return { mode: 'round_robin' };

    case 'set_conversation_status':
      return {
        status: oneOf(cfg.status, ['open', 'pending', 'closed'], 'open'),
      };

    case 'wait':
      return {
        amount: clampNumber(cfg.amount, 1, 365, 1),
        unit: oneOf(cfg.unit, ['minutes', 'hours', 'days'], 'hours'),
      };

    case 'wait_until':
      return {
        time: /^\d{2}:\d{2}$/.test(String(cfg.time))
          ? String(cfg.time)
          : '09:00',
        timezone: cappedString(cfg.timezone, 64) || 'UTC',
        days: (Array.isArray(cfg.days) ? cfg.days : [])
          .map((d) => clampNumber(d, 0, 6, 0))
          .slice(0, 7),
      };

    case 'random_split':
      return { percent: clampNumber(cfg.percent, 1, 99, 50) };

    case 'condition': {
      const rules = (Array.isArray(cfg.rules) ? cfg.rules : [])
        .slice(0, 8)
        .map((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          return {
            subject: oneOf(
              row.subject,
              [
                'message_content',
                'contact_field',
                'time_of_day',
                'day_of_week',
                'channel',
                'tag_presence',
                'expression',
                'segment_membership',
              ],
              'message_content',
            ),
            // tag_presence and segment_membership operands are ids the
            // model cannot know, so they are blanked like every other id.
            operand:
              row.subject === 'tag_presence' ||
              row.subject === 'segment_membership'
                ? ''
                : cappedString(row.operand, 200),
            operator: oneOf(
              row.operator,
              [
                'equals',
                'not_equals',
                'contains',
                'not_contains',
                'starts_with',
                'ends_with',
                'is_empty',
                'is_not_empty',
                'greater_than',
                'less_than',
              ],
              'contains',
            ),
            value: cappedString(row.value, 200),
          };
        });
      return {
        match: oneOf(cfg.match, ['all', 'any'], 'all'),
        // An empty rule list evaluates FALSE and sends everything down
        // the "no" branch. One blank rule instead gives the inspector a
        // row to render and the diagnostics something to complain about.
        rules:
          rules.length > 0
            ? rules
            : [
                {
                  subject: 'message_content',
                  operand: '',
                  operator: 'contains',
                  value: '',
                },
              ],
      };
    }

    case 'http_request':
      return {
        method: oneOf(
          cfg.method,
          ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          'GET',
        ),
        url: cappedString(cfg.url, 2048),
        headers: {},
        query: {},
        body_mode: oneOf(cfg.body_mode, ['json', 'none'], 'none'),
        body_fields:
          cfg.body_fields &&
          typeof cfg.body_fields === 'object' &&
          !Array.isArray(cfg.body_fields)
            ? (cfg.body_fields as Record<string, unknown>)
            : {},
        timeout_seconds: clampNumber(cfg.timeout_seconds, 1, 30, 10),
      };

    case 'set_variable':
      return {
        name: cappedString(cfg.name, 60).replace(/[^a-zA-Z0-9_]/g, '_'),
        value: cappedString(cfg.value, 1000),
      };

    case 'add_tag':
    case 'remove_tag':
      return { tag_id: '' };

    case 'add_to_segment':
    case 'remove_from_segment':
      return { segment_id: '' };

    default:
      return cfg;
  }
}

/**
 * A step's config, reduced to the keys its type declares, then coerced.
 *
 * Unknown keys are DROPPED, not passed through. A config is read by the
 * executor and rendered by the inspector, and a key neither knows about
 * is at best invisible and at worst a field somebody later reads without
 * checking where it came from.
 */
function sanitizeConfig(
  type: string,
  raw: unknown,
  needs: Set<string>,
): Record<string, unknown> {
  const spec = STEPS[type];
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const allowed = new Set(spec.allow);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) filtered[key] = value;
  }

  // Ids the model cannot know are blanked by `coerceConfig`, which is
  // unconditional per type — a supplied uuid is not "better than
  // nothing", it saves cleanly and silently never matches.
  if (spec.needs) needs.add(spec.needs);

  return coerceConfig(type, filtered);
}

function sanitizeSteps(
  raw: unknown,
  needs: Set<string>,
  budget: { left: number },
  depth = 0,
): DraftStep[] {
  if (!Array.isArray(raw) || depth > 3) return [];
  const out: DraftStep[] = [];

  for (const entry of raw) {
    if (budget.left <= 0) break;
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const type = typeof row.step_type === 'string' ? row.step_type : '';
    const spec = STEPS[type];
    // An unknown step type is dropped rather than coerced to something
    // plausible: guessing that "send_email" meant "send_message" would
    // send a customer a message the author never approved.
    if (!spec) continue;

    budget.left -= 1;
    const step: DraftStep = {
      step_type: type,
      step_config: sanitizeConfig(type, row.step_config, needs),
    };

    if (spec.branching) {
      step.branches = {
        yes: sanitizeSteps(row.yes, needs, budget, depth + 1),
        no: sanitizeSteps(row.no, needs, budget, depth + 1),
      };
    }

    out.push(step);
  }

  return out;
}

function sanitizeTriggerConfig(
  triggerType: string,
  raw: unknown,
  needs: Set<string>,
): Record<string, unknown> {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  if (
    triggerType === 'keyword_match' ||
    triggerType === 'instagram_comment' ||
    triggerType === 'instagram_story_reply'
  ) {
    const keywords = Array.isArray(input.keywords)
      ? input.keywords
          .filter((k): k is string => typeof k === 'string')
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const config: Record<string, unknown> = {
      keywords,
      match_type: input.match_type === 'exact' ? 'exact' : 'contains',
    };
    // A keyword trigger with no keywords fires on nothing at all, which
    // looks identical to a working automation from the list page.
    if (keywords.length === 0) needs.add('at least one trigger keyword');
    return config;
  }

  if (triggerType === 'tag_added') {
    needs.add('the tag that starts this automation');
    return { tag_id: '' };
  }

  if (triggerType === 'form_submitted') {
    // form_id narrows to one form; omitted means any form, which is a
    // legitimate and safer default than a form id we invented.
    return {};
  }

  return {};
}

/**
 * Validate and normalise a model response into a draft the builder can
 * open. Throws only when there is nothing usable at all.
 */
export function parseAutomationDraft(raw: string): AutomationDraft {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError('The AI returned something that was not an automation.', {
      code: 'ai_bad_draft',
      status: 502,
    });
  }

  const row = parsed as Record<string, unknown>;
  const notes: string[] = Array.isArray(row.notes)
    ? row.notes
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const needs = new Set<string>();

  const triggerType =
    typeof row.trigger_type === 'string' && TRIGGERS[row.trigger_type]
      ? row.trigger_type
      : 'new_message_received';
  if (triggerType !== row.trigger_type) {
    notes.push(
      'The trigger it suggested is not one this product has, so the draft starts on any inbound message — change it at the top of the canvas.',
    );
  }

  const budget = { left: MAX_STEPS };
  const steps = sanitizeSteps(row.steps, needs, budget);

  let channels = Array.isArray(row.channels)
    ? row.channels
        .filter((c): c is string => typeof c === 'string')
        .filter((c) => CHANNELS.has(c))
    : [];

  // A channel-locked trigger with the wrong scope never fires. Correcting
  // it silently is right here — the lock is a fact about the product, not
  // a preference the model was expressing.
  const locked = TRIGGER_CHANNEL_LOCK[triggerType];
  if (locked && !channels.includes(locked)) channels = [locked];

  return {
    name: asString(row.name, 60) || 'Untitled automation',
    description: asString(row.description, 200),
    trigger_type: triggerType,
    trigger_config: sanitizeTriggerConfig(
      triggerType,
      row.trigger_config,
      needs,
    ),
    channels,
    steps,
    notes,
    needs: [...needs],
  };
}

/** The user's request, trimmed to something a prompt can carry. */
export function normalizeDraftPrompt(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new AiError('Describe what the automation should do.', {
      code: 'prompt_required',
      status: 400,
    });
  }
  return text.slice(0, MAX_PROMPT_CHARS);
}

export const AUTOMATION_DRAFT_LIMITS = {
  MAX_STEPS,
  MAX_PROMPT_CHARS,
};
