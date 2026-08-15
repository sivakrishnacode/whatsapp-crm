export type AiProvider = 'openai' | 'anthropic' | 'gemini';

/** Providers that can produce 1536-dim embeddings for the knowledge base. */
export type EmbeddingsProvider = 'openai' | 'gemini';

export type AgentTone = 'friendly' | 'professional' | 'concise' | 'playful';
export type ResponseLength = 'short' | 'medium' | 'long';

/**
 * The business the agent speaks for. Split into fields rather than one
 * textarea so the prompt builder can order them deliberately and the UI
 * can redraft one (e.g. from the website) without touching the rest.
 */
export interface AgentProfile {
  agentName: string | null;
  greetingMessage: string | null;
  businessWebsite: string | null;
  businessDescription: string | null;
  groundRules: string | null;
  storeCurrency: string | null;
}

export interface AgentVoice {
  tone: AgentTone;
  responseLength: ResponseLength;
  toneInstructions: string | null;
}

/** What the agent does when it runs out of road. */
export interface AgentEscalation {
  fallbackMessage: string | null;
  handoffEnabled: boolean;
  /** Lowercased customer phrases that force a handoff without asking the model. */
  handoffTriggerPhrases: string[];
  handoffMessage: string | null;
}

export interface AgentSkillState {
  enabled: boolean;
  config: Record<string, unknown>;
}

/** `{ [skillId]: state }` — see `lib/skills.ts` for the registry. */
export type AgentSkills = Record<string, AgentSkillState>;

/**
 * Whose provider key a run is about to spend.
 *
 * `platform` — our Gemini key. We pay the provider, so the run is
 *   metered against the workspace's credit wallet.
 * `byok` — the workspace's own key. They pay the provider directly, so
 *   nothing is metered and no quota applies (the original 069 design).
 */
export type AiCreditMode = 'platform' | 'byok';

export interface AiConfig {
  /**
   * Which agent this config IS (migration 084). Null only for the
   * implicit default a workspace gets before it has created one — see
   * `platformOnlyConfig` in lib/config.ts.
   */
  agentId: string | null;
  /** The agent's list name ("Sales"), for logs and attribution. */
  agentLabel: string | null;
  /** Documents this agent may read; null means the whole library. */
  knowledgeDocumentIds: string[] | null;
  /** Actions this agent may call; null means all of them. */
  actionIds: string[] | null;
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Which key `apiKey` actually is. Decides whether to charge credits. */
  source: AiCreditMode;
  /** What the workspace chose, before any fallback. For the UI's benefit. */
  creditMode: AiCreditMode;
  /** Wallet balance at load time. Only meaningful when source is platform. */
  creditBalance: number;
  /** Pre-069 free-text business context. Appended after the profile. */
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  embeddingsApiKey: string | null;
  embeddingsProvider: EmbeddingsProvider | null;
  /** Model that produced the stored vectors; retrieval filters on it. */
  embeddingsModel: string | null;
  profile: AgentProfile;
  voice: AgentVoice;
  escalation: AgentEscalation;
  skills: AgentSkills;
  /** When true the auto-reply bot answers only `testNumbers`. */
  testMode: boolean;
  testNumbers: string[];
}

/**
 * A conversation turn. `tool` turns carry the result of a tool the model
 * asked for on the previous assistant turn; they are what makes a
 * multi-round tool call work without the provider losing the thread.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant turns that requested tools */
  toolCalls?: ToolCall[];
  /** tool turns: which call this answers */
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque provider state that must be echoed back with the call on the
   * follow-up request. Gemini's thinking models return a
   * `thoughtSignature` here and lose their reasoning (or reject the
   * turn) if it does not come back. Meaningless to the other providers,
   * which ignore it.
   */
  signature?: string;
}

/** A tool the model may call, in the one shape every provider adapter maps from. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Where a knowledge excerpt came from, so a reply can cite it. */
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  content: string;
  title?: string;
}

export interface ToolTraceEntry {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** Trimmed result or error, for the test panel — never shown to customers. */
  detail: string;
  durationMs: number;
}

export interface GenerateResult {
  text: string;
  handoff: boolean;
  /** Populated when the run executed tools; empty otherwise. */
  toolTrace: ToolTraceEntry[];
  /**
   * Tokens across EVERY provider round this run made, not just the last.
   * A tool loop is several billable calls and each one re-sends the whole
   * transcript, so the final round alone understates the cost several
   * times over. This is what the credit charge is computed from.
   */
  usage: { inputTokens: number; outputTokens: number; rounds: number };
}

export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
