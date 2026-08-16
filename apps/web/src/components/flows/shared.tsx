/**
 * Shared editor primitives used by both the linear-list and canvas
 * views of a flow.
 *
 * What lives here vs in flow-builder.tsx / flow-canvas.tsx:
 *   - Types and metadata that BOTH views need to render a node
 *     consistently (icon, label, color, 1-line summary).
 *   - Editing-only helpers (defaultConfigFor, slugify, uniqueNodeKey,
 *     BuilderState) stay in flow-builder.tsx until the canvas grows
 *     editing affordances — pulled across in the PR that adds them.
 *
 * Why .tsx and not .ts: NODE_META holds lucide icon components, which
 * are typed as React components; importing them from a .ts module
 * works at runtime but trips TypeScript's
 * `verbatimModuleSyntax`-related linting in some setups. Keeping the
 * file .tsx future-proofs it for inline JSX in node-card renderers.
 */

import {
  Bot,
  Camera,
  Clock,
  Flag,
  FileText,
  GitFork,
  Inbox,
  Layers,
  ListChecks,
  ListPlus,
  MapPin,
  MessageCircle,
  Paperclip,
  PencilLine,
  PlayCircle,
  ShoppingBag,
  Tag,
  UserPlus,
  Waypoints,
  Webhook,
  Workflow,
} from 'lucide-react';

import { cn } from '@/lib/utils';

// ============================================================
// Node-type union — single source of truth for every place the UI
// enumerates types (add menu, type pickers, switch statements). Kept
// in lockstep with `FlowNodeType` in src/lib/flows/types.ts (which
// drives the engine's exhaustiveness check); a divergence between the
// two is always a bug.
// ============================================================

export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'send_template'
  | 'send_products'
  | 'collect_input'
  | 'ask_location'
  | 'ask_media'
  | 'condition'
  | 'wait'
  | 'set_tag'
  | 'set_segment'
  | 'set_attribute'
  | 'http_request'
  | 'start_flow'
  | 'handoff'
  | 'ai_handoff'
  | 'end';

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}

// ============================================================
// Per-node-type metadata used to render icons + labels everywhere
// the user sees a node summary.
// ============================================================

// ------------------------------------------------------------
// Node categories — buckets the add-step menu groups types under so
// the picker stays scannable as the type list grows, and so a fork
// adding its own node types has an obvious place to slot them.
//
// Note there's no "Events / Triggers" category: in Converse360 a flow is
// triggered by flow-level config (`trigger_type`), not by a node on
// the canvas, so `start` is just the entry point under Flow control.
// ------------------------------------------------------------

export type NodeCategory = 'messaging' | 'capture' | 'logic' | 'flow';

/** Category labels + the order they render in the add-step menu. */
export const NODE_CATEGORIES: { id: NodeCategory; label: string }[] = [
  { id: 'messaging', label: 'Message types' },
  // Split out of 'logic' when the ask_* nodes landed: "send something"
  // and "wait for an answer" are the two halves of every conversation,
  // and burying the capture nodes among the data ones made the palette
  // read as one long list of unrelated verbs.
  { id: 'capture', label: 'Ask & capture' },
  { id: 'logic', label: 'Actions & data' },
  { id: 'flow', label: 'Flow control' },
];

export const NODE_META: Record<
  NodeType,
  {
    label: string;
    icon: typeof Workflow;
    color: string;
    blurb: string;
    category: NodeCategory;
  }
> = {
  start: {
    label: 'Start',
    icon: PlayCircle,
    color: 'text-accent-green',
    blurb: 'Entry point of the flow',
    category: 'flow',
  },
  send_message: {
    label: 'Send message',
    icon: MessageCircle,
    color: 'text-accent-blue',
    blurb: 'Sends a WhatsApp text message',
    category: 'messaging',
  },
  send_buttons: {
    label: 'Send buttons',
    icon: ListChecks,
    color: 'text-primary',
    blurb: 'Sends quick-reply buttons',
    category: 'messaging',
  },
  send_list: {
    label: 'Send list',
    icon: ListPlus,
    color: 'text-accent-violet',
    blurb: 'Sends a tappable list of options',
    category: 'messaging',
  },
  send_media: {
    label: 'Send media',
    icon: Paperclip,
    color: 'text-accent-cyan',
    blurb: 'Sends an image, video, or document',
    category: 'messaging',
  },
  send_template: {
    label: 'Template',
    icon: FileText,
    color: 'text-accent-blue',
    blurb: 'Sends an approved template — works past 24h',
    category: 'messaging',
  },
  send_products: {
    label: 'Products',
    icon: ShoppingBag,
    color: 'text-accent-green',
    blurb: 'Sends one product or a catalogue list',
    category: 'messaging',
  },
  collect_input: {
    label: 'Ask a question',
    icon: Inbox,
    color: 'text-accent-teal',
    blurb: 'Asks a question, saves the reply',
    category: 'capture',
  },
  ask_location: {
    label: 'Ask location',
    icon: MapPin,
    color: 'text-accent-red',
    blurb: 'Requests their location, saves the pin',
    category: 'capture',
  },
  ask_media: {
    label: 'Ask for a file',
    icon: Camera,
    color: 'text-accent-cyan',
    blurb: 'Asks for a photo or document, saves the URL',
    category: 'capture',
  },
  condition: {
    label: 'If / else',
    icon: GitFork,
    color: 'text-accent-purple',
    blurb: 'Branches on a rule',
    category: 'logic',
  },
  set_tag: {
    label: 'Tag contact',
    icon: Tag,
    color: 'text-accent-pink',
    blurb: 'Adds or removes a contact tag',
    category: 'logic',
  },
  set_segment: {
    label: 'Segment contact',
    icon: Layers,
    color: 'text-accent-orange',
    blurb: 'Adds or removes them from a saved audience',
    category: 'logic',
  },
  set_attribute: {
    label: 'Set attribute',
    icon: PencilLine,
    color: 'text-accent-violet',
    blurb: 'Saves a value onto the contact or a variable',
    category: 'logic',
  },
  http_request: {
    label: 'API request',
    icon: Webhook,
    color: 'text-accent-purple',
    blurb: 'Calls your API, saves the response',
    category: 'logic',
  },
  wait: {
    label: 'Wait',
    icon: Clock,
    color: 'text-accent-amber',
    blurb: 'Pauses the flow, continues later',
    category: 'flow',
  },
  start_flow: {
    label: 'Connect flow',
    icon: Waypoints,
    color: 'text-accent-teal',
    blurb: 'Hands the customer to another flow',
    category: 'flow',
  },
  handoff: {
    label: 'Handoff to agent',
    icon: UserPlus,
    color: 'text-accent-amber',
    blurb: 'Hands the conversation to a human',
    category: 'flow',
  },
  ai_handoff: {
    label: 'Hand to AI agent',
    icon: Bot,
    color: 'text-accent-pink',
    blurb: 'Lets an AI agent take the conversation',
    category: 'flow',
  },
  end: {
    label: 'End',
    icon: Flag,
    color: 'text-muted-foreground',
    blurb: 'Ends the flow',
    category: 'flow',
  },
};

/**
 * Every node type an author may ADD, in the order the palette and the
 * add-menus offer them.
 *
 * ⚠️ This is the ONE list. It used to be spelled out three times (the
 * list view's AddNodeButton, the canvas's ADD_NODE_TYPES, and the
 * shell's legend), which meant a new node type could ship visible in
 * one picker and missing from another — with nothing failing. Derive
 * from here, or from NODE_META, and never re-type it.
 */
export const ADDABLE_NODE_TYPES: NodeType[] = [
  'start',
  'send_message',
  'send_buttons',
  'send_list',
  'send_media',
  'send_template',
  'send_products',
  'collect_input',
  'ask_location',
  'ask_media',
  'condition',
  'wait',
  'set_tag',
  'set_segment',
  'set_attribute',
  'http_request',
  'start_flow',
  'handoff',
  'ai_handoff',
  'end',
];

/**
 * Bucket an ordered list of node types by category, preserving both
 * the category order (NODE_CATEGORIES) and the within-category order
 * of the input list. Empty categories are dropped. Used by both the
 * canvas and list add-step menus so they stay in lockstep.
 */
export function groupNodeTypesByCategory(
  types: NodeType[]
): { id: NodeCategory; label: string; types: NodeType[] }[] {
  return NODE_CATEGORIES.map(({ id, label }) => ({
    id,
    label,
    types: types.filter((t) => NODE_META[t].category === id),
  })).filter((group) => group.types.length > 0);
}

// ============================================================
// Per-node-type color system.
//
// Each node type gets its own hue so the canvas reads at a glance —
// what KIND of step is this. Kept as raw oklch (not Tailwind classes)
// so a node card can tint its icon chip, type label, selection ring,
// and edge ports from one source, the way the Flow Builder design
// handoff does. Hues sit in the same oklch family as the app tokens
// in globals.css; they don't replace --primary (the accent), they
// complement it. `nodeColors()` derives the soft/ring/text variants.
// ============================================================

const NODE_HUE: Record<NodeType, { l: number; c: number; h: number }> = {
  start: { l: 0.62, c: 0.13, h: 162 }, // emerald — the start, echoes WhatsApp green
  send_message: { l: 0.6, c: 0.18, h: 293 }, // violet — the workhorse
  send_buttons: { l: 0.62, c: 0.16, h: 254 }, // cobalt
  send_list: { l: 0.62, c: 0.15, h: 277 }, // indigo
  send_media: { l: 0.65, c: 0.12, h: 210 }, // sky
  collect_input: { l: 0.65, c: 0.1, h: 185 }, // teal — capture
  condition: { l: 0.72, c: 0.15, h: 65 }, // amber — a fork in the road
  set_tag: { l: 0.65, c: 0.15, h: 350 }, // pink
  set_segment: { l: 0.68, c: 0.13, h: 225 }, // cyan — a list, not a label
  set_attribute: { l: 0.62, c: 0.14, h: 310 }, // magenta — writes data
  http_request: { l: 0.6, c: 0.16, h: 265 }, // deep violet — leaves the building
  send_template: { l: 0.6, c: 0.14, h: 240 }, // steel blue — the formal one
  send_products: { l: 0.64, c: 0.14, h: 145 }, // green — commerce
  ask_location: { l: 0.63, c: 0.16, h: 30 }, // orange — a pin on a map
  ask_media: { l: 0.66, c: 0.11, h: 200 }, // pale sky — sibling of send_media
  wait: { l: 0.7, c: 0.1, h: 90 }, // olive — time passing
  start_flow: { l: 0.64, c: 0.12, h: 172 }, // sea green — hands on to another flow
  ai_handoff: { l: 0.66, c: 0.16, h: 330 }, // fuchsia — sibling of handoff's rose
  handoff: { l: 0.65, c: 0.17, h: 16 }, // rose — hands off
  end: { l: 0.55, c: 0.01, h: 260 }, // neutral grey — terminal
};

export interface NodeColors {
  /** Full-strength hue — icon glyph, selection ring, port fill. */
  solid: string;
  /** ~14% tint — icon chip background, soft fills. */
  soft: string;
  /** ~45% tint — hover border / focus ring. */
  ring: string;
  /** Hue for the uppercase type label, kept readable in BOTH modes. */
  text: string;
}

export function nodeColors(type: NodeType): NodeColors {
  const t = NODE_HUE[type];
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    soft: `oklch(${t.l} ${t.c} ${t.h} / 0.14)`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
    // Blend the hue toward the live --foreground token so the label
    // holds contrast in BOTH modes: in dark mode --foreground is
    // near-white (the label lightens to read on the dark card), in
    // light mode it's near-black (the label darkens to read on the
    // white card). The old fixed-light value only worked on dark.
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}

// ============================================================
// Shared node icon chip — the per-type colored glyph badge used in
// the canvas node card, list-view card, inspector header, and the
// add-step menu. One component so a styling change (radius, contrast,
// hover) lands in every place at once and the `nodeColors()` lookup
// lives in exactly one spot.
// ============================================================

export function NodeIconChip({
  type,
  size = 24,
  iconSize = 14,
  className,
}: {
  type: NodeType;
  /** Chip side length in px. */
  size?: number;
  /** Glyph side length in px. */
  iconSize?: number;
  className?: string;
}) {
  const meta = NODE_META[type];
  const c = nodeColors(type);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        className
      )}
      style={{ width: size, height: size, background: c.soft, color: c.solid }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

// ============================================================
// Pure editing helpers — used by forms in both views.
// ============================================================

/**
 * Coerce an arbitrary string into a stable identifier (node_key,
 * reply_id, etc.). Lowercases, collapses non-alphanumerics into
 * single underscores, and trims leading/trailing underscores. Falls
 * back to `fallback` for inputs that reduce to an empty string.
 */
export function slugify(s: string, fallback: string): string {
  const cleaned = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

// ============================================================
// Summary helpers — short, single-line content previews used in
// collapsed node cards (list view) and node tiles (canvas view).
// Returns null when there's nothing meaningful to show (start/end,
// or a freshly-added node with no fields filled in).
// ============================================================

export function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

export function summarizeNode(node: BuilderNode): string | null {
  const cfg = node.config;
  switch (node.node_type) {
    case 'start':
    case 'end':
      return null;
    case 'send_message': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      return text.length > 0 ? truncate(text) : null;
    }
    case 'send_buttons': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<Record<string, unknown>>)
        : [];
      const titles = buttons
        .map((b) => (typeof b.title === 'string' ? b.title : ''))
        .filter(Boolean)
        .join(' / ');
      if (text.length > 0) {
        return titles
          ? `${truncate(text, 40)} · ${truncate(titles, 35)}`
          : truncate(text);
      }
      return titles || null;
    }
    case 'send_list': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const sections = Array.isArray(cfg.sections)
        ? (cfg.sections as Array<Record<string, unknown>>)
        : [];
      const rowCount = sections.reduce<number>((sum, s) => {
        const rows = Array.isArray(s.rows) ? s.rows : [];
        return sum + rows.length;
      }, 0);
      if (text.length > 0) {
        return rowCount > 0
          ? `${truncate(text, 50)} · ${rowCount} option${rowCount === 1 ? '' : 's'}`
          : truncate(text);
      }
      return rowCount > 0
        ? `${rowCount} option${rowCount === 1 ? '' : 's'} across ${sections.length} section${sections.length === 1 ? '' : 's'}`
        : null;
    }
    case 'send_media': {
      const mediaType =
        typeof cfg.media_type === 'string' ? cfg.media_type : '';
      const filename = typeof cfg.filename === 'string' ? cfg.filename : '';
      const url = typeof cfg.media_url === 'string' ? cfg.media_url : '';
      const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
      const label = mediaType
        ? mediaType.charAt(0).toUpperCase() + mediaType.slice(1)
        : 'Media';
      if (!url) return `${label} (no file uploaded)`;
      const name = filename || url.split('/').pop() || 'file';
      return caption
        ? `${label}: ${truncate(name, 30)} · ${truncate(caption, 40)}`
        : `${label}: ${truncate(name, 60)}`;
    }
    case 'collect_input': {
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      if (prompt.length > 0) {
        return varKey
          ? `${truncate(prompt, 50)} → vars.${varKey}`
          : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case 'condition': {
      const subjectKey =
        typeof cfg.subject_key === 'string' ? cfg.subject_key : '';
      if (!subjectKey) return null;
      const subject =
        cfg.subject === 'tag'
          ? 'tag'
          : cfg.subject === 'contact_field'
            ? 'field'
            : 'var';
      const subjectStr =
        subject === 'tag'
          ? `has tag ${truncate(subjectKey, 24)}`
          : `${subject}.${subjectKey}`;
      const op =
        cfg.operator === 'equals'
          ? '=='
          : cfg.operator === 'contains'
            ? 'contains'
            : cfg.operator === 'present'
              ? 'exists'
              : cfg.operator === 'absent'
                ? 'missing'
                : '';
      const value = typeof cfg.value === 'string' ? cfg.value : '';
      const valStr =
        (cfg.operator === 'equals' || cfg.operator === 'contains') && value
          ? ` "${truncate(value, 20)}"`
          : '';
      return subject === 'tag' ? subjectStr : `${subjectStr} ${op}${valStr}`;
    }
    case 'set_tag': {
      const mode = cfg.mode === 'remove' ? 'Remove' : 'Add';
      const tagId = typeof cfg.tag_id === 'string' ? cfg.tag_id : '';
      // No tag name available without an async lookup here; show a
      // short prefix of the UUID so users can disambiguate between
      // multiple set_tag nodes at a glance.
      return tagId
        ? `${mode} tag ${tagId.slice(0, 8)}…`
        : `${mode} tag (none picked)`;
    }
    case 'set_segment': {
      const mode = cfg.mode === 'remove' ? 'Remove from' : 'Add to';
      const segmentId =
        typeof cfg.segment_id === 'string' ? cfg.segment_id : '';
      // Same reasoning as set_tag above: no name without an async
      // lookup, so a short id prefix is what distinguishes two nodes.
      return segmentId
        ? `${mode} segment ${segmentId.slice(0, 8)}…`
        : `${mode} segment (none picked)`;
    }
    case 'handoff': {
      const note = typeof cfg.note === 'string' ? cfg.note : '';
      return note.length > 0 ? truncate(note) : null;
    }
    case 'send_template': {
      const name =
        typeof cfg.template_name === 'string' ? cfg.template_name : '';
      const lang = typeof cfg.language === 'string' ? cfg.language : '';
      if (!name) return 'No template picked';
      return lang ? `${truncate(name, 40)} · ${lang}` : truncate(name);
    }
    case 'send_products': {
      const ids = Array.isArray(cfg.product_retailer_ids)
        ? (cfg.product_retailer_ids as unknown[]).filter(Boolean)
        : [];
      if (cfg.mode === 'list') {
        return ids.length > 0
          ? `${ids.length} product${ids.length === 1 ? '' : 's'}`
          : 'No products picked';
      }
      return ids.length > 0
        ? `Product ${truncate(String(ids[0]), 40)}`
        : 'No product picked';
    }
    case 'ask_location':
    case 'ask_media': {
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      if (prompt.length > 0) {
        return varKey
          ? `${truncate(prompt, 50)} → vars.${varKey}`
          : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case 'wait': {
      const duration = typeof cfg.duration === 'number' ? cfg.duration : 0;
      const unit = typeof cfg.unit === 'string' ? cfg.unit : 'minutes';
      if (duration <= 0) return 'No delay set';
      // Singularise so "1 hours" never ships.
      const label = duration === 1 ? unit.replace(/s$/, '') : unit;
      return `Wait ${duration} ${label}`;
    }
    case 'set_attribute': {
      const key = typeof cfg.key === 'string' ? cfg.key : '';
      const value = typeof cfg.value === 'string' ? cfg.value : '';
      if (!key) return 'Nothing to save yet';
      const prefix =
        cfg.target === 'var'
          ? 'vars.'
          : cfg.target === 'custom_field'
            ? 'custom.'
            : 'contact.';
      return value
        ? `${prefix}${key} = ${truncate(value, 30)}`
        : `${prefix}${key}`;
    }
    case 'http_request': {
      const method = typeof cfg.method === 'string' ? cfg.method : 'GET';
      const url = typeof cfg.url === 'string' ? cfg.url : '';
      return url ? `${method} ${truncate(url, 50)}` : 'No URL set';
    }
    case 'start_flow': {
      const flowId = typeof cfg.flow_id === 'string' ? cfg.flow_id : '';
      // Same reasoning as set_tag: the flow's name needs an async
      // lookup, so a short id prefix is what distinguishes two nodes.
      return flowId
        ? `Continue in flow ${flowId.slice(0, 8)}…`
        : 'No flow picked';
    }
    case 'ai_handoff': {
      const note = typeof cfg.note === 'string' ? cfg.note : '';
      const agentId = typeof cfg.agent_id === 'string' ? cfg.agent_id : '';
      const who = agentId ? `Agent ${agentId.slice(0, 8)}…` : 'Any agent';
      return note ? `${who} · ${truncate(note, 40)}` : who;
    }
  }
}

// ============================================================
// Per-node-type default config — what a freshly-added node holds.
//
// Lives here rather than in flow-editor-state so that pure consumers
// (the AI draft mapper) can reach it without importing the provider,
// which imports them back.
// ============================================================

export function defaultConfigFor(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'start':
      return { next_node_key: '' };
    case 'send_message':
      return { text: '', next_node_key: '' };
    case 'send_buttons':
      return {
        text: '',
        buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: '' }],
      };
    case 'send_list':
      return {
        text: '',
        button_label: 'View options',
        sections: [
          {
            title: '',
            rows: [{ reply_id: 'row_1', title: 'Option 1', next_node_key: '' }],
          },
        ],
      };
    case 'send_media':
      return {
        media_type: 'image',
        media_url: '',
        caption: '',
        filename: '',
        next_node_key: '',
      };
    case 'collect_input':
      return {
        prompt_text: '',
        var_key: 'answer',
        next_node_key: '',
      };
    case 'condition':
      return {
        subject: 'var',
        subject_key: '',
        operator: 'equals',
        value: '',
        true_next: '',
        false_next: '',
      };
    case 'set_tag':
      return { mode: 'add', tag_id: '', next_node_key: '' };
    case 'set_segment':
      return { mode: 'add', segment_id: '', next_node_key: '' };
    case 'set_attribute':
      return {
        target: 'contact_field',
        key: '',
        value: '',
        next_node_key: '',
      };
    case 'send_template':
      return {
        template_name: '',
        language: '',
        body_params: [],
        header_params: [],
        next_node_key: '',
      };
    case 'send_products':
      return {
        mode: 'single',
        catalog_id: '',
        product_retailer_ids: [''],
        body_text: '',
        next_node_key: '',
      };
    case 'ask_location':
      return { prompt_text: '', var_key: 'location', next_node_key: '' };
    case 'ask_media':
      return {
        prompt_text: '',
        var_key: 'file',
        accept: 'any',
        next_node_key: '',
      };
    case 'wait':
      // An hour, not a minute: the common use is "give them time before
      // we nudge", and a default measured in minutes reads as a
      // throttle rather than a pause.
      return { duration: 1, unit: 'hours', next_node_key: '' };
    case 'http_request':
      return {
        method: 'GET',
        url: '',
        headers: {},
        body: '',
        response_var: 'api',
        fail_on_error: false,
        next_node_key: '',
      };
    case 'start_flow':
      return { flow_id: '' };
    case 'handoff':
      return { note: '' };
    case 'ai_handoff':
      // No agent_id by default — normal routing picks, which respects
      // the priority order the workspace already set.
      return { note: '' };
    case 'end':
      return {};
  }
}
