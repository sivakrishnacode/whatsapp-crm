/**
 * Client-side step validation — what puts the "Fix" badge on a card.
 *
 * DELIBERATELY A MIRROR, NOT THE AUTHORITY
 *   `apps/api/src/automations/services/automation-validate.ts` is what
 *   actually blocks activation, and it must stay that way: this runs in
 *   a browser the user controls. This copy exists so a missing field is
 *   visible ON THE CANVAS while building, rather than as a single toast
 *   after pressing Save — with 24 step types and a graph you can scroll,
 *   "something somewhere is wrong" is not a usable error message.
 *
 *   Keep the two in step. Where they disagree, the server wins and the
 *   badge is the bug.
 */

import { flattenSteps, type BuilderStep } from '@/lib/automations/graph';

export interface StepIssue {
  field: string;
  message: string;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null && v !== '';
}

export function validateStep(step: BuilderStep): StepIssue[] {
  const c = step.step_config ?? {};
  const issues: StepIssue[] = [];
  const need = (field: string, message: string) => {
    if (!nonEmpty(c[field])) issues.push({ field, message });
  };

  switch (step.step_type) {
    case 'send_message':
      need('text', 'Message text is required');
      break;
    case 'send_template':
      need('template_name', 'Pick a template');
      break;
    case 'send_media':
      need('link', 'A media URL is required');
      break;
    case 'send_buttons': {
      need('body_text', 'Message text is required');
      const buttons = Array.isArray(c.buttons)
        ? (c.buttons as { title?: string }[])
        : [];
      if (buttons.filter((b) => nonEmpty(b?.title)).length === 0) {
        issues.push({ field: 'buttons', message: 'Add at least one button' });
      }
      // Meta's hard limit — a 4th button fails the whole send.
      if (buttons.length > 3) {
        issues.push({ field: 'buttons', message: 'WhatsApp allows at most 3 buttons' });
      }
      break;
    }
    case 'send_list': {
      need('body_text', 'Message text is required');
      const sections = Array.isArray(c.sections)
        ? (c.sections as { rows?: { title?: string }[] }[])
        : [];
      const rows = sections.flatMap((s) => s.rows ?? []);
      if (rows.filter((r) => nonEmpty(r?.title)).length === 0) {
        issues.push({ field: 'sections', message: 'Add at least one option' });
      }
      if (rows.length > 10) {
        issues.push({ field: 'sections', message: 'WhatsApp allows at most 10 rows' });
      }
      break;
    }
    case 'send_form':
      need('form_id', 'Pick a form');
      break;
    case 'send_booking_link':
      need('appointment_type_id', 'Pick an appointment type');
      break;
    case 'add_tag':
    case 'remove_tag':
      need('tag_id', 'Pick a tag');
      break;
    case 'add_to_segment':
    case 'remove_from_segment':
      need('segment_id', 'Pick a segment');
      break;
    case 'update_contact_field':
      need('field', 'Pick a field');
      need('value', 'A value is required');
      break;
    case 'add_note':
      need('text', 'Note text is required');
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({ field: 'agent_id', message: 'Pick an agent' });
      }
      break;
    case 'set_conversation_status':
      if (!['open', 'pending', 'closed'].includes(String(c.status))) {
        issues.push({ field: 'status', message: 'Pick a status' });
      }
      break;
    case 'create_deal':
      need('pipeline_id', 'Pick a pipeline');
      need('stage_id', 'Pick a stage');
      need('title', 'A deal title is required');
      break;
    case 'update_deal':
      if (c.target === 'by_id' && !nonEmpty(c.deal_id)) {
        issues.push({ field: 'deal_id', message: 'A deal id is required' });
      }
      if (
        !nonEmpty(c.stage_id) &&
        !nonEmpty(c.status) &&
        !nonEmpty(c.value) &&
        !nonEmpty(c.title)
      ) {
        issues.push({
          field: 'stage_id',
          message: 'Choose at least one thing to change',
        });
      }
      break;
    case 'notify_team':
      need('title', 'A title is required');
      if (c.recipient === 'specific' && !nonEmpty(c.user_id)) {
        issues.push({ field: 'user_id', message: 'Pick who to notify' });
      }
      break;
    case 'wait': {
      const amount = Number(c.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        issues.push({ field: 'amount', message: 'Wait for more than zero' });
      }
      break;
    }
    case 'wait_until':
      if (!/^\d{1,2}:\d{2}$/.test(String(c.time ?? ''))) {
        issues.push({ field: 'time', message: 'Set a time as HH:mm' });
      }
      break;
    case 'condition': {
      const rules = Array.isArray(c.rules)
        ? (c.rules as { subject?: string; operand?: string }[])
        : null;
      if (rules && rules.length > 0) {
        rules.forEach((r, i) => {
          if (!nonEmpty(r?.subject)) {
            issues.push({ field: `rules.${i}`, message: 'Each rule needs a subject' });
            return;
          }
          // `channel` compares against `value`; everything else names
          // what it is looking at in `operand`.
          if (r.subject !== 'channel' && !nonEmpty(r?.operand)) {
            issues.push({
              field: `rules.${i}`,
              message: 'Each rule needs something to look at',
            });
          }
        });
      } else if (!nonEmpty(c.subject)) {
        // Legacy single-rule shape is still valid; only a condition with
        // neither shape is broken.
        issues.push({ field: 'rules', message: 'Add at least one rule' });
      }
      break;
    }
    case 'random_split': {
      const percent = Number(c.percent ?? 50);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        issues.push({ field: 'percent', message: 'Use a percentage from 0 to 100' });
      }
      break;
    }
    case 'http_request':
    case 'send_webhook': {
      if (!nonEmpty(c.url)) {
        issues.push({ field: 'url', message: 'A URL is required' });
        break;
      }
      // A URL assembled from tokens cannot be parsed until run time.
      if (!String(c.url).includes('{{')) {
        try {
          const u = new URL(String(c.url));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            issues.push({ field: 'url', message: 'Use http or https' });
          }
        } catch {
          issues.push({ field: 'url', message: 'That is not a valid URL' });
        }
      }
      if (
        c.body_mode === 'raw' &&
        nonEmpty(c.body_template) &&
        !String(c.body_template).includes('{{')
      ) {
        try {
          JSON.parse(String(c.body_template));
        } catch {
          issues.push({ field: 'body_template', message: 'The body is not valid JSON' });
        }
      }
      break;
    }
    case 'set_variable':
      if (!nonEmpty(c.name)) {
        issues.push({ field: 'name', message: 'Name this variable' });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(c.name))) {
        issues.push({
          field: 'name',
          message: 'Letters, numbers and underscores only',
        });
      }
      break;
    case 'start_flow':
      need('flow_id', 'Pick a flow');
      break;
    case 'run_automation':
      need('automation_id', 'Pick an automation');
      break;
    default:
      break;
  }

  return issues;
}

/** Every issue in the automation, keyed by step, for the save summary. */
export function validateAll(
  steps: BuilderStep[],
): { key: string; issues: StepIssue[] }[] {
  return flattenSteps(steps)
    .map((f) => ({ key: f.step.key, issues: validateStep(f.step) }))
    .filter((r) => r.issues.length > 0);
}
