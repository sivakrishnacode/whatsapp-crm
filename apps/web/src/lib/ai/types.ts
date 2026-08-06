// ============================================================
// Shared types for the AI agent (bring-your-own-key).
//
// The runtime lives in apps/api (src/ai). What remains here is the small
// surface the web app itself needs: the provider union the settings form
// renders, and the error shape the inbox draft button branches on.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'gemini'

/** Providers that can also produce knowledge-base embeddings. */
export type EmbeddingsProvider = 'openai' | 'gemini'

/** A single conversation turn in the shape every provider accepts. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response; `code` lets the UI branch (invalid_key vs rate_limited
 * vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
