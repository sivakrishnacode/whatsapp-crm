/**
 * Type definitions for the Flows domain — ported from
 * apps/web/src/lib/flows/types.ts.
 *
 * Two families live here:
 *   1. JSONB content shapes (node configs, trigger configs, fallback
 *      policy, ParsedInbound) — snake_case keys, because they're stored
 *      verbatim in Postgres JSONB columns and exchanged with the
 *      builder UI. These are byte-identical to the web originals.
 *   2. Wire JSON shapes (FlowJson / FlowNodeJson / ...) — the exact
 *      snake_case response shapes the dashboard frontend already
 *      consumes; the CRUD service reshapes Prisma's camelCase models
 *      into these (same pattern as automations' AutomationJson).
 *
 * The web file's FlowRow/FlowNodeRow/FlowRunRow DB-row types are NOT
 * ported — Prisma's generated `Flow`/`FlowNode`/`FlowRun` models
 * replace them inside the engine.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
}

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 */
export interface SendMediaNodeConfig {
  media_type: 'image' | 'video' | 'document';
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * v1.5 ships without runtime validation (`validation` is accepted on
 * the config for forward compat but ignored by the runner).
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in `flow_runs.vars`.
   */
  var_key: string;
  /** Reserved for v2. Accepted on the config but ignored by the runner. */
  validation?: 'any' | 'email' | 'phone' | 'regex';
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

export type ConditionOperator = 'equals' | 'contains' | 'present' | 'absent';

export type ConditionSubject = 'var' | 'tag' | 'contact_field';

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: 'add' | 'remove';
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  next_node_key: string;
}

/**
 * Put the contact into (or take them out of) a named audience —
 * migration 076's `contact_segments`.
 *
 * Deliberately a separate node from `set_tag` rather than a mode on it:
 * a tag describes the person, a segment is a list a broadcast can be
 * aimed at, and a flow author picking between them is making a real
 * choice about what happens next.
 *
 * Only STATIC segments are addressable; a dynamic one computes its own
 * membership from a filter.
 */
export interface SetSegmentNodeConfig {
  mode: 'add' | 'remove';
  /** contact_segments UUID. The builder lists static segments only. */
  segment_id: string;
  next_node_key: string;
}

/**
 * Writes a value onto the CONTACT (a profile column or a custom field)
 * or into the run's own `vars`. This is how a captured answer becomes
 * CRM data rather than something that dies with the run.
 *
 * `target` decides where it lands; `value` is interpolated, so
 * "{{vars.answer}}" is the common case.
 */
export interface SetAttributeNodeConfig {
  target: 'contact_field' | 'custom_field' | 'var';
  /**
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   * For `custom_field`: the custom_fields row's key.
   * For `var`: the key under flow_runs.vars.
   */
  key: string;
  /** Interpolated before writing. */
  value: string;
  next_node_key: string;
}

/**
 * Sends an approved WhatsApp template — the ONLY message that can be
 * sent outside the 24-hour customer-service window, which is why a flow
 * resumed by a `wait` longer than a day needs one.
 *
 * ⚠️ `template_name` + `language` identify the template AT META, not a
 * row of ours. We do not copy the body text here: an admin can edit and
 * re-submit a template at any time, and a cached copy would render the
 * builder a liar about what the customer actually receives.
 */
export interface SendTemplateNodeConfig {
  template_name: string;
  /** BCP-47 code as Meta stores it, e.g. 'en_US'. */
  language: string;
  /** Positional {{1}}, {{2}}… body variables. Interpolated. */
  body_params?: string[];
  /** Positional header variable, when the template has one. */
  header_params?: string[];
  next_node_key: string;
}

/**
 * Sends catalogue products — one product, or a multi-product list.
 *
 * One node type with a `mode` discriminator rather than two, for the
 * same reason `send_media` covers image/video/document: Meta's payloads
 * differ only in shape around the same catalogue id, and two node types
 * would double the forms, the engine cases and the menu entries for no
 * behavioural difference the author cares about.
 */
export interface SendProductsNodeConfig {
  mode: 'single' | 'list';
  /** Meta catalogue id. Falls back to the account's configured one. */
  catalog_id?: string;
  /** `single`: exactly one retailer id. `list`: one per section row. */
  product_retailer_ids: string[];
  /** Required by Meta for the multi-product message. */
  header_text?: string;
  body_text?: string;
  footer_text?: string;
  next_node_key: string;
}

/**
 * Asks the customer to share their location and stores it in
 * `vars[var_key]` as `{ latitude, longitude, name, address }`.
 *
 * WhatsApp-only: it is an interactive `location_request_message`, and
 * there is no equivalent on any other channel we run.
 */
export interface AskLocationNodeConfig {
  prompt_text: string;
  var_key: string;
  next_node_key: string;
}

/**
 * Asks the customer to send a file and stores the resulting media URL
 * in `vars[var_key]`.
 *
 * `accept` narrows what counts as an answer — a run waiting for a
 * document should not be satisfied by a sticker. Anything else the
 * customer sends is treated as an unmatched reply and goes through the
 * flow's normal reprompt policy.
 */
export interface AskMediaNodeConfig {
  prompt_text: string;
  var_key: string;
  accept: 'any' | 'image' | 'video' | 'document' | 'audio';
  next_node_key: string;
}

/**
 * Parks the run and continues later.
 *
 * ⚠️ THE DELAY IS NOT A SLEEP. The run is suspended and a delayed job
 * wakes it (`flow_runs.resume_at` is the durable record — see migration
 * 086). Nothing holds a connection open, and the 24-hour messaging
 * window keeps running while it waits, which is why the validator warns
 * when a non-template send sits after a wait of a day or more.
 */
export interface WaitNodeConfig {
  duration: number;
  unit: 'minutes' | 'hours' | 'days';
  next_node_key: string;
}

/**
 * Calls an external endpoint mid-flow and stores the response in
 * `vars[response_var]` as `{ status, body }`, so a later condition can
 * branch on it.
 *
 * ⚠️ THE URL GOES THROUGH `http-guard.ts` — the same SSRF boundary the
 * AI agent's custom actions use. It is author-supplied and therefore
 * reaches our network from inside; the guard is what stops it reaching
 * the metadata service or a private address.
 */
export interface HttpRequestNodeConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** Header name → value. Interpolated. */
  headers?: Record<string, string>;
  /** Raw body, interpolated. Ignored for GET. */
  body?: string;
  /** Key under vars to store `{ status, body }`. */
  response_var: string;
  /**
   * Whether a non-2xx response stops the run. Default false: a status
   * code is often the thing the flow means to branch on, and failing
   * closed would make that impossible to express.
   */
  fail_on_error?: boolean;
  next_node_key: string;
}

/**
 * Hands the customer to ANOTHER flow. The current run ends
 * (`end_reason: 'connected_to_flow'`) and the target starts fresh —
 * they do not nest.
 *
 * ⚠️ Not nesting is the whole design. `idx_one_active_run_per_contact`
 * permits exactly one active run per contact, so a "call and return"
 * would need either two active runs or a stack we do not have. Ending
 * first also makes an accidental A→B→A loop terminate instead of
 * growing.
 */
export interface StartFlowNodeConfig {
  /** flows.id. Validated against the caller's account at run time. */
  flow_id: string;
}

/**
 * Hands the conversation to one of the workspace's AI agents rather
 * than to a human. Terminal, like `handoff`.
 *
 * `agent_id` is optional: unset means "whichever agent normal routing
 * would pick" (`AgentResolverService`), which is the right default
 * because routing order is a deliberate setting and a flow pinning one
 * agent would silently outrank it.
 */
export interface AiHandoffNodeConfig {
  agent_id?: string;
  /** Written to the run's event log, and to the agent as context. */
  note?: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/** Total union — every concrete node_type the v1 engine understands. */
export type FlowNodeConfig =
  | { node_type: 'start'; config: StartNodeConfig }
  | { node_type: 'send_message'; config: SendMessageNodeConfig }
  | { node_type: 'send_buttons'; config: SendButtonsNodeConfig }
  | { node_type: 'send_list'; config: SendListNodeConfig }
  | { node_type: 'send_media'; config: SendMediaNodeConfig }
  | { node_type: 'collect_input'; config: CollectInputNodeConfig }
  | { node_type: 'condition'; config: ConditionNodeConfig }
  | { node_type: 'set_tag'; config: SetTagNodeConfig }
  | { node_type: 'set_segment'; config: SetSegmentNodeConfig }
  | { node_type: 'set_attribute'; config: SetAttributeNodeConfig }
  | { node_type: 'send_template'; config: SendTemplateNodeConfig }
  | { node_type: 'send_products'; config: SendProductsNodeConfig }
  | { node_type: 'ask_location'; config: AskLocationNodeConfig }
  | { node_type: 'ask_media'; config: AskMediaNodeConfig }
  | { node_type: 'wait'; config: WaitNodeConfig }
  | { node_type: 'http_request'; config: HttpRequestNodeConfig }
  | { node_type: 'start_flow'; config: StartFlowNodeConfig }
  | { node_type: 'handoff'; config: HandoffNodeConfig }
  | { node_type: 'ai_handoff'; config: AiHandoffNodeConfig }
  | { node_type: 'end'; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig['node_type'];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  match_type?: 'exact' | 'contains';
  case_sensitive?: boolean;
}

// No knobs in v1 — the trigger has a single semantic.
export type FirstInboundTriggerConfig = Record<string, never>;

export type FlowTriggerType = 'keyword' | 'first_inbound_message' | 'manual';

export type FlowStatus = 'draft' | 'active' | 'archived';

export type FlowRunStatus =
  | 'active'
  | 'completed'
  | 'handed_off'
  | 'timed_out'
  | 'paused_by_agent'
  | 'failed';

export type FlowRunEventType =
  | 'started'
  | 'node_entered'
  | 'message_sent'
  | 'reply_received'
  | 'fallback_fired'
  | 'handoff'
  | 'timeout'
  | 'error'
  | 'completed';

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: 'reprompt' | 'handoff' | 'ignore';
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: 'handoff' | 'end';
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: 'reprompt',
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: 'handoff',
};

// ============================================================
// Engine input — what the dispatch service accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: 'text';
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
    }
  | {
      kind: 'interactive_reply';
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
    }
  | {
      /**
       * The customer shared their location — the answer to an
       * `ask_location` node. NOT an interactive reply: Meta delivers a
       * `location` message, so the engine matches it by KIND rather
       * than by a reply id.
       */
      kind: 'location';
      latitude: number;
      longitude: number;
      name?: string | null;
      address?: string | null;
      meta_message_id: string;
    }
  | {
      /**
       * The customer sent a file — the answer to an `ask_media` node.
       * `media_url` is our own proxy path, not Meta's short-lived one,
       * so a value stored in `vars` is still fetchable tomorrow.
       */
      kind: 'media';
      media_kind: 'image' | 'video' | 'document' | 'audio' | 'sticker';
      media_url: string | null;
      caption?: string | null;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
  isFirstInboundMessage: boolean;
  /** Channel of the conversation triggering the dispatch (e.g. 'whatsapp', 'instagram'). */
  channel?: string;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — absent when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | 'advanced'
    | 'started'
    | 'completed'
    | 'handed_off'
    | 'fallback_fired'
    | 'duplicate_inbound_ignored'
    | 'no_match';
}

// ============================================================
// Wire JSON shapes — the exact snake_case payloads the dashboard
// frontend already consumes from the old Next.js routes.
// ============================================================

export interface FlowJson {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  trigger_type: FlowTriggerType;
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeJson {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunJson {
  id: string;
  status: FlowRunStatus;
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

export interface FlowRunEventJson {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
