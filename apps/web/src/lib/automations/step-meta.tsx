/**
 * One registry for everything the automation editor needs to know about
 * a step type: what it is called, what it looks like, what an empty one
 * contains, and how to summarise a configured one in a line.
 *
 * WHY A REGISTRY AND NOT SWITCHES SPREAD ACROSS THE UI
 *   There are ~25 step types across the canvas card, the add menu, the
 *   inspector header and the token picker. Before this, adding one meant
 *   editing four switch statements and finding out about the fifth from
 *   a bug report. Adding a type is now one entry here plus one form.
 *
 * COLOUR
 *   Mirrors the flows canvas (`components/flows/shared.tsx`): raw oklch
 *   hues, with soft/ring/text derived, so a card can tint its chip, its
 *   label and its ports from one source. Hue is assigned by CATEGORY,
 *   not per type — 25 individually-coloured nodes is noise, and the
 *   thing a reader needs at a glance is "is this a send, a branch, or a
 *   data step".
 */

import {
  ArrowRightLeft,
  Braces,
  Briefcase,
  Calendar,
  CircleSlash,
  Clock,
  FileText,
  GitBranch,
  Globe,
  Hourglass,
  Image as ImageIcon,
  Layers,
  ListChecks,
  MessageSquare,
  PencilLine,
  Plug,
  Repeat2,
  Shuffle,
  SquareStack,
  StickyNote,
  Tag,
  TagIcon,
  UserCheck,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AutomationStepType } from '@/types';

// ============================================================
// Categories — the buckets the add menu groups by, in menu order.
// ============================================================

export type StepCategory =
  | 'messaging'
  | 'contact'
  | 'crm'
  | 'conversation'
  | 'logic'
  | 'data'
  | 'orchestration';

export const STEP_CATEGORIES: { id: StepCategory; label: string }[] = [
  { id: 'messaging', label: 'Messaging' },
  { id: 'contact', label: 'Contact' },
  { id: 'crm', label: 'Deals & team' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'logic', label: 'Logic & timing' },
  { id: 'data', label: 'Data' },
  { id: 'orchestration', label: 'Orchestration' },
];

/**
 * Hue per CATEGORY, not per type.
 *
 * Flows gives each of its 11 node types a hue. With 24 step types that
 * becomes noise: colour should answer "what kind of thing is this", and
 * the icon and title answer "which one".
 *
 * Seven of these are lifted verbatim from `NODE_HUE` in
 * `components/flows/shared.tsx`, matched on MEANING — a message is
 * violet in both editors, a branch is amber in both, a tag is pink in
 * both. Only `crm` is new, because flows has no concept of a deal.
 */
const CATEGORY_HUE: Record<
  StepCategory | 'trigger' | 'neutral',
  { l: number; c: number; h: number }
> = {
  trigger: { l: 0.62, c: 0.13, h: 162 }, // emerald — = flows `start`
  messaging: { l: 0.6, c: 0.18, h: 293 }, // violet — = flows `send_message`
  contact: { l: 0.65, c: 0.15, h: 350 }, // pink — = flows `set_tag`
  crm: { l: 0.66, c: 0.16, h: 20 }, // coral — new
  conversation: { l: 0.68, c: 0.13, h: 225 }, // azure — = flows `set_segment`
  logic: { l: 0.72, c: 0.15, h: 65 }, // amber — = flows `condition`
  data: { l: 0.65, c: 0.1, h: 185 }, // teal — = flows `collect_input`
  orchestration: { l: 0.62, c: 0.16, h: 254 }, // cobalt — = flows `send_buttons`
  neutral: { l: 0.55, c: 0.01, h: 260 }, // grey — = flows `end`
};

export interface StepColors {
  /** Raw hue. DECORATIVE ONLY — minimap dots. Never a stroke, never a glyph. */
  solid: string;
  /**
   * Every stroke, port, glyph and selected border.
   *
   * WHY THIS EXISTS SEPARATELY FROM `solid`
   *   The flows canvas paints handles and selected borders with the raw
   *   hue. Against `--card` in LIGHT mode that measures 2.53:1 for amber
   *   — under WCAG 1.4.11's 3:1 floor for non-text UI. Mixing 22% toward
   *   `--foreground` lifts the worst case to 3.81:1 and, because
   *   `--foreground` inverts with the theme, always moves AWAY from the
   *   card. One declaration, both modes, no `dark:` variant.
   */
  line: string;
  /** Icon-chip fill / branch wash. Decorative: the glyph carries meaning. */
  soft: string;
  /** Selection glow. */
  ring: string;
  /** The uppercase category label. ≥5.1:1 in both modes. */
  text: string;
}

function colorsForCategory(
  cat: StepCategory | 'trigger' | 'neutral'
): StepColors {
  const t = CATEGORY_HUE[cat];
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    line: `color-mix(in oklch, ${solid}, var(--foreground) 22%)`,
    // ALPHA, not `color-mix(… , var(--card))`.
    //
    // `--card` has non-zero chroma, so its hue is not powerless and
    // participates at 84% weight in an oklch mix — which dragged every
    // category's chip to roughly the same pale blue (h244–h286) and
    // destroyed the one thing the chip is for. Alpha over the card
    // preserves the hue exactly, which is what the flows canvas does.
    soft: `oklch(${t.l} ${t.c} ${t.h} / 0.14)`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}

export function stepColors(type: AutomationStepType): StepColors {
  return colorsForCategory(STEP_META[type]?.category ?? 'logic');
}

/** The trigger is not a step, but it renders as a node and needs a hue. */
export const TRIGGER_COLORS = colorsForCategory('trigger');
/** A disabled card drops its hue entirely — that is the point of it. */
export const NEUTRAL_COLORS = colorsForCategory('neutral');

// ============================================================
// The registry
// ============================================================

export interface StepMeta {
  label: string;
  icon: LucideIcon;
  category: StepCategory;
  /** One line in the add menu — what it does, not how. */
  blurb: string;
  /** Owns yes/no branches on the canvas. */
  branching?: boolean;
  /** Suspends the run; the canvas marks these so a reader can see why
   *  everything downstream is delayed. */
  suspends?: boolean;
  /** Publishes an output later steps can read as {{ steps.<key>.… }}. */
  outputs?: { path: string; label: string }[];
  /** Hidden from the add menu — kept only so old automations still open. */
  deprecated?: boolean;
  /**
   * Hidden from the add menu because it is offered a BETTER way.
   *
   * Distinct from `deprecated`, which means "do not use this any more".
   * `app_action` is hidden because the dialog lists connected apps and
   * their individual actions instead — the step type is current, it just
   * has no useful generic entry.
   */
  hidden?: boolean;
}

export const STEP_META: Record<AutomationStepType, StepMeta> = {
  // ---- Messaging -------------------------------------------------
  send_message: {
    label: 'Send message',
    icon: MessageSquare,
    category: 'messaging',
    blurb: 'Plain text on whichever channel the contact wrote from',
    outputs: [{ path: 'message_id', label: 'Message id' }],
  },
  send_template: {
    label: 'Send template',
    icon: FileText,
    category: 'messaging',
    blurb: 'An approved WhatsApp template, with variables',
  },
  send_media: {
    label: 'Send media',
    icon: ImageIcon,
    category: 'messaging',
    blurb: 'Image, video, document or audio by URL',
    outputs: [{ path: 'message_id', label: 'Message id' }],
  },
  send_buttons: {
    label: 'Send buttons',
    icon: ListChecks,
    category: 'messaging',
    blurb: 'Up to 3 quick replies the contact can tap',
    outputs: [
      { path: 'message_id', label: 'Message id' },
      { path: 'button_ids', label: 'Button ids' },
    ],
  },
  send_list: {
    label: 'Send list',
    icon: SquareStack,
    category: 'messaging',
    blurb: 'A menu of up to 10 options (not available on Instagram)',
    outputs: [{ path: 'message_id', label: 'Message id' }],
  },
  send_form: {
    label: 'Send form',
    icon: FileText,
    category: 'messaging',
    blurb: 'Sends a link to one of your published forms',
  },
  send_booking_link: {
    label: 'Send booking link',
    icon: Calendar,
    category: 'messaging',
    blurb: 'Sends a link to pick an appointment slot',
  },

  // ---- Contact ---------------------------------------------------
  add_tag: {
    label: 'Add tag',
    icon: Tag,
    category: 'contact',
    blurb: 'Labels the contact',
  },
  remove_tag: {
    label: 'Remove tag',
    icon: TagIcon,
    category: 'contact',
    blurb: 'Takes a label off the contact',
  },
  add_to_segment: {
    label: 'Add to segment',
    icon: Layers,
    category: 'contact',
    blurb: 'Files them into a named audience (static segments only)',
  },
  remove_from_segment: {
    label: 'Remove from segment',
    icon: Layers,
    category: 'contact',
    blurb: 'Takes them out of a named audience',
  },
  update_contact_field: {
    label: 'Update contact field',
    icon: PencilLine,
    category: 'contact',
    blurb: 'Writes a built-in or custom field',
  },
  add_note: {
    label: 'Add note',
    icon: StickyNote,
    category: 'contact',
    blurb: 'Internal note on their timeline — the contact never sees it',
    outputs: [{ path: 'note_id', label: 'Note id' }],
  },

  // ---- Deals & team ----------------------------------------------
  create_deal: {
    label: 'Create deal',
    icon: Briefcase,
    category: 'crm',
    blurb: 'Opens a deal in a pipeline stage',
    outputs: [
      { path: 'deal_id', label: 'Deal id' },
      { path: 'title', label: 'Deal title' },
    ],
  },
  update_deal: {
    label: 'Update deal',
    icon: ArrowRightLeft,
    category: 'crm',
    blurb: 'Moves a stage, marks won/lost, or changes the value',
    outputs: [{ path: 'deal_id', label: 'Deal id' }],
  },
  notify_team: {
    label: 'Notify team',
    icon: Zap,
    category: 'crm',
    blurb: 'In-app notification for a teammate or everyone',
    outputs: [{ path: 'notified', label: 'People notified' }],
  },

  // ---- Conversation ----------------------------------------------
  assign_conversation: {
    label: 'Assign conversation',
    icon: UserCheck,
    category: 'conversation',
    blurb: 'Hands the thread to an agent',
  },
  set_conversation_status: {
    label: 'Set status',
    icon: CircleSlash,
    category: 'conversation',
    blurb: 'Open, pending or closed',
  },
  close_conversation: {
    label: 'Close conversation',
    icon: CircleSlash,
    category: 'conversation',
    blurb: 'Marks the thread closed',
    // Superseded by set_conversation_status, which does this and more.
    // Kept readable, dropped from the menu.
    deprecated: true,
  },

  // ---- Logic & timing --------------------------------------------
  condition: {
    label: 'Condition',
    icon: GitBranch,
    category: 'logic',
    blurb: 'Splits the path on one or more rules',
    branching: true,
    outputs: [{ path: 'branch', label: 'Branch taken' }],
  },
  random_split: {
    label: 'Random split',
    icon: Shuffle,
    category: 'logic',
    blurb: 'Sends a percentage down each path — for A/B tests',
    branching: true,
    outputs: [{ path: 'branch', label: 'Branch taken' }],
  },
  wait: {
    label: 'Wait',
    icon: Hourglass,
    category: 'logic',
    blurb: 'Pauses for a duration, then carries on',
    suspends: true,
  },
  wait_until: {
    label: 'Wait until',
    icon: Clock,
    category: 'logic',
    blurb: 'Pauses until a time of day — e.g. 9am on a weekday',
    suspends: true,
  },

  // ---- Data & integrations ---------------------------------------
  http_request: {
    label: 'HTTP request',
    icon: Globe,
    category: 'data',
    blurb: 'Calls an API and keeps the response for later steps',
    outputs: [
      { path: 'status', label: 'Status code' },
      { path: 'ok', label: 'Succeeded (true/false)' },
      { path: 'body', label: 'Response body' },
      { path: 'headers', label: 'Response headers' },
      { path: 'duration_ms', label: 'Duration (ms)' },
    ],
  },
  send_webhook: {
    label: 'Send webhook',
    icon: Webhook,
    category: 'data',
    blurb: 'Posts to a URL and forgets about it',
    // Everything this does, HTTP request does with a readable response.
    deprecated: true,
    outputs: [
      { path: 'status', label: 'Status code' },
      { path: 'body', label: 'Response body' },
    ],
  },
  /**
   * A connected-app action.
   *
   * ⚠️ THIS ENTRY IS A FALLBACK, NOT WHAT USERS NORMALLY SEE.
   *   One step type covers every app and every action, so a static label
   *   here would put "App action" on a card that is really "Google
   *   Sheets: Append row". `appActionLabel()` below resolves the real
   *   one from the catalogue plus the step's own config; the node card
   *   and the inspector both call it. These values only show while the
   *   catalogue is still loading, or for an app that has since been
   *   removed.
   *
   *   It is also absent from ADDABLE_STEPS (via `hidden`): the add
   *   dialog lists connected apps and their actions individually, which
   *   is the discoverable form. A generic "App action" entry alongside
   *   them would be a second, worse route to the same thing.
   */
  app_action: {
    label: 'App action',
    icon: Plug,
    category: 'data',
    blurb: 'Runs an action on a connected app',
    hidden: true,
    deprecated: true,
    outputs: [],
  },
  google_action: {
    label: 'Google action',
    icon: Zap,
    category: 'data',
    blurb: 'Runs an action via the Google Apps Script bridge',
    hidden: true,
    // Real outputs are per action and come from the catalogue —
    // `outputsForStep()` merges them in for the token picker.
    outputs: [],
  },
  set_variable: {
    label: 'Set variable',
    icon: Braces,
    category: 'data',
    blurb: 'Stores a value for later steps to reuse',
    outputs: [
      { path: 'name', label: 'Variable name' },
      { path: 'value', label: 'Value' },
    ],
  },
  // ---- Orchestration ---------------------------------------------
  start_flow: {
    label: 'Start flow',
    icon: Workflow,
    category: 'orchestration',
    blurb: 'Hands the contact to a conversational flow',
    outputs: [
      { path: 'started', label: 'Started (true/false)' },
      { path: 'flow_run_id', label: 'Flow run id' },
    ],
  },
  run_automation: {
    label: 'Run automation',
    icon: Repeat2,
    category: 'orchestration',
    blurb: 'Runs another automation with this run’s data',
    outputs: [{ path: 'automation_id', label: 'Automation id' }],
  },
};

/** Types offered in the add menu, in category order. Deprecated types
 *  are readable but not offerable — see STEP_META.deprecated. `hidden`
 *  ones are current but offered a better way (see `app_action`). */
export const ADDABLE_STEPS: AutomationStepType[] = STEP_CATEGORIES.flatMap(
  (category) =>
    (Object.keys(STEP_META) as AutomationStepType[]).filter(
      (type) =>
        STEP_META[type].category === category.id &&
        !STEP_META[type].deprecated &&
        !STEP_META[type].hidden
    )
);

/**
 * What a step is actually called, for `app_action` steps (DEPRECATED).
 */
export function appActionLabel(
  config: { app?: string; action?: string } | undefined,
  apps: {
    app: string;
    name: string;
    actions: { id: string; label: string }[];
  }[]
): string {
  const appId = config?.app;
  const actionId = config?.action;
  if (!appId || !actionId) return STEP_META.app_action.label;

  const app = apps.find((a) => a.app === appId);
  const action = app?.actions.find((a) => a.id === actionId);
  return `${app?.name ?? appId}: ${action?.label ?? actionId}`;
}

/**
 * What a step is actually called, for `google_action` steps.
 *
 * The card, the inspector header and the diagnostics list all show a
 * step's name, and for a Google action that name lives in the bridge
 * catalogue rather than in STEP_META. Falling back to the action id
 * means a catalogue that has not loaded yet still renders something
 * recognisable — "sheet_append" beats "Google action".
 */
export function googleActionLabel(
  config: { action?: string } | undefined,
  actions: { id: string; label: string; service: string }[],
  serviceLabels?: Record<string, string>
): string {
  const actionId = config?.action;
  if (!actionId) return STEP_META.google_action.label;

  const action = actions.find((a) => a.id === actionId);
  if (!action) return actionId;
  const serviceName = serviceLabels?.[action.service] ?? action.service;
  return `${serviceName} · ${action.label}`;
}

export function groupStepsByCategory(types: AutomationStepType[]): {
  id: StepCategory;
  label: string;
  types: AutomationStepType[];
}[] {
  return STEP_CATEGORIES.map((c) => ({
    ...c,
    types: types.filter((t) => STEP_META[t]?.category === c.id),
  })).filter((g) => g.types.length > 0);
}

// ============================================================
// Icon chip — the per-type coloured glyph used on the card, in the
// inspector header and in the add menu. One component so a styling
// change lands everywhere at once.
// ============================================================

export function StepIconChip({
  type,
  size = 26,
  iconSize = 14,
  className,
}: {
  type: AutomationStepType;
  size?: number;
  iconSize?: number;
  className?: string;
}) {
  const meta = STEP_META[type];
  const c = stepColors(type);
  const Icon = meta?.icon ?? MessageSquare;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        className
      )}
      // `line`, never `solid`: the raw hue measures 2.2–2.9:1 for six of
      // the nine categories against the chip in light mode, under WCAG
      // 1.4.11's 3:1 for a meaningful glyph.
      style={{ width: size, height: size, background: c.soft, color: c.line }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

// ============================================================
// Blank configs
// ============================================================

/**
 * What a freshly-added step contains.
 *
 * Defaults are chosen so a step is as close to runnable as honesty
 * allows: `http_request` defaults to POST + a JSON body builder (the
 * shape that cannot produce malformed JSON), `wait` to one hour, a
 * condition to one empty rule so the editor has a row to render.
 */
export function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case 'send_message':
      return { text: '' };
    case 'send_template':
      return { template_name: '', language: 'en_US', variables: {} };
    case 'send_media':
      return { kind: 'image', link: '', caption: '' };
    case 'send_buttons':
      return {
        body_text: '',
        buttons: [{ id: 'btn_1', title: '' }],
      };
    case 'send_list':
      return {
        body_text: '',
        button_label: 'Choose',
        sections: [{ title: 'Options', rows: [{ id: 'row_1', title: '' }] }],
      };
    case 'send_form':
      return { form_id: '', message_text: '' };
    case 'send_booking_link':
      return { appointment_type_id: '', message_text: '' };
    case 'add_tag':
    case 'remove_tag':
      return { tag_id: '' };
    case 'add_to_segment':
    case 'remove_from_segment':
      return { segment_id: '' };
    case 'update_contact_field':
      return { field: 'name', value: '' };
    case 'add_note':
      return { text: '' };
    case 'assign_conversation':
      return { mode: 'round_robin' };
    case 'set_conversation_status':
      return { status: 'closed' };
    case 'close_conversation':
      return {};
    case 'create_deal':
      return { pipeline_id: '', stage_id: '', title: '', value: 0 };
    case 'update_deal':
      return { target: 'latest_for_contact', stage_id: '' };
    case 'notify_team':
      return { recipient: 'all', title: '', body: '' };
    case 'wait':
      return { amount: 1, unit: 'hours' };
    case 'wait_until':
      return { time: '09:00', timezone: 'UTC', days: [] };
    case 'condition':
      return {
        match: 'all',
        rules: [{ subject: 'tag_presence', operand: '', operator: 'equals' }],
      };
    case 'random_split':
      return { percent: 50 };
    case 'http_request':
      return {
        method: 'POST',
        url: '',
        headers: {},
        query: {},
        body_mode: 'json',
        body_fields: {},
        timeout_seconds: 10,
      };
    case 'send_webhook':
      return { url: '', headers: {}, body_mode: 'raw', body_template: '' };
    case 'set_variable':
      return { name: '', value: '' };
    case 'start_flow':
      return { flow_id: '' };
    case 'run_automation':
      return { automation_id: '' };
    default:
      return {};
  }
}

// ============================================================
// One-line summaries for the collapsed canvas card
// ============================================================

export function truncate(s: string, max = 64): string {
  const clean = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

/**
 * The line under the title on a canvas card.
 *
 * Returns null when there is nothing meaningful yet — an empty line
 * reads as "this step does nothing", which for a half-built step is the
 * truth and is better than a placeholder pretending otherwise.
 */
export function summarizeStep(
  type: AutomationStepType,
  cfg: Record<string, unknown>
): string | null {
  const s = (k: string) =>
    typeof cfg[k] === 'string' ? (cfg[k] as string) : '';
  switch (type) {
    case 'send_message':
      return s('text') ? truncate(s('text')) : null;
    case 'send_template':
      return s('template_name') || null;
    case 'send_media':
      return s('link')
        ? `${cfg.kind ?? 'image'} · ${truncate(s('link'), 40)}`
        : null;
    case 'send_buttons': {
      const buttons = Array.isArray(cfg.buttons) ? cfg.buttons : [];
      const titles = buttons
        .map((b) => (b as { title?: string })?.title)
        .filter(Boolean);
      return titles.length > 0 ? truncate(titles.join(' · ')) : null;
    }
    case 'send_list': {
      const sections = Array.isArray(cfg.sections) ? cfg.sections : [];
      const rows = sections.reduce(
        (n, sec) =>
          n +
          (Array.isArray((sec as { rows?: unknown[] })?.rows)
            ? (sec as { rows: unknown[] }).rows.length
            : 0),
        0
      );
      return rows > 0 ? `${rows} option${rows === 1 ? '' : 's'}` : null;
    }
    case 'update_contact_field':
      return s('field')
        ? `${s('field')} = ${truncate(s('value'), 24) || '—'}`
        : null;
    case 'add_note':
      return s('text') ? truncate(s('text')) : null;
    case 'create_deal':
      return s('title') ? truncate(s('title')) : null;
    case 'update_deal':
      return cfg.status
        ? `mark ${String(cfg.status)}`
        : cfg.stage_id
          ? 'move stage'
          : null;
    case 'notify_team':
      return s('title') ? truncate(s('title')) : null;
    case 'assign_conversation':
      return cfg.mode === 'specific' ? 'to a specific agent' : 'round-robin';
    case 'set_conversation_status':
      return `set to ${String(cfg.status ?? 'open')}`;
    case 'wait':
      return `${cfg.amount ?? '?'} ${cfg.unit ?? ''}`.trim();
    case 'wait_until': {
      // Instant mode reads completely differently on the node — "09:00
      // UTC" would be a lie for a step that waits for a booking.
      const instant = s('instant');
      if (instant) {
        const offset = Number(cfg.offset_minutes) || 0;
        if (offset === 0) return 'at the trigger’s time';
        return offset < 0
          ? `${Math.abs(offset)} min before the trigger’s time`
          : `${offset} min after the trigger’s time`;
      }
      const days = Array.isArray(cfg.days) ? (cfg.days as number[]) : [];
      const when = s('time') || '09:00';
      return days.length > 0
        ? `${when} on ${days.length} day(s)`
        : `${when} ${s('timezone') || 'UTC'}`;
    }
    case 'condition': {
      const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
      if (rules.length === 0) {
        // Legacy single-rule shape — still live in existing automations.
        return cfg.subject
          ? `if ${String(cfg.subject).replace(/_/g, ' ')}`
          : null;
      }
      const first = rules[0] as { subject?: string };
      const rest = rules.length - 1;
      return `if ${String(first?.subject ?? '?').replace(/_/g, ' ')}${
        rest > 0 ? ` +${rest} more` : ''
      }`;
    }
    case 'random_split':
      return `${cfg.percent ?? 50}% / ${100 - Number(cfg.percent ?? 50)}%`;
    case 'http_request':
    case 'send_webhook':
      return s('url')
        ? `${String(cfg.method ?? 'POST')} ${truncate(s('url'), 40)}`
        : null;
    case 'set_variable':
      return s('name')
        ? `${s('name')} = ${truncate(s('value'), 24) || '—'}`
        : null;
    default:
      return null;
  }
}
