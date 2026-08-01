// Duplicated from apps/web/src/types/index.ts (lines ~404-578). No shared
// types package exists yet between apps/web and apps/api — hoisting these
// into e.g. packages/shared-types is a follow-up opportunity, not done here.

import type { Channel } from '../common/messaging/channel';

export type AutomationTriggerType =
  | 'new_message_received'
  | 'first_inbound_message'
  | 'keyword_match'
  | 'new_contact_created'
  | 'conversation_assigned'
  | 'tag_added'
  | 'time_based'
  // Instagram-only events with no WhatsApp equivalent. They exist as
  // their own triggers rather than folding into `keyword_match`
  // because a public comment and a private DM are different things:
  // conflating them means a rule written to answer a DM also fires on
  // every matching comment, with no way to tell them apart.
  | 'instagram_comment'
  | 'instagram_story_reply'
  /**
   * Web-widget-only: a visitor opened a chat and sent their first message.
   *
   * Not a duplicate of `first_inbound_message`, which fires on all three
   * channels — a rule meant to greet website visitors would otherwise also
   * greet every new WhatsApp contact.
   */
  | 'web_chat_started'
  /**
   * A form was submitted. CHANNEL-AGNOSTIC on purpose: a hosted submission
   * has no channel at all, so channel-locking it would mean it never fires.
   * `trigger_config.form_id` narrows it to one form; omitted = any form.
   */
  | 'form_submitted'
  /**
   * Appointment lifecycle. Also channel-agnostic — a booking made on a
   * hosted page belongs to no channel.
   */
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'appointment_rescheduled';

/**
 * Triggers that accept a keyword filter in their `trigger_config`.
 *
 * `keyword_match` is the WhatsApp-and-Instagram DM one; the two
 * Instagram triggers reuse the same config shape so an author learns
 * one editor, not three.
 */
export const KEYWORD_FILTERED_TRIGGERS = [
  'keyword_match',
  'instagram_comment',
  'instagram_story_reply',
] as const;

/**
 * Triggers that only make sense on one channel. Used to keep the
 * builder's channel picker and trigger picker consistent — selecting
 * `instagram_comment` implies the automation is Instagram-scoped.
 */
export const TRIGGER_CHANNEL_LOCK: Partial<
  Record<AutomationTriggerType, Channel>
> = {
  instagram_comment: 'instagram',
  instagram_story_reply: 'instagram',
  web_chat_started: 'web',
  // form_submitted and the appointment_* triggers are DELIBERATELY absent.
  // They are not channel events: a hosted form submission or a booking made
  // on a public page has no channel, so locking them to one would mean they
  // never fire for the most common case.
};

export type AutomationStepType =
  | 'send_message'
  | 'send_template'
  | 'add_tag'
  | 'remove_tag'
  | 'assign_conversation'
  | 'update_contact_field'
  | 'create_deal'
  | 'wait'
  | 'condition'
  | 'send_webhook'
  | 'close_conversation'
  /**
   * Send someone a form. Works on every channel because it sends a link,
   * which every channel can carry — except on web, where it sends a card
   * the widget renders inline (making a visitor already in a browser open a
   * new tab to answer two questions is pointless drop-off).
   */
  | 'send_form'
  /** Same shape, for a booking page. */
  | 'send_booking_link';

export type AutomationLogStatus = 'success' | 'partial' | 'failed';

export interface KeywordMatchTriggerConfig {
  keywords: string[];
  match_type: 'exact' | 'contains';
  case_sensitive?: boolean;
}

export interface TagTriggerConfig {
  tag_id: string;
}

export interface TimeBasedTriggerConfig {
  /** Cron expression or simple HH:mm string; engine can accept either. */
  schedule: string;
  timezone?: string;
}

export type AutomationTriggerConfig =
  | Record<string, never>
  | KeywordMatchTriggerConfig
  | TagTriggerConfig
  | TimeBasedTriggerConfig
  | FormSubmittedTriggerConfig
  | AppointmentTriggerConfig
  | Record<string, unknown>;

export interface SendMessageStepConfig {
  text: string;
}

/**
 * A template send from an automation.
 *
 * Every value here is interpolated at run time, so `{{contact.name}}`
 * or `{{message.text}}` can be used anywhere a literal can — which is
 * most of the point of a template variable in an automation.
 *
 * The header/button fields exist because Meta rejects the whole send
 * when any required parameter is absent, and a template's requirements
 * are not limited to its body: a LOCATION header needs a pin per send,
 * a media header needs a URL when the template carries no default, and
 * URL/COPY_CODE buttons need their substitution. Collecting only body
 * variables made those templates unsendable from an automation with no
 * indication why.
 */
export interface SendTemplateStepConfig {
  template_name: string;
  language?: string;
  /** Body values keyed by placeholder token ("1", "2", or a name). */
  variables?: Record<string, string>;
  /** Value for a TEXT header's variable. */
  header_text?: string;
  /** Overrides the template's own media for IMAGE/VIDEO/DOCUMENT headers. */
  header_media_url?: string;
  /** Required for a LOCATION header — there is no template-level default. */
  header_location?: {
    latitude: string;
    longitude: string;
    name?: string;
    address?: string;
  };
  /** Per-button substitution, keyed by the button's index. */
  button_params?: Record<string, string>;
}

export interface TagStepConfig {
  tag_id: string;
}

export interface AssignConversationStepConfig {
  mode: 'specific' | 'round_robin';
  agent_id?: string;
}

export interface UpdateContactFieldStepConfig {
  /**
   * Either a built-in contact column (`name` | `email` | `company`) or a
   * custom field encoded as `custom:<custom_field_id>`. The `custom:` prefix
   * is how the engine distinguishes a `contact_custom_values` write from a
   * direct `contacts` column update. Older configs store the bare column name,
   * so this stays backward compatible.
   */
  field: string;
  /** Supports `{{ vars.* }}` / `{{ message.text }}` interpolation at runtime. */
  value: string;
}

export interface CreateDealStepConfig {
  pipeline_id: string;
  stage_id: string;
  title: string;
  value?: number;
}

export interface WaitStepConfig {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
}

export type ConditionSubject =
  | 'contact_field'
  | 'tag_presence'
  | 'message_content'
  | 'time_of_day'
  /**
   * Branch on the triggering conversation's channel. Lets one
   * automation send a template on WhatsApp and plain text on
   * Instagram, instead of maintaining two near-identical rules.
   */
  | 'channel';

export interface ConditionStepConfig {
  subject: ConditionSubject;
  /** e.g. field name, tag id, substring, or "HH:mm-HH:mm" depending on subject */
  operand?: string;
  /** For contact_field equals / message_content contains — comparison value */
  value?: string;
}

export interface SendWebhookStepConfig {
  url: string;
  headers?: Record<string, string>;
  body_template?: string;
}

export interface SendFormStepConfig {
  form_id: string;
  /**
   * Message sent alongside the link. Supports `{{ vars.* }}` interpolation
   * like every other message config.
   */
  message_text?: string;
}

export interface SendBookingLinkStepConfig {
  appointment_type_id: string;
  message_text?: string;
}

/** Config shape for the form_submitted trigger. */
export interface FormSubmittedTriggerConfig {
  /** Omitted or empty = any form in the account. */
  form_id?: string;
}

/** Config shape for the appointment_* triggers. */
export interface AppointmentTriggerConfig {
  /** Omitted or empty = any appointment type. */
  appointment_type_id?: string;
}

export type AutomationStepConfig =
  | SendMessageStepConfig
  | SendTemplateStepConfig
  | TagStepConfig
  | AssignConversationStepConfig
  | UpdateContactFieldStepConfig
  | CreateDealStepConfig
  | WaitStepConfig
  | ConditionStepConfig
  | SendWebhookStepConfig
  | SendFormStepConfig
  | SendBookingLinkStepConfig
  | Record<string, never>
  | Record<string, unknown>;

/** snake_case wire shape — matches the frontend's existing Automation type exactly. */
export interface AutomationJson {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  description?: string | null;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  /**
   * Channels this automation runs on. EMPTY = all channels, which is
   * both the default and what every automation predating the column
   * does. Never null — see migration 052 for why one representation.
   */
  channels: Channel[];
  is_active: boolean;
  execution_count: number;
  last_executed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationStepJson {
  id: string;
  automation_id: string;
  parent_step_id?: string | null;
  branch?: 'yes' | 'no' | null;
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  position: number;
  created_at: string;
}

export interface AutomationLogStepResult {
  step_id: string;
  step_type: AutomationStepType;
  status: 'success' | 'skipped' | 'failed';
  detail?: string;
}

export interface AutomationLogJson {
  id: string;
  automation_id: string;
  user_id: string;
  contact_id: string | null;
  trigger_event: string;
  steps_executed: AutomationLogStepResult[];
  status: AutomationLogStatus;
  /**
   * Channel of the conversation that fired this run. NULL for runs
   * with no channel context (time-based, manual entrypoint) and for
   * rows predating the column — NULL means unknown, not WhatsApp.
   */
  channel: string | null;
  error_message?: string | null;
  created_at: string;
  contact?: {
    id: string;
    name: string;
    phone: string | null;
    /** Instagram contacts have no phone — the logs UI falls back to this. */
    ig_username?: string | null;
  } | null;
}

/** Mirrors apps/web/src/lib/automations/engine.ts's `AutomationContext`. */
export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string;
  /** Conversation the event belongs to, if any. */
  conversation_id?: string;
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>;
  /**
   * The triggering contact's own fields, exposed to interpolation as
   * `{{contact.name}}`, `{{contact.phone}}`, `{{contact.email}}`,
   * `{{contact.company}}`.
   *
   * Filled in on demand (see `withContactTokens`) rather than at
   * dispatch: most steps never reference it, and every automation run
   * paying for a contact lookup to serve the few that do is a cost with
   * no reader. Absent on a persisted pending-execution context written
   * before this existed, which resolves to "" — the same as any other
   * unknown token.
   */
  contact?: Record<string, string | null>;
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string;
  /** Which form was submitted, for the form_submitted trigger's filter. */
  form_id?: string;
  /** The submission row, so a follow-up can quote what the person answered. */
  submission_id?: string;
  /** Which appointment type, for the appointment_* triggers' filter. */
  appointment_type_id?: string;
  appointment_id?: string;
  /**
   * Answers keyed by field_key, exposed to interpolation as
   * `{{ vars.form.<field_key> }}`.
   */
  form?: Record<string, unknown>;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string;
  /**
   * Which platform the triggering event came from.
   *
   * Absent is treated as WhatsApp by `toChannel()` — the WhatsApp
   * webhook predates this field. Prefer setting it explicitly.
   *
   * Read by three things: dispatch (to skip automations scoped to
   * another channel), the `channel` condition subject, and
   * `resolveConversationId` (so a send lands on the thread the event
   * came from, not an arbitrary one the contact happens to own).
   *
   * Send steps do NOT branch on it to pick a transport —
   * ChannelSenderService routes by `conversations.channel`, so a send
   * step works on either platform untouched.
   */
  channel?: Channel;
  /** Instagram comment that triggered this, for the comment → DM funnel. */
  ig_comment_id?: string;
  ig_media_id?: string;
}

/** Dispatch input — mirrors runAutomationsForTrigger's original argument shape. */
export interface AutomationDispatchInput {
  accountId: string;
  /** Usually an AutomationTriggerType, but accepts any string since a
   *  trigger event like 'resumed_wait' isn't itself a trigger type. */
  triggerType: string;
  contactId?: string | null;
  context?: AutomationContext;
}

/**
 * Mirrors engine.ts's `ExecuteArgs` — threaded through executeStepsFrom/
 * runStep/evaluateCondition for one execution (fresh dispatch or a
 * resumed wait). `automation` carries the full Prisma row so step
 * handlers can read accountId/userId without a second query.
 */
export interface StepExecutionArgs {
  automation: {
    id: string;
    accountId: string;
    userId: string;
  };
  contactId: string | null;
  context: AutomationContext;
  parentStepId: string | null;
  branch: 'yes' | 'no' | null;
  startPosition: number;
  logId: string | null;
  triggerEvent: string;
}
