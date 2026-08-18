// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in the step executor
// service; they're the same invariants, enforced one step earlier so
// failures surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string;
  message: string;
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

export function validateStepsForActivation(
  steps: StepLike[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    });
    return issues;
  }
  walk(steps, '', issues);
  return issues;
}

function walk(
  steps: StepLike[],
  prefix: string,
  issues: ValidationIssue[],
): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`;
    validateOne(s, path, issues);
    if (
      (s.step_type === 'condition' || s.step_type === 'random_split') &&
      s.branches
    ) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues);
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues);
    }
  });
}

function validateOne(
  step: StepLike,
  path: string,
  issues: ValidationIssue[],
): void {
  const c = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: 'message text is required',
        });
      }
      break;
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({
          path: `${path}.template_name`,
          message: 'template name is required',
        });
      }
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' });
      }
      break;
    case 'add_to_segment':
    case 'remove_from_segment':
      // Only presence is checked here, as everywhere else in this file.
      // Whether the segment still exists, still belongs to this account
      // and is still static is a run-time question — the answer can
      // change after activation, so the executor is the only place it
      // can honestly be asked.
      if (!nonEmpty(c.segment_id)) {
        issues.push({
          path: `${path}.segment_id`,
          message: 'segment is required',
        });
      }
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        });
      }
      break;
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({
          path: `${path}.field`,
          message: 'field name is required',
        });
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: 'field value is required',
        });
      }
      break;
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' });
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' });
      }
      break;
    case 'wait':
      if (
        typeof c.amount !== 'number' ||
        !Number.isFinite(c.amount) ||
        c.amount <= 0
      ) {
        issues.push({
          path: `${path}.amount`,
          message: 'wait amount must be greater than 0',
        });
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        });
      }
      break;
    case 'wait_until': {
      // Two modes. `instant` wins when present, so `time` is only
      // required when there is no instant to wait for.
      // Narrowed rather than String()-coerced: `c` is untrusted JSON, and
      // an object would stringify to "[object Object]" and then look like
      // a perfectly valid non-empty instant.
      const instant = typeof c.instant === 'string' ? c.instant.trim() : '';
      if (instant) {
        if (!instant.includes('{{')) {
          // A literal date would make every run of this automation wait
          // for the same fixed moment, which is never what "wait until
          // the appointment" means and silently stops working the day
          // after it passes.
          issues.push({
            path: `${path}.instant`,
            message:
              'must be a token such as {{ vars.booking.starts_at }} — a fixed date would be the same moment for every run',
          });
        }
        if (
          c.offset_minutes !== undefined &&
          !Number.isFinite(Number(c.offset_minutes))
        ) {
          issues.push({
            path: `${path}.offset_minutes`,
            message: 'offset must be a number of minutes',
          });
        }
      } else if (!/^\d{1,2}:\d{2}$/.test(String(c.time ?? ''))) {
        issues.push({
          path: `${path}.time`,
          message: 'time must look like HH:mm (24-hour)',
        });
      }
      break;
    }
    case 'condition': {
      // Two shapes are legal: the legacy single triple, and `rules[]`.
      // Requiring `subject` unconditionally would reject every condition
      // written in the new editor; requiring `rules` would reject every
      // one already live.
      const rules = Array.isArray(c.rules)
        ? (c.rules as Record<string, unknown>[])
        : null;
      if (rules && rules.length > 0) {
        rules.forEach((r, i) => {
          if (!nonEmpty(r?.subject)) {
            issues.push({
              path: `${path}.rules[${i}].subject`,
              message: 'each rule needs a subject',
            });
          }
          // `channel` reads its comparison from `value`; every other
          // subject names what it is looking at in `operand`.
          if (r?.subject !== 'channel' && !nonEmpty(r?.operand)) {
            issues.push({
              path: `${path}.rules[${i}].operand`,
              message: 'each rule needs something to look at',
            });
          }
        });
      } else if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: 'add at least one rule to this condition',
        });
      } else if (!nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: 'condition operand is required',
        });
      }
      break;
    }
    case 'random_split': {
      const percent = Number(c.percent ?? 50);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        issues.push({
          path: `${path}.percent`,
          message: 'split percentage must be between 0 and 100',
        });
      }
      break;
    }
    case 'send_webhook':
    case 'http_request': {
      if (!nonEmpty(c.url)) {
        issues.push({
          path: `${path}.url`,
          message: 'a URL is required',
        });
        break;
      }
      // A URL built from tokens (`{{ vars.endpoint }}/orders`) cannot be
      // parsed until run time. Skip the shape check rather than reject
      // it — the SSRF guard still runs on the resolved value, which is
      // the check that actually matters.
      if (!String(c.url).includes('{{')) {
        try {
          const u = new URL(String(c.url));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            issues.push({
              path: `${path}.url`,
              message: 'the URL must use http or https',
            });
          }
        } catch {
          issues.push({
            path: `${path}.url`,
            message: 'that is not a valid URL',
          });
        }
      }
      if (
        c.body_mode === 'raw' &&
        nonEmpty(c.body_template) &&
        !String(c.body_template).includes('{{')
      ) {
        // Only checkable when there are no tokens: a template full of
        // them is not JSON yet. Catching a stray trailing comma here
        // beats a 400 from the recipient at 3am.
        try {
          JSON.parse(String(c.body_template));
        } catch {
          issues.push({
            path: `${path}.body_template`,
            message: 'the raw body is not valid JSON',
          });
        }
      }
      break;
    }
    /**
     * Google action, run by the workspace's Apps Script bridge.
     *
     * Only the SHAPE is checked here. This function is pure and
     * synchronous by design — it is called from the activation path and
     * from tests — while "is Google set up for this workspace" is a
     * database read. That lives in AutomationsService.setActive, which can
     * await, and is the check that actually blocks activation.
     *
     * Validating the input fields against the action's FieldSpec is also
     * deliberately not here: the served catalogue is the authority, and
     * duplicating its rules in a second place is precisely the drift this
     * design exists to avoid.
     */
    case 'google_action':
      if (!nonEmpty(c.action)) {
        issues.push({ path: `${path}.action`, message: 'pick an action' });
      }
      // Deliberately NOT checked here: whether Google is connected at all.
      // That is one database read, it belongs with the other await-able
      // activation checks in AutomationsService.setActive, and a workspace
      // mid-setup should be able to save a draft that names an action.
      break;
    case 'set_variable':
      if (!nonEmpty(c.name)) {
        issues.push({
          path: `${path}.name`,
          message: 'variable name is required',
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(c.name))) {
        // It is addressed as `{{ vars.<name> }}`; a dot or a space there
        // splits the path and the token silently resolves to nothing.
        issues.push({
          path: `${path}.name`,
          message:
            'variable names can use letters, numbers and underscores only',
        });
      }
      break;
    case 'send_media':
      if (!nonEmpty(c.link)) {
        issues.push({
          path: `${path}.link`,
          message: 'a media URL is required',
        });
      }
      if (!['image', 'video', 'document', 'audio'].includes(String(c.kind))) {
        issues.push({
          path: `${path}.kind`,
          message: 'media kind must be image, video, document or audio',
        });
      }
      break;
    case 'send_buttons': {
      if (!nonEmpty(c.body_text)) {
        issues.push({
          path: `${path}.body_text`,
          message: 'message text is required',
        });
      }
      const buttons = Array.isArray(c.buttons) ? c.buttons : [];
      if (buttons.length === 0) {
        issues.push({
          path: `${path}.buttons`,
          message: 'add at least one button',
        });
      }
      // Meta's hard limit. Sending 4 fails the whole message at the API,
      // so catching it at save time is the difference between a fixable
      // form error and a silent dead automation.
      if (buttons.length > 3) {
        issues.push({
          path: `${path}.buttons`,
          message: 'WhatsApp allows at most 3 buttons',
        });
      }
      break;
    }
    case 'send_list': {
      if (!nonEmpty(c.body_text)) {
        issues.push({
          path: `${path}.body_text`,
          message: 'message text is required',
        });
      }
      const sections = Array.isArray(c.sections)
        ? (c.sections as { rows?: unknown[] }[])
        : [];
      const rowCount = sections.reduce(
        (n, s) => n + (Array.isArray(s?.rows) ? s.rows.length : 0),
        0,
      );
      if (rowCount === 0) {
        issues.push({
          path: `${path}.sections`,
          message: 'add at least one row to the list',
        });
      }
      if (rowCount > 10) {
        issues.push({
          path: `${path}.sections`,
          message: 'WhatsApp allows at most 10 rows across all sections',
        });
      }
      break;
    }
    case 'add_note':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'note text is required' });
      }
      break;
    case 'notify_team':
      if (!nonEmpty(c.title)) {
        issues.push({
          path: `${path}.title`,
          message: 'notification title is required',
        });
      }
      if (c.recipient === 'specific' && !nonEmpty(c.user_id)) {
        issues.push({
          path: `${path}.user_id`,
          message: 'pick who to notify',
        });
      }
      break;
    case 'update_deal':
      if (c.target === 'by_id' && !nonEmpty(c.deal_id)) {
        issues.push({
          path: `${path}.deal_id`,
          message: 'a deal id is required when targeting by id',
        });
      }
      if (
        !nonEmpty(c.stage_id) &&
        !nonEmpty(c.status) &&
        !nonEmpty(c.value) &&
        !nonEmpty(c.title)
      ) {
        issues.push({
          path: `${path}.stage_id`,
          message: 'choose at least one thing to change on the deal',
        });
      }
      break;
    case 'set_conversation_status':
      if (!['open', 'pending', 'closed'].includes(String(c.status))) {
        issues.push({
          path: `${path}.status`,
          message: 'status must be open, pending or closed',
        });
      }
      break;
    case 'start_flow':
      if (!nonEmpty(c.flow_id)) {
        issues.push({
          path: `${path}.flow_id`,
          message: 'pick a flow to start',
        });
      }
      break;
    case 'run_automation':
      if (!nonEmpty(c.automation_id)) {
        issues.push({
          path: `${path}.automation_id`,
          message: 'pick an automation to run',
        });
      }
      break;
    case 'close_conversation':
      // No config required.
      break;
    case 'send_form':
      if (!nonEmpty(c.form_id)) {
        issues.push({
          path: `${path}.form_id`,
          message: 'form is required',
        });
      }
      break;
    case 'send_booking_link':
      if (!nonEmpty(c.appointment_type_id)) {
        issues.push({
          path: `${path}.appointment_type_id`,
          message: 'appointment type is required',
        });
      }
      break;
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` });
  }
}

export function validateTriggerForActivation(
  triggerType: string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>;

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords;
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'at least one keyword is required',
      });
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.keywords',
        message: 'keywords cannot be empty strings',
      });
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automation-dispatch.service.ts, which reads `match_type ?? "contains"`),
    // so only an explicit, unrecognised value is invalid here. This keeps
    // activation validation in step with the engine and with the builder's
    // "Contains" default — an automation that shows the default in the UI
    // must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      });
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message: 'schedule is required',
      });
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' });
    }
  }
  // form_submitted, appointment_booked/cancelled/rescheduled, web_chat_started:
  // no required config — all filters (form_id, appointment_type_id) are optional
  // (omit = any). No validation needed.

  return issues;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
