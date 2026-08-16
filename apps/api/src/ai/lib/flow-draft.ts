/**
 * ============================================================
 * Turn a sentence into a flow draft.
 * ============================================================
 *
 * The sibling of `automation-draft.ts`, and the same trust model: one
 * completion, one JSON object back, validated hard, nothing written.
 *
 * ⚠️ A FLOW IS A GRAPH, NOT A TREE — WHICH IS WHY THE PARSER IS BIGGER.
 *   An automation nests its children inside a branching step, so a
 *   malformed one is still structurally a tree. A flow's edges are
 *   `next_node_key` STRINGS pointing at other nodes, so a model can
 *   easily emit an edge to a node it never defined, two nodes with the
 *   same key, or a cycle straight back to the entry. Each of those
 *   produces a flow that saves and then behaves nothing like the
 *   sentence that asked for it, so each is repaired here:
 *     - duplicate keys are renamed,
 *     - an edge to an unknown node is blanked (the builder shows the gap),
 *     - the entry falls back to the first node.
 *   Nothing is dropped silently without a note the author can read.
 *
 * ⚠️ THE MODEL NEVER SUPPLIES AN ID.
 *   tag_id, segment_id, flow_id, agent_id, product ids and template
 *   names are workspace facts it cannot know, so a plausible-looking
 *   value is the single worst thing it could return. They are forced to
 *   '' and reported in `needs`, the same contract the automation draft
 *   and the template catalogue use.
 *
 * ⚠️ THE DRAFT IS NEVER ACTIVE.
 *   Nothing here writes a row. The browser hands it to the builder and a
 *   human presses save, against the same validator every other author's
 *   save runs. A model that could activate a flow is a model that could
 *   start messaging every customer who says "hi".
 */

import { extractJsonObject } from './automation-draft';
import { AiError } from './types';

// ============================================================
// The vocabulary the model is allowed to use
// ============================================================

interface NodeSpec {
  blurb: string;
  /** The config shape as shown to the model. Prose, not a schema. */
  keys: string;
  /** Config keys actually accepted. Anything else is dropped. */
  allow: string[];
  /** Keys forced to '' — an id only the workspace knows. */
  blanks?: string[];
  /** What the author must then pick. */
  needs?: string;
  /** Terminal: carries no `next_node_key`. */
  terminal?: boolean;
}

/**
 * ⚠️ `start` IS ABSENT ON PURPOSE. It is an entry marker rather than a
 * step, `entry_node_key` already says which node runs first, and every
 * draft that included one produced a node whose only job was to point at
 * the next one.
 *
 * `send_products` is absent too: it needs retailer ids from a synced
 * catalogue, so the model can only ever produce a broken one. The rules
 * below tell it to say so in a note instead.
 */
const NODES: Record<string, NodeSpec> = {
  send_message: {
    blurb: 'Send a plain text message.',
    keys: '{ "text": string }',
    allow: ['text'],
  },
  send_buttons: {
    blurb:
      'Send up to 3 tappable buttons. THE MAIN BRANCHING TOOL — each button carries its own next_node_key.',
    keys: '{ "text": string, "buttons": [{ "reply_id": string, "title": string (max 20 chars), "next_node_key": string }] }',
    allow: ['text', 'header_text', 'footer_text', 'buttons'],
  },
  send_list: {
    blurb: 'Send a tappable menu of up to 10 options across sections.',
    keys: '{ "text": string, "button_label": string, "sections": [{ "title": string, "rows": [{ "reply_id": string, "title": string (max 24 chars), "description"?: string, "next_node_key": string }] }] }',
    allow: ['text', 'button_label', 'header_text', 'footer_text', 'sections'],
  },
  send_media: {
    blurb:
      'Send an image, video or document the user has already uploaded. You cannot know their file URLs, so leave media_url "".',
    keys: '{ "media_type": "image"|"video"|"document", "media_url": "", "caption"?: string }',
    allow: ['media_type', 'media_url', 'caption'],
    blanks: ['media_url'],
    needs: 'a file for the media node',
  },
  send_template: {
    blurb:
      'Send an approved WhatsApp template — the only message that sends after 24 hours of silence. You cannot know their template names, so leave template_name "".',
    keys: '{ "template_name": "", "language": "en_US", "body_params": string[] }',
    allow: ['template_name', 'language', 'body_params'],
    blanks: ['template_name'],
    needs: 'an approved template',
  },
  collect_input: {
    blurb: 'Ask a question and save the typed answer into a variable.',
    keys: '{ "prompt_text": string, "var_key": string (lowercase, a-z0-9_) }',
    allow: ['prompt_text', 'var_key'],
  },
  ask_location: {
    blurb: 'Ask the customer to share their location; saves the pin.',
    keys: '{ "prompt_text": string, "var_key": string }',
    allow: ['prompt_text', 'var_key'],
  },
  ask_media: {
    blurb: 'Ask the customer to send a photo or document; saves the URL.',
    keys: '{ "prompt_text": string, "var_key": string, "accept": "any"|"image"|"video"|"document"|"audio" }',
    allow: ['prompt_text', 'var_key', 'accept'],
  },
  condition: {
    blurb:
      'Branch on a saved variable. Carries true_next and false_next instead of next_node_key.',
    keys: '{ "subject": "var", "subject_key": string, "operator": "equals"|"contains"|"present"|"absent", "value"?: string, "true_next": string, "false_next": string }',
    allow: [
      'subject',
      'subject_key',
      'operator',
      'value',
      'true_next',
      'false_next',
    ],
  },
  wait: {
    blurb:
      'Pause, then carry on. A wait of 24 hours or more closes the messaging window, so only a template will send after it.',
    keys: '{ "duration": number, "unit": "minutes"|"hours"|"days" }',
    allow: ['duration', 'unit'],
  },
  set_attribute: {
    blurb:
      'Save a value onto the contact or into a variable. Use "{{vars.x}}" to store an earlier answer.',
    keys: '{ "target": "contact_field"|"var", "key": string, "value": string }',
    allow: ['target', 'key', 'value'],
  },
  set_tag: {
    blurb: 'Add or remove a tag on the contact.',
    keys: '{ "mode": "add"|"remove", "tag_id": "" }',
    allow: ['mode', 'tag_id'],
    blanks: ['tag_id'],
    needs: 'a tag',
  },
  set_segment: {
    blurb: 'Put the contact into a named audience, or take them out.',
    keys: '{ "mode": "add"|"remove", "segment_id": "" }',
    allow: ['mode', 'segment_id'],
    blanks: ['segment_id'],
    needs: 'a segment',
  },
  http_request: {
    blurb:
      'Call an HTTP API and save the response, readable later as {{vars.<response_var>.body.<field>}}.',
    keys: '{ "method": "GET"|"POST"|"PUT"|"PATCH"|"DELETE", "url": string, "body"?: string, "response_var": string }',
    allow: ['method', 'url', 'headers', 'body', 'response_var'],
  },
  handoff: {
    blurb: 'Hand the conversation to a human agent. Ends the flow.',
    keys: '{ "note"?: string }',
    allow: ['note'],
    terminal: true,
  },
  ai_handoff: {
    blurb: 'Let an AI agent take over the conversation. Ends the flow.',
    keys: '{ "note"?: string }',
    allow: ['note', 'agent_id'],
    blanks: ['agent_id'],
    terminal: true,
  },
  end: {
    blurb: 'End the flow.',
    keys: '{ }',
    allow: [],
    terminal: true,
  },
};

const TRIGGERS: Record<string, string> = {
  keyword:
    'A message containing one of trigger_config.keywords (string[]), with trigger_config.match_type "contains" or "exact".',
  first_inbound_message:
    "The customer's first ever message. Use this for welcome flows.",
  manual: 'Only started by an automation or an agent — never on its own.',
};

/** Exported for the test that pins the vocabulary. */
export const DRAFTABLE_NODE_TYPES = Object.keys(NODES);
export const DRAFTABLE_FLOW_TRIGGERS = Object.keys(TRIGGERS);

const MAX_NODES = 24;
const MAX_PROMPT_CHARS = 2000;
const MAX_TEXT = 4000;

export function buildFlowDraftPrompt(): string {
  const triggers = Object.entries(TRIGGERS)
    .map(([id, blurb]) => `- "${id}": ${blurb}`)
    .join('\n');

  const nodes = Object.entries(NODES)
    .map(
      ([id, spec]) =>
        `- "${id}": ${spec.blurb}\n  config: ${spec.keys}${
          spec.terminal ? '\n  terminal: no next_node_key.' : ''
        }`,
    )
    .join('\n');

  return `You design WhatsApp chatbot flows for a CRM called Converse360.

The user describes what the bot should do. You return ONE flow as JSON. Nothing is saved — a human reviews your draft on a visual canvas before it can go live.

A flow is a GRAPH of nodes. Every node has a unique "node_key" (lowercase, a-z0-9_), and nodes are wired together by naming another node's key.

## Output format

Return ONLY a JSON object, no markdown fence, no commentary:

{
  "name": "Short title, max 60 chars",
  "description": "One sentence describing what it does.",
  "trigger_type": "<one of the triggers below>",
  "trigger_config": { },
  "entry_node_key": "<node_key of the first node>",
  "nodes": [
    { "node_key": "greeting", "node_type": "send_message", "config": { "text": "Hi!" }, "next_node_key": "menu" }
  ],
  "notes": ["Anything the human should know or decide, one short sentence each."]
}

## Wiring

- Every non-terminal node carries "next_node_key" EXCEPT:
  - "send_buttons" / "send_list": each button or row carries its own "next_node_key".
  - "condition": carries "true_next" and "false_next".
- Every next_node_key must name a node you actually defined in "nodes".
- The flow must reach a terminal node ("handoff", "ai_handoff" or "end") on every path. A conversation that just stops is the worst outcome.

## Triggers

${triggers}

## Nodes

${nodes}

## Rules

1. Use ONLY the node and trigger types listed above. If the request needs something not listed (sending a product catalogue, connecting to another flow, emailing someone), build the closest thing you CAN and add a note saying what is missing.
2. NEVER invent an id or a name you cannot know: tag_id, segment_id, agent_id, media_url and template_name are always "". Say in "notes" what the human still has to pick.
3. Message copy must be finished, ready-to-send text in the user's language. No placeholders like [YOUR BUSINESS], no lorem ipsum. Warm and brief — this is a chat, not a letter.
4. Button titles are 20 characters max; list row titles 24. Keep them short enough to read on a phone.
5. Tokens you may put inside copy: {{contact.name}}, {{contact.phone}}, {{vars.<key>}}. An unknown token renders as an empty string, so use no others. Prefer a greeting that reads fine when the name is missing.
6. Ask ONE thing per node. Two questions in one message get one answer.
7. Prefer buttons over free text when the answers are known — a tap cannot be misspelled.
8. Every branch must end somewhere. When you are unsure what the business would say, hand off to a human rather than inventing a policy.
9. At most ${MAX_NODES} nodes.
10. If the request is vague, pick the most common sensible reading and record the assumption in "notes". Do not ask a question — you get one shot.
11. If the request has nothing to do with building a chatbot flow, return "nodes": [] and one note saying what you can build instead.`;
}

// ============================================================
// Parsing — the trust boundary
// ============================================================

export interface DraftNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface FlowDraft {
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  entry_node_key: string;
  nodes: DraftNode[];
  notes: string[];
  needs: string[];
}

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * Coerce anything into a usable node key. Same rules as the builder's
 * `slugify`, so a key that survives here is one the editor can render
 * and the DB's `(flow_id, node_key)` unique index will accept.
 */
function slugKey(raw: unknown, fallback: string): string {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

/** Strings are capped; everything else passes through as parsed. */
function cappedString(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function parseFlowDraft(raw: string): FlowDraft {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError('The AI returned something that was not a flow.', {
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
      : 'keyword';
  if (triggerType !== row.trigger_type) {
    notes.push(
      'The trigger it suggested is not one flows support, so the draft starts on a keyword — set the keywords at the top of the canvas.',
    );
  }

  // ---- pass 1: node identity ----
  // Keys are settled BEFORE any wiring is read, because an edge can only
  // be validated against the final set of keys. Duplicates are renamed
  // rather than dropped: the node still has content worth keeping, and a
  // silently missing node is harder to notice than an oddly-named one.
  const rawNodes = Array.isArray(row.nodes)
    ? row.nodes.slice(0, MAX_NODES)
    : [];
  const seen = new Set<string>();
  const staged: Array<{
    key: string;
    type: string;
    cfg: Record<string, unknown>;
  }> = [];

  for (const [i, entry] of rawNodes.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const node = entry as Record<string, unknown>;
    const type = typeof node.node_type === 'string' ? node.node_type : '';
    const spec = NODES[type];
    if (!spec) {
      notes.push(
        `Skipped a "${asString(node.node_type, 40) || 'nameless'}" node — flows have no such step.`,
      );
      continue;
    }

    let key = slugKey(node.node_key, `${type}_${i + 1}`);
    if (seen.has(key)) {
      let n = 2;
      while (seen.has(`${key}_${n}`)) n += 1;
      key = `${key}_${n}`;
    }
    seen.add(key);

    const cfgIn =
      node.config &&
      typeof node.config === 'object' &&
      !Array.isArray(node.config)
        ? (node.config as Record<string, unknown>)
        : {};
    const cfg: Record<string, unknown> = {};
    for (const allowed of spec.allow) {
      if (allowed in cfgIn) cfg[allowed] = cfgIn[allowed];
    }
    // Blanked ids: the model cannot know them, and a plausible-looking
    // uuid is worse than an obviously empty field.
    for (const blank of spec.blanks ?? []) {
      cfg[blank] = '';
      if (spec.needs) needs.add(spec.needs);
    }
    // Edge fields live on the node in the model's output but inside the
    // config in ours.
    if (!spec.terminal) {
      if (type === 'condition') {
        cfg.true_next = slugKey(cfgIn.true_next ?? node.true_next, '');
        cfg.false_next = slugKey(cfgIn.false_next ?? node.false_next, '');
      } else if (type !== 'send_buttons' && type !== 'send_list') {
        cfg.next_node_key = slugKey(
          (node as { next_node_key?: unknown }).next_node_key ??
            cfgIn.next_node_key,
          '',
        );
      }
    }

    staged.push({ key, type, cfg });
  }

  // ---- pass 2: wiring ----
  // Now that every key is known, blank any edge pointing at a node that
  // does not exist. The builder renders an unwired port, which is a
  // visible gap; leaving the dangling key would fail validation at save
  // with an error naming a node the author never saw.
  let dangling = 0;
  const known = new Set(staged.map((n) => n.key));
  const resolve = (value: unknown): string => {
    const key = slugKey(value, '');
    if (!key) return '';
    if (known.has(key)) return key;
    dangling += 1;
    return '';
  };

  const nodes: DraftNode[] = staged.map(({ key, type, cfg }) => {
    if (type === 'send_buttons') {
      const buttons = Array.isArray(cfg.buttons) ? cfg.buttons : [];
      cfg.buttons = buttons
        .slice(0, 3)
        .filter(
          (b): b is Record<string, unknown> => !!b && typeof b === 'object',
        )
        .map((b, i) => ({
          reply_id: slugKey(b.reply_id, `option_${i + 1}`),
          title: cappedString(b.title, 20) || `Option ${i + 1}`,
          next_node_key: resolve(b.next_node_key),
        }));
    } else if (type === 'send_list') {
      const sections = Array.isArray(cfg.sections) ? cfg.sections : [];
      let rowBudget = 10; // Meta's cap across ALL sections, not per section.
      cfg.sections = sections
        .filter(
          (s): s is Record<string, unknown> => !!s && typeof s === 'object',
        )
        .map((s, si) => {
          const rows = Array.isArray(s.rows) ? s.rows : [];
          const kept = rows
            .filter(
              (r): r is Record<string, unknown> => !!r && typeof r === 'object',
            )
            .slice(0, Math.max(rowBudget, 0))
            .map((r, ri) => ({
              reply_id: slugKey(r.reply_id, `row_${si + 1}_${ri + 1}`),
              title: cappedString(r.title, 24) || `Option ${ri + 1}`,
              description: cappedString(r.description, 72) || undefined,
              next_node_key: resolve(r.next_node_key),
            }));
          rowBudget -= kept.length;
          return { title: cappedString(s.title, 24), rows: kept };
        })
        .filter((s) => s.rows.length > 0);
    } else if (type === 'condition') {
      cfg.true_next = resolve(cfg.true_next);
      cfg.false_next = resolve(cfg.false_next);
      // The builder's own default; the model is not asked for it.
      cfg.subject = 'var';
    } else if ('next_node_key' in cfg) {
      cfg.next_node_key = resolve(cfg.next_node_key);
    }
    return { node_key: key, node_type: type, config: cfg };
  });

  if (dangling > 0) {
    notes.push(
      `${dangling} connection${dangling === 1 ? '' : 's'} pointed at a node that was not in the draft, so ${dangling === 1 ? 'it was' : 'they were'} left unconnected — join ${dangling === 1 ? 'it' : 'them'} up on the canvas.`,
    );
  }

  // ---- entry ----
  let entry = slugKey(row.entry_node_key, '');
  if (!entry || !known.has(entry)) {
    entry = nodes[0]?.node_key ?? '';
    if (entry) {
      notes.push(
        'The starting node it named was missing, so the draft starts at the first node.',
      );
    }
  }

  return {
    name: asString(row.name, 60) || 'Untitled flow',
    description: asString(row.description, 200),
    trigger_type: triggerType,
    trigger_config: sanitizeTriggerConfig(triggerType, row.trigger_config),
    entry_node_key: entry,
    nodes,
    notes,
    needs: [...needs],
  };
}

function sanitizeTriggerConfig(
  triggerType: string,
  raw: unknown,
): Record<string, unknown> {
  if (triggerType !== 'keyword') return {};
  const cfg =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return {
    keywords,
    match_type: cfg.match_type === 'exact' ? 'exact' : 'contains',
  };
}

/** The user's request, trimmed to something a prompt can carry. */
export function normalizeFlowPrompt(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new AiError('Describe what the flow should do.', {
      code: 'prompt_required',
      status: 400,
    });
  }
  return text.slice(0, MAX_PROMPT_CHARS);
}

export const FLOW_DRAFT_LIMITS = { MAX_NODES, MAX_PROMPT_CHARS };
