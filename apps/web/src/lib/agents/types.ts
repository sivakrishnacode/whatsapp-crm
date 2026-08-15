// ============================================================
// Client-side types for the Agent Studio.
//
// These mirror what `GET /api/ai/agent` returns (snake_case, straight
// from the API) rather than a prettified client model. One shape, no
// mapping layer: a rename on the server shows up here as a type error
// instead of a silently undefined field in a form.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'gemini'
export type EmbeddingsProvider = 'openai' | 'gemini'
export type AgentTone = 'friendly' | 'professional' | 'concise' | 'playful'
export type ResponseLength = 'short' | 'medium' | 'long'

/** Document ingest states — see migration 069. */
export type KnowledgeStatus = 'ready' | 'indexing' | 'lexical' | 'failed' | 'stale'

export interface SkillConfigField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'url' | 'list'
  placeholder: string | null
  help: string | null
  max_items: number | null
}

export interface SkillDefinition {
  id: string
  label: string
  description: string
  default_enabled: boolean
  tools: string[]
  config: SkillConfigField[]
}

export interface SkillState {
  enabled: boolean
  config: Record<string, unknown>
}

/** A conversation channel an agent can be scoped to. */
export type AgentChannel = 'whatsapp' | 'instagram' | 'web'

/** Everything an agent row on the list needs. */
export interface AgentSummary {
  id: string
  name: string
  channels: AgentChannel[]
  priority: number
  is_active: boolean
  auto_reply_enabled: boolean
  test_mode: boolean
  test_numbers: string[]
  agent_name: string | null
  model: string | null
  /** What it will actually run on, resolved as the runtime resolves it. */
  resolved_provider: string
  /** Null while the workspace is on platform credits — the model is ours. */
  resolved_model: string | null
  business_description: string | null
  uses_all_knowledge: boolean
  uses_all_actions: boolean
  updated_at: string
  stats: { replies: number; conversations: number; handoffs: number }
}

export interface AgentTemplateSummary {
  id: string
  label: string
  description: string
  /** Lucide icon name; mapped to a component in the create dialog. */
  icon: string
  name: string
  skills: string[]
}

export interface AgentListResponse {
  agents: AgentSummary[]
  stats_window_days: number
  workspace: {
    configured: boolean
    has_key: boolean
    provider: AiProvider | null
    model: string | null
    credit_mode: 'platform' | 'byok'
  }
  limit: {
    used: number
    /** Null is unlimited, exactly as the plans table encodes it. */
    max: number | null
    reached: boolean
    standing: 'good' | 'grace' | 'lapsed'
  }
  templates: AgentTemplateSummary[]
  channels: AgentChannel[]
}

export interface AgentStudio {
  /** Whether the WORKSPACE has somewhere to send requests. */
  configured: boolean
  has_key?: boolean
  has_embeddings_key?: boolean
  credit_mode?: 'platform' | 'byok'
  provider?: AiProvider | null
  /** The workspace default this agent falls back to. */
  workspace_model?: string | null
  /** False on platform credits: the model is ours to choose, not theirs. */
  model_editable?: boolean
  id: string
  name: string
  channels: AgentChannel[]
  priority: number
  model?: string | null
  is_active?: boolean
  auto_reply_enabled?: boolean
  auto_reply_max_per_conversation?: number
  embeddings_provider?: EmbeddingsProvider | null
  embeddings_model?: string | null
  system_prompt?: string | null
  agent_name?: string | null
  greeting_message?: string | null
  business_website?: string | null
  business_description?: string | null
  ground_rules?: string | null
  store_currency?: string | null
  tone?: AgentTone
  response_length?: ResponseLength
  tone_instructions?: string | null
  fallback_message?: string | null
  handoff_enabled?: boolean
  handoff_trigger_phrases?: string[]
  handoff_message?: string | null
  skills?: Record<string, SkillState>
  test_mode?: boolean
  test_numbers?: string[]
  uses_all_knowledge: boolean
  uses_all_actions: boolean
  knowledge_document_ids: string[]
  action_ids: string[]
  updated_at?: string
  skills_registry: SkillDefinition[]
  knowledge: {
    total: number
    by_status: Partial<Record<KnowledgeStatus, number>>
    needs_reindex: number
    /** How many of the library this agent actually reads. */
    selected: number
  }
  actions_count: number
  defaults: Record<AiProvider, string>
}

export interface KnowledgeDocument {
  id: string
  title: string
  source_type: 'text' | 'url' | 'file'
  source_url: string | null
  file_name: string | null
  byte_size: number | null
  status: KnowledgeStatus
  error: string | null
  chunk_count: number
  indexed_at: string | null
  updated_at: string
}

export interface KnowledgeList {
  documents: KnowledgeDocument[]
  semantic: {
    enabled: boolean
    provider: EmbeddingsProvider | null
    model: string | null
  }
  limits: { max_upload_bytes: number }
}

export type ActionParamLocation = 'query' | 'body' | 'path'

export interface ActionParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  required: boolean
  in: ActionParamLocation
}

export interface AgentAction {
  id: string
  name: string
  intent: string | null
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  parameters: ActionParameter[]
  enabled: boolean
  timeout_ms: number
  /** Header NAMES only — values never leave the server. */
  header_names: string[]
  last_used_at: string | null
  last_status: number | null
  last_error: string | null
  updated_at: string
}

/** One tool the agent ran during a playground turn. */
export interface ToolTraceEntry {
  name: string
  arguments: Record<string, unknown>
  ok: boolean
  detail: string
  durationMs: number
}

export interface PlaygroundResponse {
  reply: string
  handoff: boolean
  grounded_on: Array<{
    document_id: string
    title: string | null
    excerpt: string
  }>
  tools_available: string[]
  tool_calls: ToolTraceEntry[]
}

export const TONE_LABELS: Record<AgentTone, { label: string; hint: string }> = {
  friendly: { label: 'Friendly', hint: 'Warm, upbeat, uses their name' },
  professional: { label: 'Professional', hint: 'Polished, no slang or emoji' },
  concise: { label: 'Concise', hint: 'Answer first, no pleasantries' },
  playful: { label: 'Playful', hint: 'Light, one emoji at most' },
}

export const LENGTH_LABELS: Record<ResponseLength, { label: string; hint: string }> = {
  short: { label: 'Short', hint: 'One or two sentences' },
  medium: { label: 'Medium', hint: 'Two to four sentences' },
  long: { label: 'Long', hint: 'As long as the question needs' },
}

export const KNOWLEDGE_STATUS_LABELS: Record<
  KnowledgeStatus,
  { label: string; tone: 'ok' | 'warn' | 'bad'; hint: string }
> = {
  ready: {
    label: 'Ready',
    tone: 'ok',
    hint: 'Indexed for meaning-based and keyword search.',
  },
  indexing: {
    label: 'Indexing',
    tone: 'warn',
    hint: 'Still being processed — reload in a moment.',
  },
  lexical: {
    label: 'Keyword only',
    tone: 'warn',
    hint: 'Found by keyword search, but not by meaning. Add or fix an embeddings key, then reindex.',
  },
  stale: {
    label: 'Needs reindex',
    tone: 'warn',
    hint: 'Indexed with a different embeddings model than this workspace now uses.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    hint: 'Nothing usable was indexed — the agent cannot see this document.',
  },
}
