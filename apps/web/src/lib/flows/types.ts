/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
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
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: 'image' | 'video' | 'document';
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
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
 * the config for forward compat but ignored by the runner); the
 * builder still surfaces the field so users can author flows that
 * v2 will start enforcing.
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Reserved for v2. Accepted on the config but ignored by the v1.5
   * runner — captures any non-empty text.
   */
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
 * Put the contact into (or take them out of) a saved audience —
 * migration 076's `contact_segments`. Separate from set_tag because a
 * tag describes the person and a segment is a list a broadcast can be
 * aimed at. Static segments only.
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

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: 'start'; config: StartNodeConfig }
  | { node_type: 'send_message'; config: SendMessageNodeConfig }
  | { node_type: 'send_buttons'; config: SendButtonsNodeConfig }
  | { node_type: 'send_list'; config: SendListNodeConfig }
  | { node_type: 'send_media'; config: SendMediaNodeConfig }
  | { node_type: 'send_template'; config: SendTemplateNodeConfig }
  | { node_type: 'send_products'; config: SendProductsNodeConfig }
  | { node_type: 'collect_input'; config: CollectInputNodeConfig }
  | { node_type: 'ask_location'; config: AskLocationNodeConfig }
  | { node_type: 'ask_media'; config: AskMediaNodeConfig }
  | { node_type: 'condition'; config: ConditionNodeConfig }
  | { node_type: 'wait'; config: WaitNodeConfig }
  | { node_type: 'set_tag'; config: SetTagNodeConfig }
  | { node_type: 'set_segment'; config: SetSegmentNodeConfig }
  | { node_type: 'set_attribute'; config: SetAttributeNodeConfig }
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

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: 'keyword'; config: KeywordTriggerConfig }
  | { trigger_type: 'first_inbound_message'; config: FirstInboundTriggerConfig }
  | { trigger_type: 'manual'; config: Record<string, never> };

// ============================================================
// DB-row shapes (read by the engine via supabaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config:
    KeywordTriggerConfig | FirstInboundTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | 'active'
    | 'completed'
    | 'handed_off'
    | 'timed_out'
    | 'paused_by_agent'
    | 'failed';
  current_node_key: string | null;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

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
// Engine input — what `dispatchInboundToFlows` accepts
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
       * `media_url` is our own proxy path, not Meta"s short-lived one,
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
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
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
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
