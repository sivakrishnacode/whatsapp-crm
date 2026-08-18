/**
 * Pre-flight checks for an automation.
 *
 * WHY THIS EXISTS AT ALL
 *   Almost every way an automation can be wrong is SILENT at run time,
 *   by design:
 *     - an unknown token resolves to an empty string, because a visible
 *       `{{vars.name}}` in a customer's chat is worse than a gap;
 *     - a step the channel cannot do is skipped, so the rest of the run
 *       still happens;
 *     - a step with no contact is skipped for the same reason.
 *   Each of those is the right run-time behaviour and together they mean
 *   a broken automation looks exactly like a working one until a
 *   customer notices. The engine cannot afford to be loud; the editor
 *   can, and this is where it is.
 *
 * THREE LEVELS, AND THE DIFFERENCE MATTERS
 *   error   — will not work, or will not work anywhere. Blocks nothing
 *             locally (the server decides that), but must be fixed.
 *   warning — works sometimes, or works differently from what the shape
 *             of the automation suggests. Often deliberate.
 *   info    — a better way exists.
 *
 * This is a MIRROR of run-time behaviour, never the authority:
 * `apps/api/src/automations/services/automation-validate.ts` is what
 * blocks activation, and the executor is what actually decides. Where
 * they disagree, this file is the bug.
 */

import {
  flattenSteps,
  findStep,
  type BuilderStep,
} from '@/lib/automations/graph';
import { STEP_META } from '@/lib/automations/step-meta';
import {
  stepAvailability,
  type Availability,
} from '@/lib/automations/availability';
import { validateStep } from '@/lib/automations/validate';
import { declaredVariables, precedingSteps } from '@/lib/automations/tokens';
import type {
  AppConnection,
  CatalogApp,
  GoogleScriptAction,
  GoogleScriptConnection,
} from '@/lib/automations/connectors';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Which step it is about; null for whole-automation findings. */
  stepKey: string | null;
  title: string;
  detail: string;
}

export interface DiagnosticsInput {
  steps: BuilderStep[];
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  channels: string[];
  isActive: boolean;
  /** Optional account context — each check degrades if it is absent. */
  segments?: { id: string; name: string; kind?: string }[];
  flows?: { id: string; name: string; status?: string }[];
  automations?: { id: string; name: string; is_active?: boolean }[];
  /** Connected-app catalogue + this workspace's connections. */
  apps?: CatalogApp[];
  connections?: AppConnection[];
  /** Google Script bridge catalogue and connection status. */
  googleActions?: GoogleScriptAction[];
  googleConnection?: GoogleScriptConnection | null;
  currentAutomationId?: string;
}

/** WhatsApp closes the free-reply window 24h after the customer's last
 *  message. Past it, only a template sends. */
const WHATSAPP_WINDOW_MINUTES = 24 * 60;

const WAIT_UNIT_MINUTES: Record<string, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

/** Steps that put a message in front of the contact. */
const SENDING_STEPS = new Set<AutomationStepType>([
  'send_message',
  'send_media',
  'send_buttons',
  'send_list',
  'send_form',
  'send_booking_link',
]);

export function runDiagnostics(input: DiagnosticsInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const flat = flattenSteps(input.steps);

  if (flat.length === 0) {
    out.push({
      level: input.isActive ? 'error' : 'info',
      stepKey: null,
      title: 'This automation does nothing',
      detail:
        'It has a trigger but no steps, so firing it has no effect. Add a step below the trigger.',
    });
    return out;
  }

  checkDuplicateKeys(flat, out);
  checkTrigger(input, out);

  for (const { step } of flat) {
    checkRequiredFields(step, out);
    checkAvailability(step, input, out);
    checkTokens(step, input, out);
    checkStepSpecifics(step, input, out);
    checkBranches(step, out);
  }

  checkReplyWindow(input, out);
  checkAfterClose(input, out);

  return out;
}

// ============================================================
// Whole-automation checks
// ============================================================

function checkDuplicateKeys(
  flat: ReturnType<typeof flattenSteps>,
  out: Diagnostic[]
): void {
  const seen = new Map<string, number>();
  for (const { step } of flat) {
    seen.set(step.key, (seen.get(step.key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      out.push({
        level: 'error',
        stepKey: key,
        title: `Two steps are both called “${key}”`,
        detail:
          'A reference name has to be unique — a token like {{ steps.' +
          key +
          '.… }} cannot say which one it means. Rename one of them.',
      });
    }
  }
}

function checkTrigger(input: DiagnosticsInput, out: Diagnostic[]): void {
  const cfg = input.triggerConfig ?? {};

  if (
    (input.triggerType === 'keyword_match' ||
      input.triggerType === 'instagram_comment' ||
      input.triggerType === 'instagram_story_reply') &&
    (!Array.isArray(cfg.keywords) || cfg.keywords.length === 0)
  ) {
    out.push({
      level: 'error',
      stepKey: null,
      title: 'No keywords set',
      detail:
        'A keyword trigger with no keywords never matches, so this automation will never run.',
    });
  }

  if (
    input.triggerType === 'time_based' &&
    !String(cfg.schedule ?? '').trim()
  ) {
    out.push({
      level: 'error',
      stepKey: null,
      title: 'No schedule set',
      detail: 'A scheduled automation needs a time or a cron expression.',
    });
  }

  if (input.triggerType === 'tag_added' && !String(cfg.tag_id ?? '').trim()) {
    out.push({
      level: 'error',
      stepKey: null,
      title: 'No tag chosen',
      detail: 'Pick the tag whose arrival should start this automation.',
    });
  }
}

/**
 * A plain message sent more than 24 hours after the contact wrote is
 * refused by WhatsApp.
 *
 * The waits are summed along each path, so a "wait 2 days then follow
 * up" automation — the single most common shape there is — gets told
 * before it silently stops delivering on WhatsApp.
 */
function checkReplyWindow(input: DiagnosticsInput, out: Diagnostic[]): void {
  const scoped = input.channels.length === 0 ? ['whatsapp'] : input.channels;
  if (!scoped.includes('whatsapp')) return;

  const walk = (list: BuilderStep[], minutesSoFar: number): void => {
    let elapsed = minutesSoFar;
    for (const step of list) {
      if (step.step_type === 'wait') {
        const amount = Number(step.step_config.amount ?? 0);
        const unit = String(step.step_config.unit ?? 'hours');
        elapsed +=
          (Number.isFinite(amount) ? amount : 0) *
          (WAIT_UNIT_MINUTES[unit] ?? 60);
      }
      if (step.step_type === 'wait_until') {
        // Unknown in the general case — it depends what time the run
        // started. Up to 24h is the honest bound for a daily time.
        elapsed += WHATSAPP_WINDOW_MINUTES;
      }

      if (
        SENDING_STEPS.has(step.step_type) &&
        elapsed >= WHATSAPP_WINDOW_MINUTES
      ) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: 'Outside WhatsApp’s 24-hour window',
          detail:
            `About ${formatMinutes(elapsed)} of waiting happens before this step, and WhatsApp only allows a free-form message within 24 hours of the contact’s last one. ` +
            'Use a Send template step here, or shorten the wait.',
        });
      }

      if (step.branches) {
        walk(step.branches.yes, elapsed);
        walk(step.branches.no, elapsed);
      }
    }
  };

  walk(input.steps, 0);
}

/**
 * Sending after closing the conversation.
 *
 * Not fatal — the send still goes out — but it reopens a thread the
 * automation just closed, which is never what the author drew.
 */
function checkAfterClose(input: DiagnosticsInput, out: Diagnostic[]): void {
  const walk = (list: BuilderStep[], closed: boolean): void => {
    let isClosed = closed;
    for (const step of list) {
      if (SENDING_STEPS.has(step.step_type) && isClosed) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: 'Sends after closing the conversation',
          detail:
            'An earlier step closed this thread. Sending now reopens it, so the automation ends with an open conversation — probably not what was intended. Move the close step to the end.',
        });
      }
      if (
        step.step_type === 'close_conversation' ||
        (step.step_type === 'set_conversation_status' &&
          step.step_config.status === 'closed')
      ) {
        isClosed = true;
      }
      if (step.branches) {
        walk(step.branches.yes, isClosed);
        walk(step.branches.no, isClosed);
      }
    }
  };
  walk(input.steps, false);
}

// ============================================================
// Per-step checks
// ============================================================

function checkRequiredFields(step: BuilderStep, out: Diagnostic[]): void {
  for (const issue of validateStep(step)) {
    out.push({
      level: 'error',
      stepKey: step.key,
      title: issue.message,
      detail: `${STEP_META[step.step_type]?.label ?? step.step_type} is missing something it needs before it can run.`,
    });
  }
}

function checkAvailability(
  step: BuilderStep,
  input: DiagnosticsInput,
  out: Diagnostic[]
): void {
  const availability: Availability = stepAvailability(
    step.step_type,
    input.channels,
    input.triggerType
  );
  if (availability.status === 'ok' || !availability.reason) return;
  out.push({
    level: availability.status === 'never' ? 'error' : 'warning',
    stepKey: step.key,
    title:
      availability.status === 'never'
        ? 'This step can never run'
        : 'This step is skipped on some channels',
    detail: availability.reason,
  });
}

/**
 * Every `{{ … }}` in a step's config, checked against what that step can
 * actually see.
 *
 * This is the check that pays for the whole file: a token pointing at a
 * renamed or deleted step resolves to an empty string, so the message
 * still sends — with a hole in it.
 */
function checkTokens(
  step: BuilderStep,
  input: DiagnosticsInput,
  out: Diagnostic[]
): void {
  // Before the early return below: an unclosed `{{` produces NO parsed
  // tokens, so checking it after "are there any tokens?" meant the one
  // case where the braces reach the customer verbatim was the one case
  // that went unreported.
  checkMalformedTokens(step, out);

  const tokens = collectTokens(step.step_config);
  if (tokens.length === 0) return;

  const upstream = new Set(
    precedingSteps(input.steps, step.key).map((p) => p.step.key)
  );
  const variables = new Set(declaredVariables(input.steps));

  for (const token of tokens) {
    const [namespace, name] = token.split('.');

    if (namespace === 'steps') {
      if (!name) continue;
      const exists = findStep(input.steps, name);
      if (!exists) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `No step called “${name}”`,
          detail:
            `{{ ${token} }} refers to a step that does not exist — it was renamed or deleted. ` +
            'At run time it resolves to nothing and the message sends with a gap in it.',
        });
        continue;
      }
      if (!upstream.has(name)) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `“${name}” has not run yet`,
          detail:
            `{{ ${token} }} refers to a step that runs after this one, or on the other side of a branch. ` +
            'It can only ever resolve to nothing here.',
        });
      }
      continue;
    }

    if (namespace === 'vars') {
      if (name && !variables.has(name)) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: `Nothing sets “${name}”`,
          detail: `{{ ${token} }} reads a variable that no Set variable step — and no “save the result as” — ever writes. It will be empty.`,
        });
      }
      continue;
    }

    if (
      ![
        'contact',
        'message',
        'trigger',
        'conversation',
        'form',
        'now',
      ].includes(namespace)
    ) {
      out.push({
        level: 'warning',
        stepKey: step.key,
        title: `“${namespace}” is not a known kind of data`,
        detail: `{{ ${token} }} resolves to nothing. Use the insert-data button to pick a real one.`,
      });
      continue;
    }

    // Trigger-specific tokens that this trigger cannot supply.
    if (namespace === 'message' && input.triggerType === 'time_based') {
      out.push({
        level: 'warning',
        stepKey: step.key,
        title: 'No message to quote',
        detail:
          'A scheduled automation is not started by a message, so {{ message.text }} is always empty.',
      });
    }
    if (namespace === 'form' && input.triggerType !== 'form_submitted') {
      out.push({
        level: 'warning',
        stepKey: step.key,
        title: 'No form answers available',
        detail:
          'Form answers only exist when the automation is started by a form submission.',
      });
    }
  }
}

/** An unclosed `{{` is sent to the customer verbatim. */
function checkMalformedTokens(step: BuilderStep, out: Diagnostic[]): void {
  for (const value of collectStrings(step.step_config)) {
    const opens = (value.match(/\{\{/g) ?? []).length;
    const closes = (value.match(/\}\}/g) ?? []).length;
    if (opens !== closes) {
      out.push({
        level: 'error',
        stepKey: step.key,
        title: 'Unfinished token',
        detail:
          'A {{ is never closed. The braces are sent to the contact exactly as typed.',
      });
      return;
    }
  }
}

function checkStepSpecifics(
  step: BuilderStep,
  input: DiagnosticsInput,
  out: Diagnostic[]
): void {
  const cfg = step.step_config;

  switch (step.step_type) {
    case 'add_to_segment':
    case 'remove_from_segment': {
      const segment = input.segments?.find((s) => s.id === cfg.segment_id);
      if (segment && segment.kind === 'dynamic') {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `“${segment.name}” is a filter segment`,
          detail:
            'Its members are worked out from its rules, so nothing can be added to or removed from it. This step fails every time it runs.',
        });
      }
      break;
    }

    /**
     * A connected-app action.
     *
     * These checks MIRROR the server's, which is the rule for this whole
     * file: `validateAppConnections` in AutomationsService refuses to
     * activate for the same three reasons. The difference is timing —
     * here it is visible while editing, there it is the actual gate.
     *
     * They matter more than most because run-time failure is silent by
     * design: a revoked Google connection turns "email the customer"
     * into "quietly do nothing", and the first anybody hears is a
     * customer who never got a reply.
     */
    case 'app_action': {
      // Degrade silently when the catalogue has not loaded — a check
      // that fires because a fetch is in flight is noise.
      if (!input.apps?.length) break;

      const app = input.apps.find((a) => a.app === cfg.app);
      if (!app) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: 'This app is no longer available',
          detail: `The step is set to “${String(cfg.app ?? 'an unknown app')}”, which this workspace can no longer use. Pick another app or delete the step.`,
        });
        break;
      }

      const action = app.actions.find((a) => a.id === cfg.action);
      if (!action) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `${app.name} has no “${String(cfg.action ?? '')}” action`,
          detail:
            'It was probably renamed or withdrawn. Choose an action from the list.',
        });
        break;
      }

      const connection = input.connections?.find(
        (c) => c.id === cfg.connection_id
      );
      if (!cfg.connection_id || !connection) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `No ${app.name} account on this step`,
          detail: `Connect a ${app.name} account and choose it here, or this step fails every time it runs.`,
        });
        break;
      }

      if (connection.status !== 'active') {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `${connection.displayName ?? app.name} needs reconnecting`,
          detail:
            'Google has stopped accepting the stored credentials — usually because access was revoked, or a password changed. Reconnect it from Integrations.',
        });
        break;
      }

      if (action.scopes.some((scope) => !connection.scopes.includes(scope))) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `${connection.displayName ?? 'This account'} has not approved ${app.name}`,
          detail: `The account is connected but was never given ${app.name} access. Reconnect it and approve ${app.name}.`,
        });
        break;
      }

      for (const spec of action.inputs) {
        if (!spec.required) continue;
        const value = (cfg.input as Record<string, unknown> | undefined)?.[
          spec.key
        ];
        const empty =
          value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0) ||
          (spec.kind === 'key_values' &&
            typeof value === 'object' &&
            Object.keys(value as object).length === 0);
        if (empty) {
          out.push({
            level: 'error',
            stepKey: step.key,
            title: `“${spec.label}” is empty`,
            detail: `${app.name}: ${action.label} cannot run without it.`,
          });
        }
      }
      break;
    }

    case 'google_action': {
      // Degrade silently when the catalogue has not loaded.
      if (!input.googleActions?.length) break;

      const action = input.googleActions.find((a) => a.id === cfg.action);
      if (!action) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: cfg.action
            ? `Unknown action "${String(cfg.action)}"`
            : 'No action chosen',
          detail: 'Choose a Google action from the list.',
        });
        break;
      }

      const conn = input.googleConnection;
      if (
        !conn ||
        conn.status === 'not_configured' ||
        conn.status === 'provisioned'
      ) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: 'Google is not connected',
          detail:
            'Set up the Google Apps Script bridge in Integrations before this step can run.',
        });
        break;
      }

      if (conn.status === 'error') {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: 'Google connection has an error',
          detail: conn.lastError ?? 'Check the bridge setup in Integrations.',
        });
        break;
      }

      for (const spec of action.inputs) {
        if (!spec.required) continue;
        const value = (cfg.input as Record<string, unknown> | undefined)?.[
          spec.key
        ];
        const empty =
          value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0) ||
          (spec.kind === 'key_values' &&
            typeof value === 'object' &&
            Object.keys(value as object).length === 0);
        if (empty) {
          out.push({
            level: 'error',
            stepKey: step.key,
            title: `"${spec.label}" is empty`,
            detail: `${action.label} cannot run without it.`,
          });
        }
      }
      break;
    }

    case 'start_flow': {
      const flow = input.flows?.find((f) => f.id === cfg.flow_id);
      if (flow && flow.status !== 'active') {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: `“${flow.name}” is not active`,
          detail:
            'Only an active flow can be started. A draft flow is skipped, so this step does nothing.',
        });
      }
      break;
    }

    case 'run_automation': {
      if (
        cfg.automation_id &&
        cfg.automation_id === input.currentAutomationId
      ) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: 'This automation runs itself',
          detail:
            'That is refused at run time. Point it at a different automation.',
        });
        break;
      }
      const target = input.automations?.find((a) => a.id === cfg.automation_id);
      if (target && target.is_active === false) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: `“${target.name}” is inactive`,
          detail:
            'An inactive automation is not run, so this step does nothing until it is switched on.',
        });
      }
      break;
    }

    case 'http_request':
    case 'send_webhook': {
      const url = String(cfg.url ?? '');
      // The SSRF guard refuses anything that resolves to a private
      // address, so these fail at run time with a message the author
      // will not connect to what they typed.
      if (
        /localhost|127\.0\.0\.1|::1|\b10\.|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./.test(
          url
        )
      ) {
        out.push({
          level: 'error',
          stepKey: step.key,
          title: 'That address is not reachable from the server',
          detail:
            'Requests to private, loopback or internal addresses are refused for security. Use a publicly reachable URL.',
        });
      } else if (url.startsWith('http://')) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: 'Unencrypted request',
          detail:
            'This posts customer data over plain HTTP. Use https:// unless the endpoint genuinely cannot.',
        });
      }
      if (
        (cfg.auth as { type?: string } | undefined)?.type === 'bearer' ||
        (cfg.auth as { type?: string } | undefined)?.type === 'basic'
      ) {
        out.push({
          level: 'info',
          stepKey: step.key,
          title: 'Credentials are stored in this automation',
          detail:
            'Anyone who can edit this automation can read them. Use a token scoped to just what this request needs.',
        });
      }
      break;
    }

    case 'wait': {
      const amount = Number(cfg.amount ?? 0);
      const unit = String(cfg.unit ?? 'hours');
      const minutes = amount * (WAIT_UNIT_MINUTES[unit] ?? 60);
      if (minutes > 30 * 1440) {
        out.push({
          level: 'warning',
          stepKey: step.key,
          title: 'Very long wait',
          detail: `This pauses for ${formatMinutes(minutes)}. The run is held on the queue that whole time and resumes even if the contact has since replied or unsubscribed.`,
        });
      }
      break;
    }

    case 'send_webhook':
      break;

    default:
      break;
  }

  // A superseded step still works; saying so once is a kindness, twice
  // is nagging — hence info, not warning.
  if (STEP_META[step.step_type]?.deprecated) {
    out.push({
      level: 'info',
      stepKey: step.key,
      title: `${STEP_META[step.step_type].label} has a better replacement`,
      detail:
        step.step_type === 'send_webhook'
          ? 'HTTP request does everything this does and lets later steps read the response.'
          : 'Set status does this and can also reopen a conversation.',
    });
  }
}

/** A branch with nothing in it silently does nothing. */
function checkBranches(step: BuilderStep, out: Diagnostic[]): void {
  if (!step.branches) return;
  const empty: string[] = [];
  if (step.branches.yes.length === 0) empty.push('Yes');
  if (step.branches.no.length === 0) empty.push('No');
  if (empty.length === 2) {
    out.push({
      level: 'warning',
      stepKey: step.key,
      title: 'Both branches are empty',
      detail:
        'Whichever way this goes, nothing happens. Add steps to a branch or remove the split.',
    });
  } else if (empty.length === 1) {
    out.push({
      level: 'info',
      stepKey: step.key,
      title: `Nothing happens on “${empty[0]}”`,
      detail:
        'That is fine if it is deliberate — the automation carries on with whatever follows this split.',
    });
  }
}

// ============================================================
// Helpers
// ============================================================

/** Every `{{ path }}` in a config blob, without its filters. */
function collectTokens(config: unknown): string[] {
  const found: string[] = [];
  for (const value of collectStrings(config)) {
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value))) {
      // Filters (`| default: "x"`) are not part of the path.
      found.push(match[1].split('|')[0].trim());
    }
  }
  return found;
}

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, acc);
  }
  return acc;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

/** Worst level present, for a card badge or a header chip. */
export function worstLevel(diagnostics: Diagnostic[]): DiagnosticLevel | null {
  if (diagnostics.some((d) => d.level === 'error')) return 'error';
  if (diagnostics.some((d) => d.level === 'warning')) return 'warning';
  if (diagnostics.some((d) => d.level === 'info')) return 'info';
  return null;
}

export function groupByStep(
  diagnostics: Diagnostic[]
): Map<string | null, Diagnostic[]> {
  const map = new Map<string | null, Diagnostic[]>();
  for (const d of diagnostics) {
    const list = map.get(d.stepKey) ?? [];
    list.push(d);
    map.set(d.stepKey, list);
  }
  return map;
}
