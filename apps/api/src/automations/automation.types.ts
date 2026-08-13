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
  /**
   * Media / interactive sends. Thin wrappers over ChannelSenderService,
   * which already routes all three per `conversations.channel` — so they
   * work on WhatsApp, Instagram and web with no branch here. Lists are
   * WhatsApp+web only and raise UnsupportedOnChannelError on Instagram,
   * which the executor treats as "skip", not "fail".
   */
  | 'send_media'
  | 'send_buttons'
  | 'send_list'
  | 'add_tag'
  | 'remove_tag'
  /**
   * File the contact into a named audience (migration 076).
   *
   * Distinct from `add_tag` on purpose. A tag is a fact about one person
   * ("vip", "refunded"); a segment is a set with a purpose ("March
   * webinar attendees") that a broadcast can be pointed at directly.
   * Both exist because collapsing them is how a tag list becomes sixty
   * entries nobody dares delete.
   *
   * Only a STATIC segment can be added to — a dynamic one computes its
   * own membership from a filter, and the step fails loudly rather than
   * appearing to work.
   */
  | 'add_to_segment'
  | 'remove_from_segment'
  | 'assign_conversation'
  | 'update_contact_field'
  /** Write a value into `vars` for later steps to read. The glue between
   *  a step that produces data and a step that needs it shaped. */
  | 'set_variable'
  | 'create_deal'
  /** Move an existing deal's stage / value / status. */
  | 'update_deal'
  /** Internal note on the contact's timeline — visible to the team only. */
  | 'add_note'
  /** In-app notification for one member or everyone in the workspace. */
  | 'notify_team'
  | 'wait'
  /**
   * Hold until a wall-clock moment (a time of day, optionally restricted
   * to weekdays) rather than for a duration. "Reply at 9am" is a
   * different rule from "reply in 12 hours" and cannot be expressed as
   * one: 12 hours from 10pm is not business hours.
   */
  | 'wait_until'
  | 'condition'
  /**
   * Split traffic by percentage down the yes/no branches. Reuses the
   * existing two-branch machinery precisely so it needs no new
   * persistence — the DB `branch` column is still just yes/no.
   */
  | 'random_split'
  /**
   * HTTP request with a response you can read in later steps. Same
   * executor as `send_webhook`, which remains its fire-and-forget
   * ancestor so every automation written before this keeps working.
   */
  | 'http_request'
  | 'send_webhook'
  | 'close_conversation'
  /** Set the conversation to open / pending / closed. */
  | 'set_conversation_status'
  /** Hand the contact over to a Flow (the conversational builder). */
  | 'start_flow'
  /** Run another automation as a sub-routine, depth-guarded. */
  | 'run_automation'
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

/**
 * Options every step understands, whatever its type.
 *
 * They live in `step_config` alongside the type's own fields rather than
 * in columns of their own: they are read only by the executor, never
 * queried, and a column per option would be a migration per option.
 *
 * WHY `on_error` EXISTS
 *   Before it, one failing step aborted the rest of the run. That is the
 *   right default — a send that depends on a lookup should not fire with
 *   half the data — but it is wrong for the "also ping our CRM" step at
 *   the end, where a third party being down should not cancel the tag and
 *   the deal that already succeeded.
 */
export interface CommonStepOptions {
  /**
   * Skip this step entirely, without deleting it. The canvas greys the
   * node out. Keeping a half-built step around beats retyping it.
   */
  disabled?: boolean;
  /** `fail` (default) stops the run; `continue` logs and carries on. */
  on_error?: 'fail' | 'continue';
  /**
   * Copy this step's output into `vars.<name>` as well as
   * `steps.<key>`. Purely ergonomic — `{{ vars.order }}` reads better
   * than `{{ steps.http_request_2.body.order }}` when it is used ten times.
   */
  save_as?: string;
  /** Author's note. Never sent anywhere; shown in the editor. */
  note?: string;
}

export interface SendMessageStepConfig {
  text: string;
}

export type MediaKindConfig = 'image' | 'video' | 'document' | 'audio';

export interface SendMediaStepConfig {
  kind: MediaKindConfig;
  /** Public URL. Interpolated, so it can come from an earlier step. */
  link: string;
  caption?: string;
  /** Documents only — what the recipient sees as the file name. */
  filename?: string;
}

export interface SendButtonsStepConfig {
  body_text: string;
  header_text?: string;
  footer_text?: string;
  /**
   * Up to 3 (Meta's limit, enforced by INTERACTIVE_LIMITS at send time).
   * `id` is what comes back on the webhook when the recipient taps, so a
   * keyword automation or flow can pick the reply up.
   */
  buttons: { id: string; title: string }[];
}

export interface SendListStepConfig {
  body_text: string;
  button_label: string;
  header_text?: string;
  footer_text?: string;
  sections: {
    title: string;
    rows: { id: string; title: string; description?: string }[];
  }[];
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

export interface SegmentStepConfig {
  segment_id: string;
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
  | 'channel'
  /**
   * Branch on anything the run has produced — a variable, an earlier
   * step's output, a webhook's status code. `operand` is the token path
   * (`steps.lookup.status`), which is what makes a condition able to read
   * a previous node at all.
   */
  | 'expression'
  /** Is the contact in this segment? (Resolved through the segment RPC.) */
  | 'segment_membership'
  /** Is there a day-of-week match? `operand` is a comma list: "mon,tue". */
  | 'day_of_week';

/**
 * Comparison operators, shared by every rule subject.
 *
 * Numeric ones coerce both sides with Number() and are false when either
 * side is not a number — "greater than" against a non-number is not true,
 * and it is not an error either.
 */
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than'
  | 'matches_regex';

export interface ConditionRule {
  subject: ConditionSubject;
  /** Field name, tag id, token path, or "HH:mm-HH:mm" — per subject. */
  operand?: string;
  operator?: ConditionOperator;
  value?: string;
}

/**
 * A condition is a list of rules combined with all/any.
 *
 * BACK COMPATIBILITY IS NOT OPTIONAL HERE
 *   Every automation written before this has a bare
 *   `{subject, operand, value}` at the top level and no `rules`. The
 *   evaluator reads `rules` when present and falls back to lifting the
 *   legacy triple into a single rule otherwise, so nothing needs
 *   migrating and an untouched automation branches exactly as it did.
 */
export interface ConditionStepConfig {
  /** Legacy single-rule form. Still written by nothing, still read. */
  subject?: ConditionSubject;
  operand?: string;
  value?: string;
  /** Preferred form. */
  rules?: ConditionRule[];
  match?: 'all' | 'any';
}

export interface RandomSplitStepConfig {
  /** Percentage sent down the `yes` branch. 0–100, default 50. */
  percent?: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * HTTP request configuration, shared by `send_webhook` (the original,
 * fire-and-forget) and `http_request` (which keeps the response).
 *
 * Every string field is interpolated, so a request can be assembled
 * entirely from earlier steps: URL, query, headers, and body alike.
 *
 * SECURITY NOTES THAT ARE NOT NEGOTIABLE
 *   - The destination is checked with `isDeliverableUrl` (SSRF guard)
 *     before the request and redirects are NOT followed: a public URL
 *     that 3xx-bounces to 169.254.169.254 would otherwise walk straight
 *     past the guard.
 *   - `auth` values are ordinary config, so they are visible to anyone
 *     who can edit the automation. That is the same trust boundary as
 *     the URL itself; it is NOT a place to put a platform secret.
 */
export interface SendWebhookStepConfig extends CommonStepOptions {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Appended to the URL. Kept separate so values can be interpolated. */
  query?: Record<string, string>;
  /**
   * How the body is built:
   *   `json`  — `body_fields`, a key/value map, rendered to a JSON object.
   *             The default for new steps: it is impossible to produce
   *             malformed JSON this way, which a raw textarea makes easy.
   *   `raw`   — `body_template`, sent verbatim after interpolation. What
   *             every pre-existing send_webhook step uses.
   *   `form`  — `body_fields` as application/x-www-form-urlencoded.
   *   `none`  — no body (the default for GET).
   */
  body_mode?: 'json' | 'raw' | 'form' | 'none';
  body_fields?: Record<string, unknown>;
  body_template?: string;
  auth?:
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | { type: 'basic'; username: string; password: string }
    | { type: 'header'; name: string; value: string };
  /** Seconds. Clamped server-side — see HTTP_TIMEOUT_BOUNDS. */
  timeout_seconds?: number;
  /**
   * Treat a non-2xx response as success (`http_request` only).
   *
   * A 404 from "does this customer exist?" is an ANSWER, not a failure,
   * and the branch that follows wants to read `steps.<key>.status`
   * rather than have the run stop.
   */
  ignore_http_errors?: boolean;
}

export interface SetVariableStepConfig extends CommonStepOptions {
  /** Variable name, addressed later as `{{ vars.<name> }}`. */
  name: string;
  /** Interpolated. A sole token keeps its type (object stays object). */
  value: string;
}

export interface UpdateDealStepConfig extends CommonStepOptions {
  /**
   * Which deal to act on. `latest_for_contact` is what an automation
   * fired by a message means: the person just wrote in, move THEIR deal.
   * `by_id` takes an interpolated id from an earlier step.
   */
  target?: 'latest_for_contact' | 'by_id';
  deal_id?: string;
  stage_id?: string;
  status?: 'open' | 'won' | 'lost';
  value?: string;
  title?: string;
}

export interface AddNoteStepConfig extends CommonStepOptions {
  text: string;
}

export interface NotifyTeamStepConfig extends CommonStepOptions {
  /** `all` notifies every member of the workspace. */
  recipient?: 'all' | 'assigned_agent' | 'specific';
  user_id?: string;
  title: string;
  body?: string;
}

export interface WaitUntilStepConfig extends CommonStepOptions {
  /** "HH:mm", 24h. Interpreted in `timezone`. */
  time: string;
  /**
   * IANA zone. Defaults to UTC — an omitted zone must not silently mean
   * "the server's", which is a different answer on every deploy.
   */
  timezone?: string;
  /** Restrict to these weekdays (0=Sun). Empty/absent = any day. */
  days?: number[];
}

export interface SetConversationStatusStepConfig extends CommonStepOptions {
  status: 'open' | 'pending' | 'closed';
}

export interface StartFlowStepConfig extends CommonStepOptions {
  flow_id: string;
}

export interface RunAutomationStepConfig extends CommonStepOptions {
  automation_id: string;
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
  | SendMediaStepConfig
  | SendButtonsStepConfig
  | SendListStepConfig
  | SetVariableStepConfig
  | UpdateDealStepConfig
  | AddNoteStepConfig
  | NotifyTeamStepConfig
  | WaitUntilStepConfig
  | RandomSplitStepConfig
  | SetConversationStatusStepConfig
  | StartFlowStepConfig
  | RunAutomationStepConfig
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
  /** Stable reference used by tokens and by the canvas (migration 080). */
  key?: string | null;
  /** NULL = never laid out; the editor auto-lays-out rather than piling at 0,0. */
  position_x?: number | null;
  position_y?: number | null;
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
   * What each step produced, keyed by the step's author-chosen `key`
   * (migration 080) — the namespace behind `{{ steps.lookup.body.id }}`.
   *
   * Persisted with the rest of the context on a wait, so a step after a
   * three-day wait can still read what a step before it fetched.
   *
   * KEYED BY `key`, NEVER BY ROW ID: saving an automation is
   * delete-then-reinsert, so ids change and every token would rot.
   */
  steps?: Record<string, unknown>;
  /**
   * How many `run_automation` hops deep this run is.
   *
   * The whole guard against A → B → A: two automations that call each
   * other are not obviously wrong when you write them, and without a
   * counter they fill the queue until Redis dies.
   */
  depth?: number;
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
